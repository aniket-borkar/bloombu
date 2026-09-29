import WebSocket from "ws";
import type { ProviderPlugin } from "./DataProvider.js";
import type { Quote, SearchResult, Trade } from "../types.js";
import { fromYahoo, normalizeSecurity, parseSecurity, toYahoo } from "../symbology.js";

const BASE = "https://finnhub.io/api/v1";
const WS_URL = "wss://ws.finnhub.io";
const US_EXCHANGES = new Set(["US", "UN", "UW", "UQ", "UA", "UP"]);

interface FinnhubQuote {
  c: number;
  d: number | null;
  dp: number | null;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

/** Finnhub's free tier covers US equities, so only those are routed here. */
function usSymbol(security: string): string | null {
  const p = parseSecurity(security);
  if (!p || p.sector !== "Equity" || (p.exchange && !US_EXCHANGES.has(p.exchange))) return null;
  return toYahoo(security);
}

function toQuote(security: string, q: FinnhubQuote): Quote {
  return {
    security,
    name: security,
    last: q.c,
    change: q.d,
    changePct: q.dp,
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    open: q.o,
    high: q.h,
    low: q.l,
    prevClose: q.pc,
    volume: null,
    currency: "USD",
    exchange: null,
    marketState: null,
    time: new Date(q.t * 1000).toISOString(),
    delayMinutes: 0,
    source: "Finnhub",
  };
}

export function createFinnhubProvider(apiKey: string): ProviderPlugin {
  async function get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", apiKey);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Finnhub ${res.status}`);
    return (await res.json()) as T;
  }

  async function quote(security: string): Promise<Quote | null> {
    const symbol = usSymbol(security);
    const key = normalizeSecurity(security);
    if (!symbol || !key) return null;
    const q = await get<FinnhubQuote>("/quote", { symbol });
    return q && q.t ? toQuote(key, q) : null;
  }

  // One shared trade socket; each symbol maps to the listeners and last snapshot for it.
  let socket: WebSocket | null = null;
  const watchers = new Map<string, { security: string; base: Quote | null; listeners: Set<(q: Quote) => void> }>();
  const tapes = new Map<string, Set<(t: Trade) => void>>();
  const watched = (symbol: string) => watchers.has(symbol) || tapes.has(symbol);

  function ensureSocket() {
    if (socket) return;
    socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(apiKey)}`);
    socket.on("open", () => {
      for (const symbol of new Set([...watchers.keys(), ...tapes.keys()])) socket?.send(JSON.stringify({ type: "subscribe", symbol }));
    });
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { type: string; data?: { s: string; p: number; t: number; v?: number }[] };
      if (msg.type !== "trade" || !msg.data) return;
      for (const trade of msg.data) {
        for (const l of tapes.get(trade.s) ?? []) {
          l({ time: new Date(trade.t).toISOString(), price: trade.p, size: trade.v ?? null, side: null, venue: null });
        }
        const w = watchers.get(trade.s);
        if (!w?.base) continue;
        const prev = w.base.prevClose;
        const q: Quote = {
          ...w.base,
          last: trade.p,
          change: prev !== null ? trade.p - prev : null,
          changePct: prev ? ((trade.p - prev) / prev) * 100 : null,
          high: Math.max(w.base.high ?? trade.p, trade.p),
          low: Math.min(w.base.low ?? trade.p, trade.p),
          time: new Date(trade.t).toISOString(),
        };
        w.base = q;
        for (const l of w.listeners) l(q);
      }
    });
    socket.on("close", () => {
      socket = null;
      if (watchers.size || tapes.size) setTimeout(ensureSocket, 5000);
    });
    socket.on("error", (err) => console.error("finnhub ws", err.message));
  }

  return {
    id: "finnhub",
    requiresKey: "FINNHUB_API_KEY",
    sectors: ["Equity"],
    rateLimit: { perMinute: 55 },

    async quotes(securities) {
      const res = await Promise.all(securities.map((s) => quote(s)));
      return res.filter((q): q is Quote => !!q);
    },

    async search(query) {
      const res = await get<{ result?: { symbol: string; description: string; type: string }[] }>("/search", {
        q: query,
      });
      return (res.result ?? []).flatMap((r): SearchResult[] => {
        if (r.type !== "Common Stock" && r.type !== "ETP") return [];
        const security = fromYahoo(r.symbol, "EQUITY");
        return security ? [{ security, name: r.description, sector: "Equity", exchange: null }] : [];
      });
    },

    subscribe(securities, onQuote) {
      const symbols: string[] = [];
      for (const security of securities) {
        const symbol = usSymbol(security);
        const key = normalizeSecurity(security);
        if (!symbol || !key) continue;
        symbols.push(symbol);
        let w = watchers.get(symbol);
        if (!w) {
          w = { security: key, base: null, listeners: new Set() };
          watchers.set(symbol, w);
          const entry = w;
          quote(key)
            .then((q) => {
              if (!q) return;
              entry.base = q;
              for (const l of entry.listeners) l(q);
            })
            .catch((err) => console.error("finnhub snapshot", err.message));
          if (!tapes.has(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", symbol }));
        }
        w.listeners.add(onQuote);
      }
      ensureSocket();
      return () => {
        for (const symbol of symbols) {
          const w = watchers.get(symbol);
          if (!w) continue;
          w.listeners.delete(onQuote);
          if (w.listeners.size) continue;
          watchers.delete(symbol);
          if (!watched(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", symbol }));
        }
        if (!watchers.size && !tapes.size) socket?.close();
      };
    },

    subscribeTrades(security, onTrade) {
      const symbol = usSymbol(security);
      if (!symbol) return () => {};
      let set = tapes.get(symbol);
      if (!set) {
        const fresh = !watched(symbol);
        tapes.set(symbol, (set = new Set()));
        if (fresh && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", symbol }));
      }
      set.add(onTrade);
      ensureSocket();
      return () => {
        const cur = tapes.get(symbol);
        if (!cur?.delete(onTrade) || cur.size) return;
        tapes.delete(symbol);
        if (!watched(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", symbol }));
        if (!watchers.size && !tapes.size) socket?.close();
      };
    },
  };
}
