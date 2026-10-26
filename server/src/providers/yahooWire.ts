import { sourceTimeNs } from "../sourceTime.js";
import { parseSecurity } from "../symbology.js";
import type { Quote } from "../types.js";

export const YAHOO_MAX_FRAME = 24_576;
const MAX_PROTO = 16_384;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
export type YahooTick = Partial<Record<"currency" | "exchange" | "name", string> & Record<"change" | "changePct" | "volume" | "high" | "low" | "open" | "prevClose" | "bid" | "bidSize" | "ask" | "askSize", number>> & { id: string; last: number; time: string; marketHours: number };
const FLOAT_FIELDS: Record<number, keyof YahooTick> = { 2: "last", 8: "changePct", 10: "high", 11: "low", 12: "change", 15: "open", 16: "prevClose", 23: "bid", 25: "ask" };
const STRING_FIELDS: Record<number, keyof YahooTick> = { 1: "id", 4: "currency", 5: "exchange", 13: "name" };
const INTEGER_FIELDS: Record<number, keyof YahooTick> = { 9: "volume", 24: "bidSize", 26: "askSize" };

/** Independently implemented wire decoder; schema reference (not copied library code):
 * https://github.com/ranaroussi/yfinance/blob/main/yfinance/pricing.proto
 * Field presence is retained: absent day/session fields must not erase a REST seed.
 */
export function decodeYahooPricingMessage(encoded: string): YahooTick | null {
  if (!encoded || encoded.length > YAHOO_MAX_FRAME || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!bytes.length || bytes.length > MAX_PROTO) return null;
  let pos = 0;
  // Proto3's enum default is PRE_MARKET=0 when field 7 is omitted.
  // Enum schema: github.com/yahoofinancelive/yliveticker/blob/master/yliveticker/yaticker.proto
  const data: Record<string, unknown> = { marketHours: 0 };
  const variable = (): bigint => {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (pos >= bytes.length) throw new Error("truncated varint");
      const b = bytes[pos++];
      if (i === 9 && b > 1) throw new Error("oversized varint");
      result |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return result;
    }
    throw new Error("long varint");
  };
  try {
    for (let fields = 0; pos < bytes.length; fields++) {
      if (fields >= 128) return null;
      const tag = variable();
      if (tag > 0xffffffffn) return null;
      const field = Number(tag >> 3n);
      const wire = Number(tag & 7n);
      if (!field) return null;
      if (wire === 0) {
        const raw = variable();
        if (field === 7) {
          if (raw > 0x7fffffffn) return null;
          data.marketHours = Number(raw);
        } else if (field === 3 || INTEGER_FIELDS[field]) {
          const signed = (raw >> 1n) ^ -(raw & 1n);
          if (signed < -MAX_SAFE || signed > MAX_SAFE) return null;
          if (field === 3) data.milliseconds = Number(signed);
          else data[INTEGER_FIELDS[field]] = Number(signed);
        } else if (FLOAT_FIELDS[field] || STRING_FIELDS[field]) return null;
      } else if (wire === 2) {
        const length = variable();
        if (length > BigInt(bytes.length - pos)) return null;
        const end = pos + Number(length);
        if (STRING_FIELDS[field]) {
          if (length > 512n) return null;
          data[STRING_FIELDS[field]] = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(pos, end));
        } else if (FLOAT_FIELDS[field] || INTEGER_FIELDS[field] || field === 3 || field === 7) return null;
        pos = end;
      } else if (wire === 5) {
        if (pos + 4 > bytes.length) return null;
        const value = view.getFloat32(pos, true); pos += 4;
        if (FLOAT_FIELDS[field]) {
          if (!Number.isFinite(value)) return null;
          data[FLOAT_FIELDS[field]] = value;
        } else if (STRING_FIELDS[field] || INTEGER_FIELDS[field] || field === 3 || field === 7) return null;
      } else if (wire === 1) {
        if (pos + 8 > bytes.length || FLOAT_FIELDS[field] || STRING_FIELDS[field] || INTEGER_FIELDS[field] || field === 3 || field === 7) return null;
        pos += 8;
      } else return null;
    }
    const milliseconds = data.milliseconds;
    if (typeof data.id !== "string" || !data.id || data.id.length > 128 || typeof data.last !== "number" || data.last <= 0
      || typeof milliseconds !== "number" || milliseconds <= 0 || !Number.isFinite(new Date(milliseconds).getTime())) return null;
    delete data.milliseconds;
    return { ...data, time: new Date(milliseconds).toISOString() } as YahooTick;
  } catch { return null; }
}

function blank(security: string): Quote {
  return { security, name: security, last: null, change: null, changePct: null, bid: null, ask: null, bidSize: null, askSize: null,
    open: null, high: null, low: null, prevClose: null, volume: null, currency: null, exchange: null, marketState: null,
    time: null, delayMinutes: null, source: "Yahoo Finance" };
}
export const yahooQuoteTime = (quote: Quote) => sourceTimeNs(quote.time) ?? -1n;
const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const US = new Set(["US", "UN", "UW", "UQ", "UA", "UP"]);
function sessionDate(security: string, time: string | null): string {
  if (!time || sourceTimeNs(time) === null) return "";
  const parsed = parseSecurity(security);
  return parsed?.sector === "Equity" && (!parsed.exchange || US.has(parsed.exchange)) ? nyDate.format(new Date(time)) : time.slice(0, 10);
}
const sameDay = (a: Quote, b: Quote) => !!a.time && !!b.time && sessionDate(a.security, a.time) === sessionDate(b.security, b.time);
export function applyYahooTick(security: string, tick: YahooTick, previous?: Quote): Quote {
  const session = tick.marketHours === 0 ? "pre" : tick.marketHours === 1 ? "regular" : tick.marketHours === 2 ? "post" : undefined;
  const dayMatches = !!previous?.time && sessionDate(security, previous.time) === sessionDate(security, tick.time);
  const quote: Quote = { ...(previous ?? blank(security)), last: tick.last, time: tick.time,
    priceSession: session, marketState: session === "pre" ? "PRE" : session === "regular" ? "REGULAR" : session === "post" ? "POST" : null };
  if (previous && !dayMatches) {
    quote.open = quote.high = quote.low = quote.volume = quote.prevClose = quote.regularClose = null;
  }
  for (const key of ["currency", "exchange", "name"] as const) if (tick[key]) quote[key] = tick[key]!;
  for (const key of ["bid", "ask"] as const) {
    if (tick[key] !== undefined) quote[key] = tick[key]! > 0 ? tick[key]! : null;
  }
  for (const key of ["bidSize", "askSize"] as const) {
    if (tick[key] !== undefined && tick[key]! >= 0) quote[key] = tick[key]!;
  }
  if (session === "regular") {
    for (const key of ["open", "high", "low"] as const) if (tick[key] !== undefined) quote[key] = tick[key]! > 0 ? tick[key]! : null;
    if (tick.volume !== undefined && tick.volume >= 0) quote.volume = tick.volume;
  }
  if (session !== "post" && tick.prevClose !== undefined) quote.prevClose = tick.prevClose > 0 ? tick.prevClose : null;
  const reportedReference = tick.change !== undefined && tick.last - tick.change > 0 ? tick.last - tick.change : null;
  if (session === "post") {
    // The wire's POST change/reference basis is not specified by the public
    // schema. Only REST can establish these trusted day/regular references.
    quote.prevClose = dayMatches && (previous?.priceSession === "post" || previous?.priceSession === "regular") ? previous.prevClose : null;
    quote.regularClose = dayMatches && previous?.priceSession === "post" ? previous.regularClose ?? null : null;
  } else if (session === "pre") {
    if (previous?.priceSession !== "pre" && reportedReference === null && tick.prevClose === undefined) quote.regularClose = null;
    quote.regularClose = reportedReference ?? quote.regularClose ?? null;
    quote.prevClose = reportedReference ?? (tick.prevClose !== undefined ? quote.prevClose : quote.regularClose);
  } else if (session === "regular") {
    quote.regularClose = tick.last;
    if (tick.prevClose === undefined && reportedReference !== null) quote.prevClose = reportedReference;
    else if (previous?.priceSession !== "regular" && tick.prevClose === undefined && reportedReference === null) quote.prevClose = null;
  } else if (previous?.priceSession !== session && tick.prevClose === undefined) quote.prevClose = null;
  quote.change = quote.prevClose !== null ? tick.last - quote.prevClose : null;
  quote.changePct = quote.change !== null && quote.prevClose ? quote.change / quote.prevClose * 100 : null;
  return quote;
}

/** Enrich late REST metadata without allowing it to rewind an accepted source tick. */
export function mergeYahooSeed(incoming: Quote, current?: Quote, native = false): Quote {
  if (!current || yahooQuoteTime(incoming) > yahooQuoteTime(current) || (yahooQuoteTime(incoming) === yahooQuoteTime(current) && !native)) return { ...incoming };
  const enriched: Quote = { ...current, name: incoming.name || current.name, currency: incoming.currency ?? current.currency,
    exchange: incoming.exchange ?? current.exchange, delayMinutes: incoming.delayMinutes ?? current.delayMinutes };
  if (sameDay(incoming, current)) {
    for (const key of ["open", "high", "low", "volume"] as const) enriched[key] ??= incoming[key];
    if (incoming.priceSession === current.priceSession) {
      enriched.regularClose ??= incoming.regularClose;
      enriched.prevClose ??= incoming.prevClose;
    }
    if (enriched.change === null && enriched.last !== null && enriched.prevClose !== null) enriched.change = enriched.last - enriched.prevClose;
    if (enriched.changePct === null && enriched.change !== null && enriched.prevClose) enriched.changePct = enriched.change / enriched.prevClose * 100;
  }
  return enriched;
}
