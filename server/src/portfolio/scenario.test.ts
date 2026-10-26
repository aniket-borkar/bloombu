import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioAnalytics, PortfolioHolding, Quote } from "../types.js";
import { analyzePortfolio } from "./analytics.js";
import { analyzeScenario, registerScenarioRoutes, validateScenario } from "./scenario.js";
import type { PortfolioService } from "./service.js";
import { PortfolioStore, ValidationError, validatePortfolio } from "./store.js";

const A = "AAPL US Equity";
const V = "VOD LN Equity";
const holding = (security: string, quantity: number): PortfolioHolding => ({ security, quantity, weight: null, cost: null, acquired: null });
const quote = (security: string, last: number, currency: string) => ({ security, last, currency, name: security, prevClose: last } as Quote);

function baseline(): PortfolioAnalytics {
  return analyzePortfolio({
    name: "Global", kind: "positions", baseCurrency: "USD", notional: null,
    holdings: [holding(A, 1), holding(A, 9), holding(V, -2000)],
    quotes: new Map([[A, quote(A, 100, "USD")], [V, quote(V, 20, "GBp")]]),
    bars: new Map(), usdPer: new Map([["GBP", { now: 1, bars: [] }]]),
    sectors: new Map([[A, "Technology"], [V, "Communication Services"]]),
    benchmark: { security: "SPX Index", bars: [] }, riskFreePct: null, range: "1y", now: Date.UTC(2026, 9, 26),
  });
}

describe("validateScenario", () => {
  it("normalizes names, securities and major currencies with safe defaults", () => {
    expect(validateScenario({
      name: "  Equity  downturn ", sectors: { " technology ": -20 },
      securities: { "aapl us <equity>": -5 }, currencies: { " gbp ": -10 },
    })).toEqual({ name: "Equity downturn", marketPct: 0, sectors: { technology: -20 }, securities: { [A]: -5 }, currencies: { GBP: -10 } });
    expect(validateScenario({ name: "Flat" })).toEqual({ name: "Flat", marketPct: 0, sectors: {}, securities: {}, currencies: {} });
  });

  it.each([
    null, [], "scenario", {}, { name: " " }, { name: "x".repeat(61) },
    { name: "Bad", marketPct: "10" }, { name: "Bad", marketPct: NaN },
    { name: "Bad", marketPct: Infinity }, { name: "Bad", marketPct: -100.01 },
    { name: "Bad", marketPct: 500.01 }, { name: "Bad", sectors: [] },
    { name: "Bad", sectors: null }, { name: "Bad", sectors: { " ": 10 } },
    { name: "Bad", sectors: { Technology: 10, technology: 20 } },
    { name: "Bad", sectors: { Technology: null } },
    { name: "Bad", securities: { AAPL: -10 } },
    { name: "Bad", securities: { [A]: -5, "aapl us equity": -10 } },
    { name: "Bad", currencies: { GBX: -100 } },
    { name: "Bad", currencies: { DOLLARS: 10 } },
    { name: "Bad", sectors: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`Sector${i}`, 1])) },
    { name: "Bad", securities: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`A${i} US Equity`, 1])) },
  ])("rejects invalid or unbounded scenarios %#", (raw) => {
    expect(() => validateScenario(raw)).toThrow(ValidationError);
  });
});

describe("analyzeScenario", () => {
  it("compounds market, sector, security and FX shocks with exact lot and short attribution", () => {
    const analytics = baseline();
    const before = JSON.stringify(analytics);
    const input = validateScenario({ name: "Downturn", marketPct: -10, sectors: { technology: -20 }, securities: { [A]: -50 }, currencies: { GBP: -10 } });
    const result = analyzeScenario(analytics, input);
    expect(result.assumptions).toEqual(input);
    expect(result.coverage).toEqual({ valuedRows: 3, totalRows: 3 });
    expect(result.currentValue).toBe(600);
    expect(result.grossCurrentValue).toBe(1400);
    expect(result.scenarioValue).toBeCloseTo(36);
    expect(result.pnl).toBeCloseTo(-564);
    expect(result.pnlPct).toBeCloseTo(-94);
    expect(result.positions.map((row) => row.row)).toEqual([0, 1, 2]);
    expect(result.positions[0].scenarioValue).toBeCloseTo(36);
    expect(result.positions[1].scenarioValue).toBeCloseTo(324);
    const short = result.positions[2];
    expect(short).toMatchObject({ currency: "GBP", currentValue: -400, quantity: -2000 });
    expect(short.scenarioValue).toBeCloseTo(-324);
    expect(short.pnl).toBeCloseTo(76);
    expect(short.pnlPct).toBeCloseTo(19);
    expect(short.priceEffect).toBeCloseTo(40);
    expect(short.fxEffect).toBeCloseTo(40);
    expect(short.interaction).toBeCloseTo(-4);
    for (const row of result.positions) expect(row.priceEffect! + row.fxEffect! + row.interaction!).toBeCloseTo(row.pnl!);
    for (const groups of [result.bySector, result.byCurrency]) {
      expect(groups.reduce((sum, group) => sum + group.currentValue, 0)).toBeCloseTo(result.currentValue);
      expect(groups.reduce((sum, group) => sum + group.scenarioValue, 0)).toBeCloseTo(result.scenarioValue);
      expect(groups.reduce((sum, group) => sum + group.pnl, 0)).toBeCloseTo(result.pnl);
    }
    expect(JSON.stringify(analytics)).toBe(before);
    expect(result.warnings.join(" ")).toMatch(/Derivatives are not repriced/);
  });

  it("preserves a no-shock valuation and gives a full price loss at -100 percent", () => {
    const flat = analyzeScenario(baseline(), validateScenario({ name: "Flat" }));
    expect(flat.currentValue).toBe(flat.scenarioValue);
    expect(flat.pnl).toBe(0);
    const zero = analyzeScenario(baseline(), validateScenario({ name: "Zero", marketPct: -100 }));
    expect(zero.scenarioValue).toBe(0);
    expect(zero.pnlPct).toBe(-100);
  });

  it("uses generated model quantities and handles a foreign base currency", () => {
    const analytics = baseline();
    analytics.kind = "model";
    analytics.baseCurrency = "EUR";
    analytics.holdings = [{ ...analytics.holdings[0], quantity: 25, marketValue: 2000, fxToBase: 0.8 }];
    const result = analyzeScenario(analytics, validateScenario({ name: "FX", currencies: { USD: 10 } }));
    expect(result.positions[0].quantity).toBe(25);
    expect(result.scenarioValue).toBeCloseTo(2200);
    expect(result.pnlPct).toBeCloseTo(10);
  });

  it("rejects any shock to the base numeraire", () => {
    expect(() => analyzeScenario(baseline(), validateScenario({ name: "Bad", currencies: { usd: 0 } }))).toThrow(/Cannot shock base currency USD/);
  });

  it("retains missing rows as null and labels totals as partial coverage", () => {
    const analytics = baseline();
    analytics.holdings[2] = { ...analytics.holdings[2], marketValue: null, error: "NO FX RATE GBP/USD" };
    const result = analyzeScenario(analytics, validateScenario({ name: "Partial", marketPct: -10 }));
    expect(result.coverage).toEqual({ valuedRows: 2, totalRows: 3 });
    expect(result.currentValue).toBe(1000);
    expect(result.scenarioValue).toBe(900);
    expect(result.positions[2]).toMatchObject({ currentValue: null, scenarioValue: null, pnl: null, error: "NO FX RATE GBP/USD" });
    expect(result.byCurrency.map((group) => group.key)).toEqual(["USD"]);
    expect(result.warnings.join(" ")).toMatch(/Partial coverage: 2 of 3/);
  });

  it("warns about unmatched assumptions and avoids percentages for nonpositive net value", () => {
    const analytics = baseline();
    analytics.holdings = [analytics.holdings[2]];
    const result = analyzeScenario(analytics, validateScenario({ name: "Short", sectors: { Energy: -20 }, securities: { "MSFT US Equity": -10 }, currencies: { JPY: -5 } }));
    expect(result.currentValue).toBe(-400);
    expect(result.pnlPct).toBeNull();
    expect(result.warnings.filter((warning) => warning.includes("matches no holding"))).toHaveLength(3);
  });

  it("handles complete missing coverage without fabricating priced rows", () => {
    const analytics = baseline();
    analytics.holdings = [{ ...analytics.holdings[0], marketValue: null, error: "NO QUOTE" }];
    const result = analyzeScenario(analytics, validateScenario({ name: "Unavailable" }));
    expect(result.coverage).toEqual({ valuedRows: 0, totalRows: 1 });
    expect(result.pnlPct).toBeNull();
    expect(result.bySector).toEqual([]);
    expect(result.positions[0].scenarioValue).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/Partial coverage/);
  });

  it("returns a missing percentage instead of infinity for an almost neutral portfolio", () => {
    const analytics = baseline();
    analytics.holdings = [
      { ...analytics.holdings[0], marketValue: 1e307 },
      { ...analytics.holdings[2], marketValue: -1e307 },
      { ...analytics.holdings[0], security: "MSFT US Equity", marketValue: 1e-300 },
    ];
    const result = analyzeScenario(analytics, validateScenario({ name: "Neutral", securities: { [A]: 100 } }));
    expect(result.pnl).toBeCloseTo(1e307);
    expect(result.pnlPct).toBeNull();
    expect(JSON.parse(JSON.stringify(result)).pnl).toBe(result.pnl);
  });
});

describe("scenario API ownership and validation", () => {
  const store = new PortfolioStore(":memory:");
  const portfolio = store.create("ALICE", validatePortfolio({ name: "Global", kind: "positions", holdings: [{ security: A, quantity: 10 }] }));
  const analyze = vi.fn(async () => baseline());
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerScenarioRoutes(app, store, { analyze } as unknown as PortfolioService);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => analyze.mockClear());
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); });
  const call = async (id: number | string, body: unknown) => {
    const response = await fetch(`${base}/api/portfolios/${id}/scenario`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  it("loads the owner's portfolio once and returns the scenario without an envelope", async () => {
    const response = await call(portfolio.id, { user: "alice", name: "Drawdown", marketPct: -10 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: "Drawdown", portfolio: "Global", assumptions: { marketPct: -10 }, coverage: { valuedRows: 3, totalRows: 3 } });
    expect(analyze).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: portfolio.id, user: "ALICE" }), "1y", "SPX Index");
    expect(store.get("ALICE", portfolio.id)).toEqual(portfolio);
  });

  it.each([
    ["missing user", () => portfolio.id, { name: "Bad" }, 400],
    ["invalid ID", () => "nonsense", { user: "alice", name: "Bad" }, 404],
    ["missing portfolio", () => 99999, { user: "alice", name: "Bad" }, 404],
    ["another owner", () => portfolio.id, { user: "bob", name: "Bad" }, 404],
    ["invalid shock", () => portfolio.id, { user: "alice", name: "Bad", marketPct: -101 }, 400],
    ["base FX", () => portfolio.id, { user: "alice", name: "Bad", currencies: { USD: -10 } }, 400],
  ])("rejects %s before provider I/O", async (_label, id, body, status) => {
    expect((await call(id(), body)).status).toBe(status);
    expect(analyze).not.toHaveBeenCalled();
  });
});
