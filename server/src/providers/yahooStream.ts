import WebSocket from "ws";
import { sourceTimeNs } from "../sourceTime.js";
import { normalizeSecurity, parseSecurity, toYahoo } from "../symbology.js";
import type { Quote } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";

const URL = "wss://streamer.finance.yahoo.com/?version=2";
const MAX_FRAME = 24_576;
const MAX_PROTO = 16_384;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
type Tick = Partial<Record<"currency" | "exchange" | "name", string> & Record<"change" | "changePct" | "volume" | "high" | "low" | "open" | "prevClose" | "bid" | "bidSize" | "ask" | "askSize", number>> & { id: string; last: number; time: string; marketHours: number };
const FLOAT_FIELDS: Record<number, keyof Tick> = { 2: "last", 8: "changePct", 10: "high", 11: "low", 12: "change", 15: "open", 16: "prevClose", 23: "bid", 25: "ask" };
const STRING_FIELDS: Record<number, keyof Tick> = { 1: "id", 4: "currency", 5: "exchange", 13: "name" };
const INTEGER_FIELDS: Record<number, keyof Tick> = { 9: "volume", 24: "bidSize", 26: "askSize" };

/** Independently implemented wire decoder; schema reference (not copied library code):
 * https://github.com/ranaroussi/yfinance/blob/main/yfinance/pricing.proto
 * Field presence is retained: absent day/session fields must not erase a REST seed.
 */
export function decodeYahooPricingMessage(encoded: string): Tick | null {
  if (!encoded || encoded.length > MAX_FRAME || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
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
          data[STRING_FIELDS[field]] = bytes.toString("utf8", pos, end);
        } else if (FLOAT_FIELDS[field] || INTEGER_FIELDS[field] || field === 3 || field === 7) return null;
        pos = end;
      } else if (wire === 5) {
        if (pos + 4 > bytes.length) return null;
        const value = bytes.readFloatLE(pos); pos += 4;
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
    return { ...data, time: new Date(milliseconds).toISOString() } as Tick;
  } catch { return null; }
}

function blank(security: string): Quote {
  return { security, name: security, last: null, change: null, changePct: null, bid: null, ask: null, bidSize: null, askSize: null,
    open: null, high: null, low: null, prevClose: null, volume: null, currency: null, exchange: null, marketState: null,
    time: null, delayMinutes: null, source: "Yahoo Finance" };
}
const stamp = (quote: Quote) => sourceTimeNs(quote.time) ?? -1n;
const nyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
const US = new Set(["US", "UN", "UW", "UQ", "UA", "UP"]);
function sessionDate(security: string, time: string | null): string {
  if (!time || sourceTimeNs(time) === null) return "";
  const parsed = parseSecurity(security);
  return parsed?.sector === "Equity" && (!parsed.exchange || US.has(parsed.exchange)) ? nyDate.format(new Date(time)) : time.slice(0, 10);
}
const sameDay = (a: Quote, b: Quote) => !!a.time && !!b.time && sessionDate(a.security, a.time) === sessionDate(b.security, b.time);
function applyTick(security: string, tick: Tick, previous?: Quote): Quote {
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

interface Watch { symbol: string; listeners: Set<(quote: Quote) => void> }
export interface YahooStreamOptions { wsUrl?: string }

/** One unofficial public Yahoo stream; silence and unavailable markets retain REST fallback in the hub. */
export function createYahooQuoteStream(options: YahooStreamOptions = {}): { subscribe: NonNullable<ProviderPlugin["subscribe"]>; seed(quotes: Quote[]): void } {
  const watches = new Map<string, Watch>();
  const latest = new Map<string, Quote>();
  const native = new Set<string>();
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  const symbols = () => [...new Set([...watches.values()].map((watch) => watch.symbol))];
  const send = (op: "subscribe" | "unsubscribe", list: string[]) => {
    if (socket?.readyState === WebSocket.OPEN && list.length) socket.send(JSON.stringify({ [op]: list }));
  };
  const publish = (security: string, quote: Quote) => {
    latest.set(security, quote);
    for (const listener of watches.get(security)?.listeners ?? []) listener(quote);
  };
  const stop = () => {
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    retry = heartbeat = null;
    const previous = socket; socket = null;
    if (previous?.readyState === WebSocket.CONNECTING) previous.terminate(); else previous?.close();
    attempts = 0;
  };
  const connect = () => {
    if (socket || retry || !watches.size) return;
    const ws = new WebSocket(options.wsUrl ?? URL, { handshakeTimeout: 8000, maxPayload: MAX_FRAME, perMessageDeflate: false });
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws) return;
      send("subscribe", symbols());
      heartbeat = setInterval(() => send("subscribe", symbols()), 15_000);
      heartbeat.unref();
    });
    ws.on("message", (raw) => {
      if (socket !== ws) return;
      const frame = raw.toString();
      if (frame.length > MAX_FRAME) return;
      let message: unknown;
      try { message = JSON.parse(frame); } catch { return; }
      if (!message || typeof message !== "object" || !("message" in message) || typeof message.message !== "string") return;
      const tick = decodeYahooPricingMessage(message.message);
      if (!tick) return;
      attempts = 0;
      const time = sourceTimeNs(tick.time)!;
      for (const [security, watch] of watches) {
        if (watch.symbol !== tick.id) continue;
        const previous = latest.get(security);
        if (previous && time < stamp(previous)) continue;
        native.add(security);
        publish(security, applyTick(security, tick, previous));
      }
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (watches.size) {
        retry = setTimeout(() => { retry = null; connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
        retry.unref();
      }
    });
    ws.on("error", () => {}); // Close/backoff handles transport failures; do not log arbitrary upstream text.
  };
  return {
    seed(quotes) {
      for (const incoming of quotes) {
        const security = normalizeSecurity(incoming.security);
        if (!security || !toYahoo(security)) continue;
        const previous = latest.get(security);
        if (!previous || stamp(incoming) > stamp(previous) || (stamp(incoming) === stamp(previous) && !native.has(security))) {
          native.delete(security);
          publish(security, { ...incoming, security });
        }
        else {
          const enriched: Quote = { ...previous, name: incoming.name || previous.name, currency: incoming.currency ?? previous.currency,
            exchange: incoming.exchange ?? previous.exchange, delayMinutes: incoming.delayMinutes ?? previous.delayMinutes };
          if (sameDay(incoming, previous)) {
            for (const key of ["open", "high", "low", "volume"] as const) enriched[key] ??= incoming[key];
            if (incoming.priceSession === previous.priceSession) {
              enriched.regularClose ??= incoming.regularClose;
              enriched.prevClose ??= incoming.prevClose;
            }
            if (enriched.change === null && enriched.last !== null && enriched.prevClose !== null) enriched.change = enriched.last - enriched.prevClose;
            if (enriched.changePct === null && enriched.change !== null && enriched.prevClose) enriched.changePct = enriched.change / enriched.prevClose * 100;
          }
          publish(security, enriched);
        }
      }
      if (latest.size > 1024) for (const key of latest.keys()) {
        if (!watches.has(key)) latest.delete(key);
        if (latest.size <= 1024) break;
      }
    },
    subscribe(securities, onQuote) {
      const entries: { security: string; watch: Watch }[] = [];
      const fresh: string[] = [];
      for (const input of securities) {
        const security = normalizeSecurity(input);
        const symbol = toYahoo(input);
        if (!security || !symbol) continue;
        let watch = watches.get(security);
        if (!watch) {
          if (![...watches.values()].some((value) => value.symbol === symbol)) fresh.push(symbol);
          watches.set(security, (watch = { symbol, listeners: new Set() }));
        }
        watch.listeners.add(onQuote); entries.push({ security, watch });
        const cached = latest.get(security); if (cached) onQuote(cached);
      }
      send("subscribe", fresh);
      connect();
      let released = false;
      return () => {
        if (released) return; released = true;
        const removed: string[] = [];
        for (const { security, watch } of entries) {
          if (watches.get(security) !== watch || !watch.listeners.delete(onQuote) || watch.listeners.size) continue;
          watches.delete(security); latest.delete(security); native.delete(security);
          if (![...watches.values()].some((value) => value.symbol === watch.symbol)) removed.push(watch.symbol);
        }
        send("unsubscribe", [...new Set(removed)]);
        if (!watches.size) stop();
      };
    },
  };
}
