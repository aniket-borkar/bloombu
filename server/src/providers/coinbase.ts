import WebSocket from "ws";
import { cryptoPair, normalizeSecurity } from "../symbology.js";
import type { Bar, Interval, Quote, Trade } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";

const REST_URL = "https://api.exchange.coinbase.com";
const WS_URL = "wss://ws-feed.exchange.coinbase.com";
const GRANULARITY: Partial<Record<Interval, number>> = { "1m": 60, "5m": 300, "1h": 3600, "1d": 86400 };
const CANDLES_PER_REQUEST = 300;
const MAX_PAGES = 8;
const NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };

interface RestTicker {
  price?: string;
  bid?: string;
  ask?: string;
  volume?: string;
  time?: string;
}
interface RestStats {
  open?: string;
  high?: string;
  low?: string;
}
interface WsTicker {
  type: "ticker";
  product_id: string;
  price: string;
  open_24h: string;
  volume_24h: string;
  low_24h: string;
  high_24h: string;
  best_bid: string;
  best_bid_size: string;
  best_ask: string;
  best_ask_size: string;
  time: string;
}
interface WsMatch {
  type: "match" | "last_match";
  product_id: string;
  price: string;
  size: string;
  side: "buy" | "sell";
  time: string;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

interface TickFields {
  last: number | null;
  open24h: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  time: string | null;
}

/** Coinbase trades 24/7, so change is measured against the price 24 hours ago. */
export function cryptoQuote(security: string, product: string, f: TickFields): Quote {
  const [base, quote] = product.split("-");
  const change = f.last !== null && f.open24h !== null ? f.last - f.open24h : null;
  return {
    security,
    name: `${NAMES[base] ?? base} ${quote}`,
    last: f.last,
    change,
    changePct: change !== null && f.open24h ? (change / f.open24h) * 100 : null,
    bid: f.bid,
    ask: f.ask,
    bidSize: f.bidSize,
    askSize: f.askSize,
    open: f.open24h,
    high: f.high,
    low: f.low,
    prevClose: f.open24h,
    volume: f.volume,
    currency: quote,
    exchange: "Coinbase",
    marketState: "REGULAR",
    time: f.time,
    delayMinutes: 0,
    source: "coinbase",
  };
}

/** Coinbase reports the maker's side; the aggressor is the other side. */
export function matchToTrade(m: WsMatch): Trade {
  return { time: m.time, price: Number(m.price), size: num(m.size), side: m.side === "sell" ? "buy" : "sell", venue: "Coinbase" };
}

export interface CoinbaseOptions {
  restUrl?: string;
  wsUrl?: string;
  reconnectMs?: number;
}

/** Real-time crypto prices and trades from Coinbase's public market data (no key). */
export function createCoinbaseProvider(opts: CoinbaseOptions = {}): ProviderPlugin {
  const restUrl = opts.restUrl ?? REST_URL;
  const wsUrl = opts.wsUrl ?? WS_URL;
  const reconnectMs = opts.reconnectMs ?? 5000;

  async function get<T>(path: string): Promise<T | null> {
    const res = await fetch(`${restUrl}${path}`, { headers: { accept: "application/json", "user-agent": "BLMBU Terminal" } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`coinbase ${path.split("?")[0]} returned ${res.status}`);
    return (await res.json()) as T;
  }

  async function restQuote(security: string): Promise<Quote | null> {
    const product = cryptoPair(security);
    const key = normalizeSecurity(security);
    if (!product || !key) return null;
    const [t, s] = await Promise.all([get<RestTicker>(`/products/${product}/ticker`), get<RestStats>(`/products/${product}/stats`)]);
    if (!t || !s) return null;
    return cryptoQuote(key, product, {
      last: num(t.price),
      open24h: num(s.open),
      high: num(s.high),
      low: num(s.low),
      volume: num(t.volume),
      bid: num(t.bid),
      ask: num(t.ask),
      bidSize: null,
      askSize: null,
      time: t.time ?? null,
    });
  }

  // One shared socket; each product tracks its quote and trade listeners.
  interface Watch {
    security: string;
    quotes: Set<(q: Quote) => void>;
    trades: Set<(t: Trade) => void>;
  }
  const watches = new Map<string, Watch>();
  let socket: WebSocket | null = null;

  const channels = () => {
    const ticker = [...watches].filter(([, w]) => w.quotes.size).map(([p]) => p);
    const matches = [...watches].filter(([, w]) => w.trades.size).map(([p]) => p);
    return [
      ...(ticker.length ? [{ name: "ticker", product_ids: ticker }] : []),
      ...(matches.length ? [{ name: "matches", product_ids: matches }] : []),
    ];
  };

  function send(type: "subscribe" | "unsubscribe", list: { name: string; product_ids: string[] }[]) {
    if (list.length && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type, channels: list }));
  }

  function ensureSocket() {
    if (socket) return;
    const ws = new WebSocket(wsUrl);
    socket = ws;
    ws.on("open", () => send("subscribe", channels()));
    ws.on("message", (raw) => {
      let msg: WsTicker | WsMatch | { type: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "ticker") {
        const m = msg as WsTicker;
        const w = watches.get(m.product_id);
        if (!w?.quotes.size) return;
        const q = cryptoQuote(w.security, m.product_id, {
          last: num(m.price),
          open24h: num(m.open_24h),
          high: num(m.high_24h),
          low: num(m.low_24h),
          volume: num(m.volume_24h),
          bid: num(m.best_bid),
          ask: num(m.best_ask),
          bidSize: num(m.best_bid_size),
          askSize: num(m.best_ask_size),
          time: m.time ?? null,
        });
        for (const l of w.quotes) l(q);
      } else if (msg.type === "match" || msg.type === "last_match") {
        const m = msg as WsMatch;
        const w = watches.get(m.product_id);
        if (!w?.trades.size) return;
        const t = matchToTrade(m);
        for (const l of w.trades) l(t);
      }
    });
    ws.on("close", () => {
      if (socket === ws) socket = null;
      if (watches.size) setTimeout(ensureSocket, reconnectMs).unref();
    });
    ws.on("error", (err) => console.error("coinbase ws", err.message));
  }

  function watch(security: string, kind: "quotes" | "trades", listener: ((q: Quote) => void) | ((t: Trade) => void)): () => void {
    const product = cryptoPair(security);
    const key = normalizeSecurity(security);
    if (!product || !key) return () => {};
    let w = watches.get(product);
    if (!w) watches.set(product, (w = { security: key, quotes: new Set(), trades: new Set() }));
    const set = w[kind] as Set<typeof listener>;
    const first = !set.size;
    set.add(listener);
    ensureSocket();
    if (first) send("subscribe", [{ name: kind === "quotes" ? "ticker" : "matches", product_ids: [product] }]);
    return () => {
      const cur = watches.get(product);
      if (!cur) return;
      const s = cur[kind] as Set<typeof listener>;
      if (!s.delete(listener) || s.size) return;
      send("unsubscribe", [{ name: kind === "quotes" ? "ticker" : "matches", product_ids: [product] }]);
      if (!cur.quotes.size && !cur.trades.size) watches.delete(product);
      if (!watches.size) {
        socket?.close();
        socket = null;
      }
    };
  }

  return {
    id: "coinbase",
    sectors: ["Curncy"],
    rateLimit: { perMinute: 500 },
    covers: (security) => cryptoPair(security) !== null,

    async quotes(securities) {
      const res = await Promise.all(securities.map((s) => restQuote(s)));
      return res.filter((q): q is Quote => !!q);
    },

    async history(security, interval, from, to) {
      const product = cryptoPair(security);
      const g = GRANULARITY[interval];
      if (!product || !g) return [];
      const span = CANDLES_PER_REQUEST * g * 1000;
      const pages = Math.ceil((to.getTime() - from.getTime()) / span);
      if (pages > MAX_PAGES) return [];
      const bars = new Map<number, Bar>();
      for (let start = from.getTime(); start < to.getTime(); start += span) {
        const end = Math.min(start + span, to.getTime());
        const rows = await get<number[][]>(
          `/products/${product}/candles?granularity=${g}&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`,
        );
        for (const [time, low, high, open, close, volume] of rows ?? []) {
          bars.set(time * 1000, { t: time * 1000, o: open, h: high, l: low, c: close, v: volume });
        }
      }
      return [...bars.values()].sort((a, b) => a.t - b.t);
    },

    subscribe(securities, onQuote) {
      const offs = securities.map((s) => {
        const off = watch(s, "quotes", onQuote);
        restQuote(s)
          .then((q) => q && onQuote(q))
          .catch((err) => console.error("coinbase snapshot", err.message));
        return off;
      });
      return () => offs.forEach((off) => off());
    },

    subscribeTrades(security, onTrade) {
      return watch(security, "trades", onTrade);
    },
  };
}
