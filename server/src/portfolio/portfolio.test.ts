import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { HistoryCache } from "../history/cache.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { registerPortfolioRoutes } from "./routes.js";
import { PortfolioService } from "./service.js";
import { PortfolioStore, ValidationError, validatePortfolio } from "./store.js";

describe("validatePortfolio", () => {
  it("normalizes securities and numbers", () => {
    const p = validatePortfolio({
      name: " Core ",
      kind: "positions",
      holdings: [{ security: "aapl us equity", quantity: "1,000", cost: "$150.25", acquired: "2024-01-02" }],
    });
    expect(p).toEqual({
      name: "Core",
      kind: "positions",
      baseCurrency: "USD",
      notional: null,
      holdings: [{ security: "AAPL US Equity", quantity: 1000, weight: null, cost: 150.25, acquired: "2024-01-02" }],
    });
  });

  it("defaults the model notional and requires weights", () => {
    expect(validatePortfolio({ name: "M", kind: "model", holdings: [{ security: "SPX Index", weight: 100 }] }).notional).toBe(1_000_000);
    expect(() => validatePortfolio({ name: "M", kind: "model", holdings: [{ security: "SPX Index" }] })).toThrow(/weight/);
  });

  it.each([
    [{ name: "", kind: "positions", holdings: [] }, /Name/],
    [{ name: "x", kind: "bogus", holdings: [] }, /kind/],
    [{ name: "x", kind: "positions", baseCurrency: "DOLLAR", holdings: [] }, /currency/],
    [{ name: "x", kind: "positions", holdings: [{ security: "AAPL", quantity: 1 }] }, /not a security/],
    [{ name: "x", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 0 }] }, /non-zero/],
    [{ name: "x", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: "ten" }] }, /numbers only/],
    [{ name: "x", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 1, acquired: "01/02/2024" }] }, /YYYY-MM-DD/],
  ])("rejects invalid input %#", (raw, message) => {
    expect(() => validatePortfolio(raw)).toThrow(ValidationError);
    expect(() => validatePortfolio(raw)).toThrow(message);
  });
});

describe("PortfolioStore", () => {
  it("creates, lists, updates and deletes per user", () => {
    let t = 1;
    const store = new PortfolioStore(":memory:", () => t++);
    const input = validatePortfolio({ name: "Core", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 10 }] });
    const p = store.create("ALICE", input);
    expect(store.list("ALICE")).toEqual([{ id: p.id, name: "Core", kind: "positions", baseCurrency: "USD", count: 1, updated: 1 }]);
    expect(store.list("BOB")).toEqual([]);
    expect(store.get("BOB", p.id)).toBeNull();
    expect(() => store.create("ALICE", input)).toThrow(/already exists/);

    const updated = store.update("ALICE", p.id, { ...input, holdings: [...input.holdings, { ...input.holdings[0], security: "MSFT US Equity" }] })!;
    expect(updated.holdings.map((h) => h.security)).toEqual(["AAPL US Equity", "MSFT US Equity"]);
    expect(store.findByName("ALICE", "core")?.id).toBe(p.id);
    expect(store.remove("BOB", p.id)).toBe(false);
    expect(store.remove("ALICE", p.id)).toBe(true);
    expect(store.list("ALICE")).toEqual([]);
    store.close();
  });
});

const T = Date.UTC(2026, 8, 25, 15, 30);
let server: Server;
let base: string;

beforeAll(async () => {
  const router = new ProviderRouter([createMockProvider(() => T)], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
  const store = new PortfolioStore(":memory:");
  const service = new PortfolioService(router, history, () => T);
  server = createApp({ router, history, now: () => T, routes: [(a) => registerPortfolioRoutes(a, store, service)] }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

describe("portfolio API (mock provider)", () => {
  it("runs the full lifecycle with analytics and what-if", async () => {
    const created = await call("POST", "/api/portfolios", {
      user: "tester",
      name: "Global",
      kind: "positions",
      holdings: [
        { security: "AAPL US Equity", quantity: 100, cost: 200 },
        { security: "VOD LN Equity", quantity: 5000, cost: 80 },
        { security: "SAP GY Equity", quantity: 50 },
      ],
    });
    expect(created.status).toBe(201);
    const id = created.body.id;

    const list = await call("GET", "/api/portfolios?user=TESTER");
    expect(list.body.map((p: { name: string }) => p.name)).toEqual(["Global"]);

    const a = await call("GET", `/api/portfolios/${id}/analytics?user=tester&range=6mo&benchmark=SPX%20Index`);
    expect(a.status).toBe(200);
    expect(a.body.holdings.every((h: { error: string | null }) => h.error === null)).toBe(true);
    const vod = a.body.holdings.find((h: { security: string }) => h.security === "VOD LN Equity");
    expect(vod.priceScale).toBe(0.01);
    expect(vod.currency).toBe("GBP");
    expect(a.body.performance.points.length).toBeGreaterThan(100);
    expect(a.body.risk.volatilityPct).toBeGreaterThan(0);
    expect(a.body.risk.riskFreePct).toBe(4.24);
    expect(a.body.exposures.country.map((c: { key: string }) => c.key).sort()).toEqual(["Germany", "United Kingdom", "United States"]);
    const weightSum = a.body.holdings.reduce((s: number, h: { weightPct: number }) => s + h.weightPct, 0);
    expect(weightSum).toBeCloseTo(100, 6);

    const w = await call("POST", `/api/portfolios/${id}/whatif`, {
      user: "tester",
      range: "3mo",
      holdings: [{ security: "AAPL US Equity", quantity: 200 }],
    });
    expect(w.status).toBe(200);
    expect(w.body.current.holdings).toHaveLength(3);
    expect(w.body.proposed.holdings).toHaveLength(1);
    expect(w.body.proposed.totals.marketValue).toBeGreaterThan(w.body.current.holdings[0].marketValue);

    const upd = await call("PUT", `/api/portfolios/${id}`, { user: "tester", name: "Global 2", kind: "positions", holdings: [{ security: "IBM US Equity", quantity: 1 }] });
    expect(upd.body.name).toBe("Global 2");
    expect((await call("DELETE", `/api/portfolios/${id}?user=tester`)).status).toBe(204);
    expect((await call("GET", `/api/portfolios/${id}?user=tester`)).status).toBe(404);
  });

  it("analyzes an unsaved model portfolio in another base currency", async () => {
    const r = await call("POST", "/api/portfolios/analytics", {
      range: "1y",
      benchmark: "SX5E Index",
      portfolio: {
        name: "Draft",
        kind: "model",
        baseCurrency: "EUR",
        notional: 500000,
        holdings: [
          { security: "AAPL US Equity", weight: 50 },
          { security: "SAP GY Equity", weight: 50 },
        ],
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.totals.marketValue).toBeCloseTo(500000, 2);
    expect(r.body.benchmark).toBe("SX5E Index");
  });

  it("validates requests", async () => {
    expect((await call("GET", "/api/portfolios")).status).toBe(400);
    expect((await call("POST", "/api/portfolios", { user: "tester", name: "Bad", kind: "positions", holdings: [{ security: "nope", quantity: 1 }] })).body.error).toMatch(/not a security/);
    expect((await call("GET", "/api/portfolios/999/analytics?user=tester")).status).toBe(404);
    expect((await call("POST", "/api/portfolios/analytics", { range: "7y", portfolio: {} })).status).toBe(400);
    const res = await fetch(`${base}/api/portfolios`, { method: "POST", headers: { "content-type": "application/json" }, body: "{bad" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "INVALID JSON" });
  });
});
