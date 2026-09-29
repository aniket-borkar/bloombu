import type { HistoryCache } from "../history/cache.js";
import { RANGE_MS, type Range } from "../history/ranges.js";
import { TtlCache } from "../providers/cache.js";
import type { ProviderRouter } from "../providers/router.js";
import { sectorOf } from "../symbology.js";
import type { Bar, PortfolioAnalytics, PortfolioInput, Quote } from "../types.js";
import { analyzePortfolio, normalizeCurrency, type FxSeries } from "./analytics.js";

export const PORTFOLIO_RANGES = ["3mo", "6mo", "1y", "2y", "5y"] as const satisfies readonly Range[];

/** Currencies quoted as XXXUSD by market convention; others as USDXXX. */
const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);
const usdPair = (ccy: string) => (USD_QUOTED.has(ccy) ? `${ccy}USD Curncy` : `USD${ccy} Curncy`);

/** Fetches quotes, history, FX, sectors and the risk-free rate, then runs the pure analytics. */
export class PortfolioService {
  private sectors = new TtlCache<string | null>(3_600_000);
  private riskFree = new TtlCache<number | null>(3_600_000);

  constructor(
    private router: ProviderRouter,
    private history: HistoryCache,
    private now: () => number = Date.now,
  ) {}

  async analyze(p: PortfolioInput, range: Range, benchmark: string): Promise<PortfolioAnalytics> {
    const now = this.now();
    const from = now - RANGE_MS[range];
    const securities = [...new Set(p.holdings.map((h) => h.security))];

    const quoteList = await this.router.quotes([...securities, benchmark]);
    const quotes = new Map<string, Quote>(quoteList.map((q) => [q.security, q]));

    const barsFor = (s: string) => this.history.get(s, "1d", from, now).catch((): Bar[] => []);
    const [barsList, benchBars, sectorList, riskFreePct] = await Promise.all([
      Promise.all(securities.map(barsFor)),
      barsFor(benchmark),
      Promise.all(securities.map((s) => this.sector(s))),
      this.riskFree.get("3m", () => this.threeMonthBill()),
    ]);
    const bars = new Map(securities.map((s, i) => [s, barsList[i]]));
    const sectors = new Map(securities.map((s, i) => [s, sectorList[i]]));

    const currencies = new Set<string>([p.baseCurrency]);
    for (const q of quoteList) currencies.add(normalizeCurrency(q.currency, p.baseCurrency).currency);
    currencies.delete("USD");
    const usdPer = new Map<string, FxSeries>();
    await Promise.all(
      [...currencies].map(async (ccy) => {
        const pair = usdPair(ccy);
        const invert = !USD_QUOTED.has(ccy);
        const [q, pairBars] = await Promise.all([this.router.quote(pair).catch(() => null), barsFor(pair)]);
        const conv = (v: number) => (invert ? 1 / v : v);
        if (!q?.last && !pairBars.length) return;
        usdPer.set(ccy, {
          now: q?.last ? conv(q.last) : null,
          bars: pairBars.filter((b) => b.c > 0).map((b) => ({ ...b, o: conv(b.o), h: conv(b.h), l: conv(b.l), c: conv(b.c) })),
        });
      }),
    );

    return analyzePortfolio({
      name: p.name,
      kind: p.kind,
      baseCurrency: p.baseCurrency,
      notional: p.notional,
      holdings: p.holdings,
      quotes,
      bars,
      usdPer,
      sectors,
      benchmark: { security: benchmark, bars: benchBars },
      riskFreePct,
      range,
      now,
    });
  }

  private sector(security: string): Promise<string | null> {
    if (sectorOf(security) !== "Equity") return Promise.resolve(null);
    return this.sectors.get(security, async () => {
      const profile = await this.router.first("profile", security, (pl) => pl.profile!(security)).catch(() => null);
      return profile?.sector ?? null;
    });
  }

  private async threeMonthBill(): Promise<number | null> {
    const curve = await this.router.first("yieldCurve", null, (pl) => pl.yieldCurve!()).catch(() => null);
    return curve?.points.find((pt) => pt.tenor === "3M")?.yieldPct ?? null;
  }
}
