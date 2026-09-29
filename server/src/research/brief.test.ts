import { describe, expect, it } from "vitest";
import { AlertService } from "../alerts/alerts.js";
import { HistoryCache } from "../history/cache.js";
import { PortfolioService } from "../portfolio/service.js";
import { PortfolioStore, validatePortfolio } from "../portfolio/store.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { buildBrief } from "./brief.js";

describe("buildBrief (mock)", () => {
  it("assembles markets, movers, portfolios, rates, alerts and headlines", async () => {
    const t = Date.UTC(2026, 8, 25, 15);
    const router = new ProviderRouter([createMockProvider(() => t)], () => {});
    const history = new HistoryCache(":memory:", (s, i, f, to) => router.history(s, i, f, to), () => t);
    const portfolios = new PortfolioStore(":memory:");
    portfolios.create("ALICE", validatePortfolio({ name: "Core", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 10 }, { security: "MSFT US Equity", quantity: 5 }] }));
    const alerts = new AlertService(":memory:", router, history, () => {}, () => t);
    alerts.create("ALICE", { security: "SPX Index", kind: "above", value: 1 });
    await alerts.evaluate();

    const b = await buildBrief({ router, portfolios, portfolioService: new PortfolioService(router, history, () => t), alerts, now: () => t }, "ALICE");
    expect(b.markets.length).toBeGreaterThan(10);
    expect(b.gainers.length).toBeLessThanOrEqual(5);
    expect(b.portfolios).toHaveLength(1);
    expect(b.portfolios[0]).toMatchObject({ name: "Core", baseCurrency: "USD" });
    expect(b.portfolios[0].marketValue).toBeGreaterThan(0);
    expect(b.nextFomc).not.toBeNull();
    expect(b.curve!.spreadBp).toEqual(expect.any(Number));
    expect(b.alerts).toMatchObject({ active: 0, triggeredToday: [{ security: "SPX Index" }] });
    expect(b.headlines.length).toBeLessThanOrEqual(8);

    const anonymous = await buildBrief({ router, portfolios, portfolioService: new PortfolioService(router, history, () => t), alerts, now: () => t }, null);
    expect(anonymous.portfolios).toEqual([]);
    expect(anonymous.alerts).toEqual({ active: 0, triggeredToday: [] });
    alerts.close?.();
  });
});
