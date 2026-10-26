import YahooFinance from "yahoo-finance2";
import type { ProviderPlugin } from "./DataProvider.js";
import type { Bar, Interval, SearchResult } from "../types.js";
import { fromYahoo, normalizeSecurity, sectorOf, toYahoo } from "../symbology.js";
import * as research from "./yahooResearch.js";
import { yahooQuote } from "./yahooQuote.js";
import { createYahooQuoteStream } from "./yahooStream.js";

type YahooRecord = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Yahoo's approximate maximum lookback per intraday interval. */
const INTRADAY_LOOKBACK_MS: Partial<Record<Interval, number>> = {
  "1m": 7 * 86_400_000,
  "5m": 59 * 86_400_000,
  "1h": 729 * 86_400_000,
};

const QUOTE_BATCH = 100;

export function createYahooProvider(): ProviderPlugin {
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
  const stream = createYahooQuoteStream();

  return {
    id: "yahoo",
    sectors: ["Equity", "Index", "Comdty", "Curncy", "Govt"],
    subscribe: stream.subscribe,

    async quotes(securities) {
      const pairs = securities.flatMap((s) => {
        const security = normalizeSecurity(s);
        const symbol = toYahoo(s);
        return security && symbol ? [{ security, symbol }] : [];
      });
      if (!pairs.length) return [];
      const symbols = [...new Set(pairs.map((p) => p.symbol))];
      const chunks: string[][] = [];
      for (let i = 0; i < symbols.length; i += QUOTE_BATCH) chunks.push(symbols.slice(i, i + QUOTE_BATCH));
      const results = (
        await Promise.all(chunks.map((c) => yf.quote(c, { return: "array" }, { validateResult: false }) as Promise<YahooRecord[]>))
      ).flat();
      const bySymbol = new Map(results.map((r) => [r.symbol as string, r]));
      const quotes = pairs.flatMap((p) => {
        const r = bySymbol.get(p.symbol);
        const quote = r ? yahooQuote(p.security, r) : null;
        return quote ? [quote] : [];
      });
      stream.seed(quotes);
      return quotes;
    },

    async search(query) {
      const res = (await yf.search(query, { quotesCount: 12, newsCount: 0 }, { validateResult: false })) as {
        quotes?: YahooRecord[];
      };
      const out: SearchResult[] = [];
      for (const q of res.quotes ?? []) {
        const symbol = str(q.symbol);
        if (!symbol) continue;
        const security = fromYahoo(symbol, str(q.quoteType) ?? undefined);
        if (!security) continue;
        out.push({
          security,
          name: str(q.longname) ?? str(q.shortname) ?? symbol,
          sector: sectorOf(security) ?? "Equity",
          exchange: str(q.exchDisp) ?? str(q.exchange),
        });
      }
      return out;
    },

    async history(security, interval, from, to) {
      const symbol = toYahoo(security);
      if (!symbol) return [];
      const lookback = INTRADAY_LOOKBACK_MS[interval];
      const earliest = lookback ? Date.now() - lookback : 0;
      const start = Math.max(from.getTime(), earliest);
      if (start >= to.getTime()) return [];
      const res = (await yf.chart(
        symbol,
        { period1: new Date(start), period2: to, interval, includePrePost: false, return: "array" },
        { validateResult: false },
      )) as { quotes?: YahooRecord[] };
      const bars: Bar[] = [];
      for (const q of res.quotes ?? []) {
        const o = num(q.open);
        const h = num(q.high);
        const l = num(q.low);
        const c = num(q.close);
        if (!(q.date instanceof Date) || o === null || h === null || l === null || c === null) continue;
        bars.push({ t: q.date.getTime(), o, h, l, c, v: num(q.volume) });
      }
      return bars;
    },

    profile: (security) => research.profile(yf, security),
    financials: (security, statement, period) => research.financials(yf, security, statement, period),
    earnings: (security) => research.earnings(yf, security),
    analysts: (security) => research.analysts(yf, security),
    holders: (security) => research.holders(yf, security),
    events: (security) => research.events(yf, security),
    options: (security, expiration) => research.options(yf, security, expiration),
    related: (security) => research.related(yf, security),
    valuations: (securities) => research.valuations(yf, securities),
    futuresChain: (security) => research.futuresChain(yf, security),
    companyNews: (security) => research.companyNews(yf, security),
    news: (query) => research.news(yf, query),
    topNews: () => research.topNews(),
    screen: (id) => research.screen(yf, id),
  };
}
