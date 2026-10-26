import { describe, expect, it } from "vitest";
import type { Bar, Quote } from "../types.js";
import { analyzePortfolio, maxDrawdown, normalizeCurrency, quantile, type AnalyticsInput } from "./analytics.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);
const bars = (closes: number[], t0 = T0): Bar[] => closes.map((c, i) => ({ t: t0 + i * DAY, o: c, h: c, l: c, c, v: null }));

function quote(security: string, last: number, prevClose: number, currency: string | null = "USD"): Quote {
  return {
    security,
    name: security.split(" ")[0],
    last,
    change: last - prevClose,
    changePct: ((last - prevClose) / prevClose) * 100,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    open: null,
    high: null,
    low: null,
    prevClose,
    volume: null,
    currency,
    exchange: null,
    marketState: null,
    time: null,
    delayMinutes: null,
    source: "test",
  };
}

function input(over: Partial<AnalyticsInput>): AnalyticsInput {
  return {
    name: "Test",
    kind: "positions",
    baseCurrency: "USD",
    notional: null,
    holdings: [],
    quotes: new Map(),
    bars: new Map(),
    usdPer: new Map(),
    sectors: new Map(),
    benchmark: { security: "SPX Index", bars: [] },
    riskFreePct: 4,
    range: "1y",
    now: T0 + 10 * DAY,
    ...over,
  };
}

const A = "AAA US Equity";
const B = "BBB US Equity";

describe("analyzePortfolio: duplicate lots", () => {
  it("matches merged holdings while preserving each lot's valuation and contribution", () => {
    const h = (security: string, quantity: number) => ({ security, quantity, weight: null, cost: null, acquired: null });
    const common = input({
      quotes: new Map([[A, quote(A, 120, 99)], [B, quote(B, 100, 100)]]),
      bars: new Map([[A, bars([100, 110, 99, 120])], [B, bars([100, 100, 100, 100])]]),
    });
    const lots = analyzePortfolio({ ...common, holdings: [h(A, 1), h(A, 9), h(B, 10)] });
    const merged = analyzePortfolio({ ...common, holdings: [h(A, 10), h(B, 10)] });
    expect(lots.holdings.map((r) => r.marketValue)).toEqual([120, 1080, 1000]);
    expect(lots.performance.totalReturnPct).toBeCloseTo(10);
    expect(lots.performance).toEqual(merged.performance);
    expect(lots.risk).toEqual(merged.risk);
    expect(lots.holdings[0].contributionPct! + lots.holdings[1].contributionPct!).toBeCloseTo(merged.holdings[0].contributionPct!);
    expect(lots.correlation.securities).toEqual(merged.correlation.securities);
    expect(lots.correlation.matrix).toEqual(merged.correlation.matrix);
  });
});

describe("analyzePortfolio: positions in USD", () => {
  const result = analyzePortfolio(
    input({
      holdings: [
        { security: A, quantity: 10, weight: null, cost: 100, acquired: null },
        { security: B, quantity: 5, weight: null, cost: 150, acquired: null },
      ],
      quotes: new Map([
        [A, quote(A, 121, 110)],
        [B, quote(B, 198, 180)],
      ]),
      bars: new Map([
        [A, bars([100, 110, 121])],
        [B, bars([200, 180, 198])],
      ]),
      sectors: new Map([
        [A, "Technology"],
        [B, "Energy"],
      ]),
      benchmark: { security: "SPX Index", bars: bars([10, 10.5, 10.5]) },
    }),
  );

  it("values holdings, weights and P&L", () => {
    const [a, b] = result.holdings;
    expect(a.marketValue).toBeCloseTo(1210, 8);
    expect(b.marketValue).toBeCloseTo(990, 8);
    expect(a.weightPct).toBeCloseTo(55, 8);
    expect(b.weightPct).toBeCloseTo(45, 8);
    expect(a.dayPnl).toBeCloseTo(110, 8);
    expect(a.unrealizedPnl).toBeCloseTo(210, 8);
    expect(a.unrealizedPct).toBeCloseTo(21, 8);
    expect(result.totals).toEqual({ marketValue: 2200, dayPnl: 200, costValue: 1750, unrealizedPnl: 450 });
  });

  it("computes holdings-based return against the benchmark", () => {
    expect(result.performance.totalReturnPct).toBeCloseTo(10, 8);
    expect(result.performance.benchmarkReturnPct).toBeCloseTo(5, 8);
    expect(result.performance.points.map((p) => +p.portfolio.toFixed(6))).toEqual([0, 0, 10]);
    expect(result.performance.start).toBe("2026-01-05");
  });

  it("attributes return by holding and sector, summing to the portfolio's daily returns", () => {
    const [a, b] = result.holdings;
    expect(a.contributionPct).toBeCloseTo(10.5, 8);
    expect(b.contributionPct).toBeCloseTo(-0.5, 8);
    expect(a.periodReturnPct).toBeCloseTo(21, 8);
    expect(b.periodReturnPct).toBeCloseTo(-1, 8);
    expect(result.attribution.totalContributionPct).toBeCloseTo(10, 8);
    expect(result.attribution.bySector.map((s) => s.key)).toEqual(["Technology", "Energy"]);
  });

  it("builds exposures", () => {
    expect(result.exposures.sector.map((e) => [e.key, +e.weightPct.toFixed(10)])).toEqual([
      ["Technology", 55],
      ["Energy", 45],
    ]);
    expect(result.exposures.country).toEqual([{ key: "United States", weightPct: 100 }]);
    expect(result.exposures.currency).toEqual([{ key: "USD", weightPct: 100 }]);
    expect(result.exposures.assetClass).toEqual([{ key: "Equity", weightPct: 100 }]);
  });

  it("finds the drawdown and leaves short-sample statistics empty", () => {
    expect(result.risk.observations).toBe(2);
    expect(result.risk.var95Historical).toBeNull();
    expect(result.risk.maxDrawdownPct).toBe(0);
  });
});

describe("analyzePortfolio: currencies", () => {
  it("scales pence and converts to the base currency", () => {
    const vod = "VOD LN Equity";
    const r = analyzePortfolio(
      input({
        holdings: [{ security: vod, quantity: 1000, weight: null, cost: 80, acquired: null }],
        quotes: new Map([[vod, quote(vod, 100, 98, "GBp")]]),
        usdPer: new Map([["GBP", { now: 1.25, bars: [] }]]),
      }),
    );
    const h = r.holdings[0];
    expect(h.currency).toBe("GBP");
    expect(h.priceScale).toBe(0.01);
    expect(h.fxToBase).toBeCloseTo(1.25, 10);
    expect(h.marketValue).toBeCloseTo(1250, 8);
    expect(h.unrealizedPnl).toBeCloseTo(250, 8);
    expect(h.country).toBe("United Kingdom");
  });

  it("converts USD holdings into a EUR base", () => {
    const r = analyzePortfolio(
      input({
        baseCurrency: "EUR",
        holdings: [{ security: A, quantity: 10, weight: null, cost: null, acquired: null }],
        quotes: new Map([[A, quote(A, 110, 100)]]),
        usdPer: new Map([["EUR", { now: 1.1, bars: [] }]]),
      }),
    );
    expect(r.holdings[0].marketValue).toBeCloseTo(1000, 8);
    expect(r.totals.costValue).toBeNull();
  });

  it("flags a missing FX rate and a missing quote instead of guessing", () => {
    const r = analyzePortfolio(
      input({
        holdings: [
          { security: "7203 JT Equity", quantity: 100, weight: null, cost: null, acquired: null },
          { security: "ZZZ US Equity", quantity: 1, weight: null, cost: null, acquired: null },
        ],
        quotes: new Map([["7203 JT Equity", quote("7203 JT Equity", 3000, 2990, "JPY")]]),
      }),
    );
    expect(r.holdings.map((h) => h.error)).toEqual(["NO FX RATE JPY/USD", "NO QUOTE"]);
    expect(r.totals.marketValue).toBe(0);
    expect(r.warnings.join(" ")).toContain("NO QUOTE");
  });
});

describe("analyzePortfolio: model portfolios", () => {
  it("allocates the notional by normalized weights", () => {
    const r = analyzePortfolio(
      input({
        kind: "model",
        notional: 1_000_000,
        holdings: [
          { security: A, quantity: null, weight: 54, cost: null, acquired: null },
          { security: B, quantity: null, weight: 36, cost: null, acquired: null },
        ],
        quotes: new Map([
          [A, quote(A, 100, 100)],
          [B, quote(B, 50, 50)],
        ]),
      }),
    );
    expect(r.holdings[0].marketValue).toBeCloseTo(600_000, 6);
    expect(r.holdings[1].marketValue).toBeCloseTo(400_000, 6);
    expect(r.holdings[0].quantity).toBeCloseTo(6000, 6);
    expect(r.holdings[1].quantity).toBeCloseTo(8000, 6);
    expect(r.warnings[0]).toContain("normalized");
  });
});

describe("analyzePortfolio: history alignment and risk", () => {
  it("starts performance when every holding has a price", () => {
    const r = analyzePortfolio(
      input({
        holdings: [
          { security: A, quantity: 1, weight: null, cost: null, acquired: null },
          { security: B, quantity: 1, weight: null, cost: null, acquired: null },
        ],
        quotes: new Map([
          [A, quote(A, 103, 102)],
          [B, quote(B, 51, 50)],
        ]),
        bars: new Map([
          [A, bars([100, 101, 102, 103])],
          [B, bars([50, 51], T0 + 2 * DAY)],
        ]),
      }),
    );
    expect(r.performance.start).toBe("2026-01-07");
    expect(r.warnings.some((w) => w.includes("first date with prices"))).toBe(true);
  });

  it("computes volatility, VaR and beta on a longer sample", () => {
    const n = 60;
    const bench = Array.from({ length: n }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)) * Math.pow(1.001, i));
    const stock = bench.map((b) => 2 * b - 100);
    const r = analyzePortfolio(
      input({
        holdings: [{ security: A, quantity: 10, weight: null, cost: null, acquired: null }],
        quotes: new Map([[A, quote(A, stock[n - 1], stock[n - 2])]]),
        bars: new Map([[A, bars(stock)]]),
        benchmark: { security: "SPX Index", bars: bars(bench) },
      }),
    );
    const rets = stock.slice(1).map((v, i) => v / stock[i] - 1);
    const mv = 10 * stock[n - 1];
    expect(r.risk.observations).toBe(n - 1);
    expect(r.risk.var95Historical).toBeCloseTo(Math.max(0, -quantile(rets, 0.05)) * mv, 6);
    expect(r.risk.beta!).toBeGreaterThan(1.5);
    expect(r.risk.correlation!).toBeGreaterThan(0.99);
    expect(r.risk.volatilityPct!).toBeGreaterThan(0);
    expect(r.holdings[0].riskContributionPct).toBeCloseTo(100, 6);
    expect(r.correlation.matrix).toEqual([[1]]);
  });
});

describe("helpers", () => {
  it("normalizes minor-unit currencies", () => {
    expect(normalizeCurrency("GBp", "USD")).toEqual({ currency: "GBP", scale: 0.01 });
    expect(normalizeCurrency("ZAc", "USD")).toEqual({ currency: "ZAR", scale: 0.01 });
    expect(normalizeCurrency("eur", "USD")).toEqual({ currency: "EUR", scale: 1 });
    expect(normalizeCurrency(null, "CHF")).toEqual({ currency: "CHF", scale: 1 });
  });

  it("computes quantiles and drawdowns", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
    expect(maxDrawdown([100, 120, 90, 130, 104])).toEqual({ pct: 90 / 120 - 1, peak: 1, trough: 2 });
  });
});
