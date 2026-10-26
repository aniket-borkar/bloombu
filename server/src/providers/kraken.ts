import WebSocket from "ws";
import { sourceTimeNs } from "../sourceTime.js";
import { cryptoPair, normalizeSecurity } from "../symbology.js";
import type { Quote, Trade } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { UsageMeter } from "./usage.js";

const REST_URL = "https://api.kraken.com";
const WS_URL = "wss://ws.kraken.com/v2";
const RATE_LIMIT = { perMinute: 50 };
const NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };
type Data = Record<string, unknown>;
const obj = (v: unknown): Data => v && typeof v === "object" && !Array.isArray(v) ? v as Data : {};
const num = (v: unknown): number | null => {
  if (typeof v !== "number" && (typeof v !== "string" || !v.trim())) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const price = (v: unknown) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const time = (v: unknown): string | null => typeof v === "string" && sourceTimeNs(v) !== null ? v : null;
const stamp = (v: string | null) => sourceTimeNs(v) ?? -1n;
function symbolFor(security: string): string | null {
  const pair = cryptoPair(security);
  if (!pair) return null;
  const [base, quote] = pair.split("-");
  return NAMES[base] && ["USD", "EUR", "GBP"].includes(quote) ? `${base}/${quote}` : null;
}
function baseQuote(symbol: string): Quote {
  const [base, currency] = symbol.split("/");
  return {
    security: symbol, name: `${NAMES[base]} ${currency}`, last: null, change: null, changePct: null,
    bid: null, ask: null, bidSize: null, askSize: null, open: null, high: null, low: null,
    prevClose: null, volume: null, currency, exchange: "Kraken", marketState: "REGULAR",
    time: null, delayMinutes: 0, source: "Kraken",
  };
}
interface Watch { quotes: Set<{ security: string; listener: (q: Quote) => void }>; trades: Set<(t: Trade) => void>; lastTradeId?: number }
export interface KrakenOptions { wsUrl?: string; restUrl?: string }

/** Public crypto market data: no signup, key, token, or private account API. */
export function createKrakenProvider(options: KrakenOptions = {}): ProviderPlugin {
  let meter = new UsageMeter();
  const watches = new Map<string, Watch>();
  const cache = new Map<string, { quote: Quote; at: number; live: boolean }>();
  const pending = new Map<string, Promise<Quote | null>>();
  let socket: WebSocket | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let restBlockedUntil = 0;

  async function get(path: "Ticker" | "Trades", pair: string): Promise<Data> {
    if (Date.now() < restBlockedUntil) throw new Error("Kraken public requests are temporarily paused");
    return meter.run("kraken", RATE_LIMIT, async () => {
      const url = new URL(`/0/public/${path}`, options.restUrl ?? REST_URL);
      url.searchParams.set("pair", pair.replace("BTC", "XBT").replace("/", ""));
      url.searchParams.set("assetVersion", "1");
      if (path === "Trades") url.searchParams.set("count", "1");
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (response.status === 429) restBlockedUntil = Date.now() + 60_000;
      if (!response.ok) throw new Error(`Kraken public ${path} returned ${response.status}`);
      const data = obj(await response.json());
      if (Array.isArray(data.error) && data.error.length) {
        if (data.error.some((e) => typeof e === "string" && /rate limit|throttled/i.test(e))) restBlockedUntil = Date.now() + 60_000;
        throw new Error(`Kraken public ${path} rejected the request`);
      }
      return obj(data.result);
    });
  }

  function accept(symbol: string, quote: Quote, live: boolean): Quote {
    const previous = cache.get(symbol);
    if (previous && stamp(previous.quote.time) > stamp(quote.time)) return previous.quote;
    cache.set(symbol, { quote, at: Date.now(), live });
    return quote;
  }

  async function snapshot(symbol: string): Promise<Quote | null> {
    const cached = cache.get(symbol);
    if (cached && Date.now() - cached.at < (cached.live ? 5000 : 10_000)) return cached.quote;
    const existing = pending.get(symbol);
    if (existing) return existing;
    const request = (async () => {
      const [tickers, recent] = await Promise.all([get("Ticker", symbol), get("Trades", symbol)]);
      const ticker = obj(tickers[symbol] ?? Object.values(tickers)[0]);
      const rows = recent[symbol] ?? Object.entries(recent).find(([key]) => key !== "last")?.[1];
      const trade = Array.isArray(rows) && Array.isArray(rows.at(-1)) ? rows.at(-1) as unknown[] : null;
      const last = trade && price(trade[0]);
      const seconds = trade && num(trade[2]);
      const date = seconds !== null ? new Date(seconds * 1000) : null;
      if (last === null || !date || !Number.isFinite(date.getTime())) return null;
      const cell = (field: string, index: number) => Array.isArray(ticker[field]) ? ticker[field][index] : undefined;
      const q: Quote = {
        ...baseQuote(symbol), last, time: date.toISOString(), bid: price(cell("b", 0)), ask: price(cell("a", 0)),
        bidSize: num(cell("b", 2)), askSize: num(cell("a", 2)), high: price(cell("h", 1)), low: price(cell("l", 1)), volume: num(cell("v", 1)),
      };
      // REST's opening price is midnight UTC, not the rolling 24h reference.
      return accept(symbol, q, false);
    })();
    pending.set(symbol, request);
    try { return await request; } finally { if (pending.get(symbol) === request) pending.delete(symbol); }
  }

  function send(method: "subscribe" | "unsubscribe", channel: "ticker" | "trade", symbols: string[]): void {
    if (socket?.readyState !== WebSocket.OPEN || !symbols.length) return;
    socket.send(JSON.stringify({ method, params: { channel, symbol: symbols,
      ...(method === "subscribe" ? { snapshot: channel === "ticker", ...(channel === "ticker" ? { event_trigger: "trades" } : {}) } : {}) } }));
  }

  function ensureSocket(): void {
    if (socket || reconnect || !watches.size) return;
    const ws = new WebSocket(options.wsUrl ?? WS_URL, { handshakeTimeout: 10_000 });
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws) return;
      send("subscribe", "ticker", [...watches].filter(([, w]) => w.quotes.size).map(([s]) => s));
      send("subscribe", "trade", [...watches].filter(([, w]) => w.trades.size).map(([s]) => s));
    });
    ws.on("message", (raw) => {
      if (socket !== ws) return;
      let message: Data;
      try { message = obj(JSON.parse(raw.toString())); } catch { return; }
      if (message.success === false) { console.warn("Kraken public subscription rejected"); return; }
      if (!Array.isArray(message.data)) return;
      for (const value of message.data) {
        const data = obj(value);
        const watch = typeof data.symbol === "string" ? watches.get(data.symbol) : null;
        const at = time(data.timestamp);
        if (!watch || !at) continue;
        if (message.channel === "ticker") {
          const last = price(data.last);
          if (last === null) continue;
          const change = num(data.change);
          const previous = last !== null && change !== null ? last - change : null;
          const q = accept(data.symbol as string, { ...baseQuote(data.symbol as string), last, time: at,
            bid: price(data.bid), ask: price(data.ask), bidSize: num(data.bid_qty), askSize: num(data.ask_qty),
            high: price(data.high), low: price(data.low), volume: num(data.volume), change, changePct: num(data.change_pct),
            prevClose: previous !== null && previous > 0 ? previous : null }, true);
          retries = 0;
          for (const entry of watch.quotes) entry.listener({ ...q, security: entry.security });
        } else if (message.channel === "trade") {
          const last = price(data.price);
          const id = num(data.trade_id);
          if (last === null || (id !== null && watch.lastTradeId !== undefined && id <= watch.lastTradeId)) continue;
          if (id !== null) watch.lastTradeId = id;
          const trade: Trade = { price: last, time: at, size: num(data.qty), side: data.side === "buy" || data.side === "sell" ? data.side : null, venue: "Kraken" };
          retries = 0;
          for (const listener of watch.trades) listener(trade);
        }
      }
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (watches.size) {
        reconnect = setTimeout(() => { reconnect = null; ensureSocket(); }, Math.min(60_000, 5000 * 2 ** Math.min(retries++, 4)));
        reconnect.unref();
      }
    });
    ws.on("error", () => console.warn("Kraken public stream connection failed"));
  }

  function watch(symbol: string): Watch {
    let value = watches.get(symbol);
    if (!value) watches.set(symbol, (value = { quotes: new Set(), trades: new Set() }));
    return value;
  }
  function release(symbol: string): void {
    const value = watches.get(symbol);
    if (value && !value.quotes.size && !value.trades.size) watches.delete(symbol);
    if (watches.size) return;
    if (reconnect) clearTimeout(reconnect);
    reconnect = null;
    const previous = socket;
    socket = null;
    if (previous?.readyState === WebSocket.CONNECTING) previous.terminate(); else previous?.close();
    retries = 0;
  }

  return {
    id: "kraken", sectors: ["Curncy"], covers: (security) => symbolFor(security) !== null,
    rateLimit: RATE_LIMIT, setUsageMeter: (next) => { meter = next; },
    async quotes(securities) {
      const results = await Promise.allSettled(securities.map(async (security) => {
        const symbol = symbolFor(security); const canonical = normalizeSecurity(security);
        if (!symbol || !canonical) return null;
        const q = await snapshot(symbol); return q ? { ...q, security: canonical } : null;
      }));
      if (results.length && results.every((r) => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
      return results.flatMap((r) => r.status === "fulfilled" && r.value ? [r.value] : []);
    },
    subscribe(securities, onQuote) {
      const offs: (() => void)[] = [];
      for (const security of securities) {
        const symbol = symbolFor(security); const canonical = normalizeSecurity(security);
        if (!symbol || !canonical) continue;
        const value = watch(symbol); const first = !value.quotes.size;
        const entry = { security: canonical, listener: onQuote }; value.quotes.add(entry);
        if (first) send("subscribe", "ticker", [symbol]);
        void snapshot(symbol).then((q) => { if (q && value.quotes.has(entry)) onQuote({ ...q, security: canonical }); }).catch(() => {});
        offs.push(() => { if (!value.quotes.delete(entry)) return; if (!value.quotes.size) send("unsubscribe", "ticker", [symbol]); release(symbol); });
      }
      ensureSocket();
      return () => { for (const off of offs.splice(0)) off(); };
    },
    subscribeTrades(security, onTrade) {
      const symbol = symbolFor(security); if (!symbol) return () => {};
      const value = watch(symbol); const first = !value.trades.size;
      value.trades.add(onTrade); if (first) send("subscribe", "trade", [symbol]); ensureSocket();
      let released = false;
      return () => { if (released) return; released = true; value.trades.delete(onTrade); if (!value.trades.size) send("unsubscribe", "trade", [symbol]); release(symbol); };
    },
  };
}
