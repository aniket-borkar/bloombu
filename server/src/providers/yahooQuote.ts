import type { Quote } from "../types.js";

export type YahooRecord = Record<string, unknown>;
const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const positive = (value: unknown): number | null => { const n = num(value); return n !== null && n > 0 ? n : null; };
const str = (value: unknown): string | null => typeof value === "string" && value ? value : null;

function observationTime(value: unknown): { iso: string; ms: number } | null {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value * 1000
    : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? { iso: date.toISOString(), ms } : null;
}

/** Select an actual session observation; an unavailable extended quote stays at the regular session. */
export function yahooQuote(security: string, q: YahooRecord): Quote | null {
  const regular = positive(q.regularMarketPrice);
  const regularTime = observationTime(q.regularMarketTime);
  const marketState = str(q.marketState);
  const session = marketState === "PRE" || marketState === "PREPRE" ? "pre"
    : marketState === "POST" || marketState === "POSTPOST" ? "post" : null;
  let selected: { price: number; time: { iso: string; ms: number } } | null = null;
  if (session) {
    const prefix = session === "pre" ? "preMarket" : "postMarket";
    // Yahoo also exposes a unified current-extended-session observation.
    for (const field of [prefix, "extendedMarket"]) {
      const price = positive(q[`${field}Price`]);
      const time = observationTime(q[`${field}Time`]);
      if (price === null || time === null || (regularTime && time.ms <= regularTime.ms)) continue;
      if (!selected || time.ms > selected.time.ms) selected = { price, time };
    }
  }
  const last = selected?.price ?? regular;
  if (last === null) return null;
  const prevClose = selected && session === "pre" ? regular : positive(q.regularMarketPreviousClose);
  const change = selected ? (prevClose !== null ? last - prevClose : null) : num(q.regularMarketChange);
  const changePct = selected ? (change !== null && prevClose ? change / prevClose * 100 : null) : num(q.regularMarketChangePercent);
  return {
    security,
    name: str(q.longName) ?? str(q.shortName) ?? security,
    last, change, changePct,
    bid: positive(q.bid), ask: positive(q.ask), bidSize: num(q.bidSize) || null, askSize: num(q.askSize) || null,
    // These remain the source's regular-session statistics and are labeled as such in extended hours.
    open: num(q.regularMarketOpen), high: num(q.regularMarketDayHigh), low: num(q.regularMarketDayLow),
    prevClose, volume: num(q.regularMarketVolume),
    currency: str(q.currency), exchange: str(q.fullExchangeName) ?? str(q.exchange), marketState,
    priceSession: selected ? session! : "regular",
    regularClose: regular,
    time: selected?.time.iso ?? regularTime?.iso ?? null,
    delayMinutes: num(q.exchangeDataDelayedBy), source: "Yahoo Finance",
  };
}
