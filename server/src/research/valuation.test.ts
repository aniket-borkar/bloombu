import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { HistoryCache } from "../history/cache.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { calculateValuation, registerValuationRoutes, validateValuation, valuationContext, type ValuationInput } from "./valuation.js";

const earnings: ValuationInput = { method: "earnings", security: "AAPL US Equity", currency: "USD", currentPrice: 80, eps: 5, growthPct: 0, years: 5, requiredReturnPct: 0, terminalPE: 20, payoutPct: 0 };
const dcf: ValuationInput = { method: "dcf", security: "AAPL US Equity", currency: "USD", currentPrice: 80, freeCashFlow: 100, growthPct: 0, years: 5, discountRatePct: 10, terminalGrowthPct: 0, netDebt: 200, sharesOutstanding: 10 };
const now = () => Date.UTC(2026, 9, 26);

describe("valuation calculations", () => {
  it("discounts an exit multiple with no growth or dividends", () => {
    const result = calculateValuation(earnings, now);
    expect(result.valuePerShare).toBe(100);
    expect(result.upsidePct).toBe(25);
    expect(result.calculatedAt).toBe("2026-10-26T00:00:00.000Z");
    expect(result.forecast).toHaveLength(5);
    expect(result.assumptions).toEqual(earnings);
  });

  it("discounts each dividend and the exit price using year-end timing", () => {
    const result = calculateValuation({ ...earnings, eps: 10, growthPct: 10, years: 2, requiredReturnPct: 10, terminalPE: 10, payoutPct: 50 });
    expect(result.forecast[0].presentValue).toBeCloseTo(5);
    expect(result.forecast[1].presentValue).toBeCloseTo(5);
    expect(result.terminalPresentValue).toBeCloseTo(100);
    expect(result.valuePerShare).toBeCloseTo(110);
  });

  it("reconciles constant-FCFF enterprise value, net debt, and per-share equity", () => {
    const result = calculateValuation(dcf);
    expect(result.enterpriseValue).toBeCloseTo(1000);
    expect(result.equityValue).toBeCloseTo(800);
    expect(result.valuePerShare).toBeCloseTo(80);
    expect(result.upsidePct).toBeCloseTo(0);
    expect(calculateValuation({ ...dcf, netDebt: -200 }).valuePerShare).toBeCloseTo(120);
  });

  it("uses the following year's cash flow in the Gordon terminal value", () => {
    const result = calculateValuation({ ...dcf, years: 1, growthPct: 10, terminalGrowthPct: 2 });
    expect(result.forecast[0].cashFlow).toBeCloseTo(110);
    expect(result.terminalValue).toBeCloseTo(110 * 1.02 / 0.08);
    expect(result.terminalPresentValue).toBeCloseTo(result.terminalValue / 1.1);
  });

  it("labels invalid sensitivity cells and preserves the central model result", () => {
    const result = calculateValuation({ ...dcf, discountRatePct: 3, terminalGrowthPct: 2 });
    expect(result.sensitivity.values[0].some((v) => v === null)).toBe(true);
    const r = result.sensitivity.rows.indexOf(3);
    const c = result.sensitivity.columns.indexOf(2);
    expect(result.sensitivity.values[r][c]).toBeCloseTo(result.valuePerShare);
    const higherDiscount = result.sensitivity.values[r + 1][c]!;
    expect(higherDiscount).toBeLessThan(result.valuePerShare);
  });

  it("produces increasing earnings values for increasing growth and multiples", () => {
    const result = calculateValuation({ ...earnings, requiredReturnPct: 10, growthPct: 10 });
    const values = result.sensitivity.values as number[][];
    expect(values[1][2]).toBeLessThan(values[2][2]);
    expect(values[2][1]).toBeLessThan(values[2][2]);
    expect(values[2][2]).toBeCloseTo(result.valuePerShare);
  });

  it("preserves input snapshots and reports missing reference prices honestly", () => {
    const input = { ...dcf, currentPrice: null };
    const result = calculateValuation(input);
    input.growthPct = 25;
    expect(result.assumptions.growthPct).toBe(0);
    expect(result.upsidePct).toBeNull();
    expect(result.warnings.join(" ")).toContain("FCFF");
  });

  it("keeps negative-FCFF and residual-equity model limits visible", () => {
    const result = calculateValuation({ ...dcf, freeCashFlow: -100 });
    expect(result.valuePerShare).toBeLessThan(0);
    expect(result.warnings.join(" ")).toContain("turnaround");
    expect(result.warnings.join(" ")).toContain("liability");
  });

  it.each([
    { ...earnings, eps: -1 }, { ...earnings, years: 1.5 }, { ...earnings, years: 0 },
    { ...earnings, growthPct: -100 }, { ...earnings, terminalPE: 0 }, { ...earnings, payoutPct: 101 },
    { ...earnings, requiredReturnPct: Infinity }, { ...earnings, currentPrice: 0 },
    { ...dcf, sharesOutstanding: 0 }, { ...dcf, discountRatePct: 2, terminalGrowthPct: 2 },
    { ...dcf, freeCashFlow: "100" }, { ...dcf, netDebt: NaN }, { ...dcf, security: "SPX Index" },
  ])("rejects invalid or inconsistent assumptions: %j", (input) => {
    expect(() => validateValuation(input)).toThrow();
  });
});

describe("valuation observations", () => {
  it("infers quote-unit-consistent EPS and keeps reference provenance", async () => {
    const provider = createMockProvider(now);
    const quote = await provider.quotes!([earnings.security]);
    const profile = await provider.profile!(earnings.security);
    const result = await valuationContext(new ProviderRouter([provider]), earnings.security);
    expect(result.inferredEps).toBeCloseTo(quote[0].last! / profile!.pe!);
    expect(result.priceAsOf).toBe(quote[0].time);
    expect(result.source).toContain("Mock");
    expect(result.warnings.join(" ")).toContain("not a directly reported");
  });

  it("does not fabricate EPS when price or positive P/E is unavailable", async () => {
    const router = new ProviderRouter([createMockProvider(now)]);
    vi.spyOn(router, "quote").mockResolvedValue(null);
    const result = await valuationContext(router, earnings.security);
    expect(result.price).toBeNull();
    expect(result.inferredEps).toBeNull();
    expect(result.warnings.join(" ")).toContain("No current quote");
  });

  it("keeps negative trailing earnings out of positive-multiple valuation seeds", async () => {
    const provider = createMockProvider(now);
    const original = provider.profile!.bind(provider);
    provider.profile = async (security) => ({ ...(await original(security))!, pe: -12 });
    const result = await valuationContext(new ProviderRouter([provider]), earnings.security);
    expect(result.price).not.toBeNull();
    expect(result.trailingPE).toBeNull();
    expect(result.inferredEps).toBeNull();
  });
});

describe("valuation API", () => {
  const router = new ProviderRouter([createMockProvider(now)], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t));
  const app = createApp({ router, history, routes: [(a) => registerValuationRoutes(a, router)] });
  const server = app.listen(0);
  let base: string;
  beforeAll(async () => {
    if (!server.listening) await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); history.close(); });

  it("serves observations and uses path identity for model calculations", async () => {
    const context = await fetch(`${base}/api/research/valuation/AAPL%20US%20Equity`);
    expect(context.status).toBe(200);
    expect((await context.json()).security).toBe(earnings.security);
    const result = await fetch(`${base}/api/research/valuation/MSFT%20US%20Equity`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(earnings),
    });
    expect(result.status).toBe(200);
    expect((await result.json()).security).toBe("MSFT US Equity");
  });

  it("rejects non-equity paths and invalid requests with useful errors", async () => {
    expect((await fetch(`${base}/api/research/valuation/SPX%20Index`)).status).toBe(400);
    const result = await fetch(`${base}/api/research/valuation/AAPL%20US%20Equity`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...dcf, terminalGrowthPct: 10 }),
    });
    expect(result.status).toBe(400);
    expect((await result.json()).error).toContain("exceed");
  });
});
