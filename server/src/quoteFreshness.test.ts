import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { HistoryCache } from "./history/cache.js";
import { createMockProvider } from "./providers/mock.js";
import { ProviderRouter } from "./providers/router.js";
import { registerResearchRoutes } from "./research/routes.js";

afterEach(() => vi.restoreAllMocks());

describe("quote endpoint recovery freshness", () => {
  it("refreshes single, batch, and tape snapshots within the five-second recovery interval", async () => {
    let clock = Date.parse("2026-10-26T14:30:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const source = createMockProvider(() => clock);
    const quotes = source.quotes!;
    let last = 100;
    source.quotes = async (securities) => (await quotes(securities)).map((q) => ({ ...q, last }));
    const router = new ProviderRouter([source], () => {});
    const history = new HistoryCache(":memory:", (s, i, from, to) => router.history(s, i, from, to));
    const server = createApp({ router, history, routes: [(app) => registerResearchRoutes(app, router)] }).listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const endpoints = ["/api/quote/AAPL%20US%20Equity", "/api/quotes?s=AAPL%20US%20Equity", "/api/indices"];
    try {
      for (const endpoint of endpoints) {
        const res = await fetch(base + endpoint);
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(Array.isArray(data) ? data[0].last : data.last).toBe(100);
      }
      clock += 5_000;
      last = 101;
      for (const endpoint of endpoints) {
        const res = await fetch(base + endpoint);
        const data = await res.json();
        expect(Array.isArray(data) ? data[0].last : data.last).toBe(101);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      history.close();
    }
  });
});
