import WebSocket from "ws";
import type { ProviderPlugin } from "./DataProvider.js";
import type { Quote, SearchResult, Trade } from "../types.js";
import { fromYahoo, normalizeSecurity, parseSecurity, toYahoo } from "../symbology.js";
import { RateLimited, UsageMeter } from "./usage.js";

const BASE = "https://finnhub.io/api/v1";
const WS_URL = "wss://ws.finnhub.io";
const US_EXCHANGES = new Set(["US", "UN", "UW", "UQ", "UA", "UP"]);
const RATE_LIMIT = { perMinute: 55 };

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

const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const positive = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
};
const isoTime = (milliseconds: unknown): string | null => {
  const n = positive(milliseconds);
  return n !== null && Number.isFinite(new Date(n).getTime()) ? new Date(n).toISOString() : null;
};
const tradingDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

function toQuote(security: string, q: Partial<FinnhubQuote>): Quote {
  return {
    security,
    name: security,
    last: positive(q.c),
    change: finite(q.d),
    changePct: finite(q.dp),
    bid: null,
    ask: null,
    bidSize: null,
    askSize: null,
    open: positive(q.o),
    high: positive(q.h),
    low: positive(q.l),
    prevClose: positive(q.pc),
    volume: null,
    currency: "USD",
    exchange: null,
    marketState: null,
    time: isoTime((q.t ?? 0) * 1000),
    delayMinutes: 0,
    source: "Finnhub",
  };
}

/** An older REST snapshot may enrich today's fields without rewinding a live trade. */
function mergeSnapshot(base: Quote | null, snapshot: Quote): Quote {
  if (!base || !base.time || (snapshot.time && Date.parse(snapshot.time) > Date.parse(base.time))) return snapshot;
  if (!snapshot.time || tradingDate.format(new Date(snapshot.time)) !== tradingDate.format(new Date(base.time))) return base;
  const prevClose = snapshot.prevClose ?? base.prevClose;
  const high = snapshot.high ?? base.high;
  const low = snapshot.low ?? base.low;
  const last = base.last;
  const change = last !== null && prevClose !== null ? last - prevClose : null;
  return {
    ...snapshot,
    last,
    time: base.time,
    prevClose,
    change,
    changePct: change !== null && prevClose ? change / prevClose * 100 : null,
    high: high !== null && last !== null ? Math.max(high, base.high ?? high, last) : high,
    low: low !== null && last !== null ? Math.min(low, base.low ?? low, last) : low,
    open: snapshot.open ?? base.open,
  };
}

export interface FinnhubOptions {
  wsUrl?: string;
  reconnectMs?: number;
}

export function createFinnhubProvider(apiKey: string, options: FinnhubOptions = {}): ProviderPlugin {
  let meter = new UsageMeter();

  async function get<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("token", apiKey);
    return meter.run("finnhub", RATE_LIMIT, async () => {
      const timeout = AbortSignal.timeout(10_000);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!res.ok) throw new Error(`Finnhub ${res.status}`);
      return (await res.json()) as T;
    });
  }

  async function quote(security: string, signal?: AbortSignal): Promise<Quote | null> {
    const symbol = usSymbol(security);
    const key = normalizeSecurity(security);
    if (!symbol || !key) return null;
    const q = await get<FinnhubQuote>("/quote", { symbol }, signal);
    if (!q || positive(q.c) === null || !isoTime(q.t * 1000)) return null;
    return toQuote(key, q);
  }

  // One shared trade socket; each symbol maps to the listeners and last snapshot for it.
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const watchers = new Map<string, { security: string; base: Quote | null; listeners: Set<(q: Quote) => void>; retry?: ReturnType<typeof setTimeout>; request?: AbortController; refresh?: () => void }>();
  const tapes = new Map<string, Set<(t: Trade) => void>>();
  const watched = (symbol: string) => watchers.has(symbol) || tapes.has(symbol);
  const wanted = () => watchers.size > 0 || tapes.size > 0;

  function stopWhenIdle() {
    if (wanted()) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const previous = socket;
    socket = null;
    previous?.close();
  }

  function ensureSocket() {
    if (socket || !wanted()) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    const url = new URL(options.wsUrl ?? WS_URL);
    url.searchParams.set("token", apiKey);
    const ws = new WebSocket(url);
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws || !wanted()) return ws.close();
      for (const symbol of new Set([...watchers.keys(), ...tapes.keys()])) ws.send(JSON.stringify({ type: "subscribe", symbol }));
    });
    ws.on("message", (raw) => {
      if (socket !== ws) return;
      let msg: { type?: unknown; data?: unknown } | null;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!msg || msg.type !== "trade" || !Array.isArray(msg.data)) return;
      for (const value of msg.data) {
        if (!value || typeof value !== "object") continue;
        const trade = value as { s?: unknown; p?: unknown; t?: unknown; v?: unknown };
        const time = isoTime(trade.t);
        const price = positive(trade.p);
        if (typeof trade.s !== "string" || !time || price === null) continue;
        const volume = finite(trade.v);
        for (const l of tapes.get(trade.s) ?? []) {
          l({ time, price, size: volume !== null && volume >= 0 ? volume : null, side: null, venue: null });
        }
        const w = watchers.get(trade.s);
        if (!w) continue;
        const base = w.base ?? toQuote(w.security, {});
        if (base.time && Date.parse(time) < Date.parse(base.time)) continue;
        const sameDay = !base.time || tradingDate.format(new Date(base.time)) === tradingDate.format(new Date(time));
        const current = sameDay ? base : toQuote(w.security, {});
        if (!sameDay && !w.request && !w.retry) w.refresh?.();
        const prev = current.prevClose;
        const q: Quote = {
          ...current,
          last: price,
          change: prev !== null ? price - prev : null,
          changePct: prev ? ((price - prev) / prev) * 100 : null,
          high: current.high !== null ? Math.max(current.high, price) : null,
          low: current.low !== null ? Math.min(current.low, price) : null,
          time,
        };
        w.base = q;
        for (const l of w.listeners) l(q);
      }
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (wanted() && !reconnectTimer) {
        reconnectTimer = setTimeout(() => { reconnectTimer = null; ensureSocket(); }, options.reconnectMs ?? 5000);
        reconnectTimer.unref();
      }
    });
    ws.on("error", (err) => { if (socket === ws && wanted()) console.error("finnhub ws", err.message); });
  }

  return {
    id: "finnhub",
    requiresKey: "FINNHUB_API_KEY",
    sectors: ["Equity"],
    covers: (security) => usSymbol(security) !== null,
    rateLimit: RATE_LIMIT,
    setUsageMeter: (next) => { meter = next; },

    async quotes(securities) {
      const res = await Promise.allSettled(securities.map((s) => quote(s)));
      // Keep successful symbols when the remaining requests exhaust the budget;
      // omitted symbols can then be supplied by the next provider.
      if (res.length && res.every((r) => r.status === "rejected")) throw (res[0] as PromiseRejectedResult).reason;
      return res.flatMap((r) => r.status === "fulfilled" && r.value ? [r.value] : []);
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
          const retry = () => {
            if (watchers.get(symbol) !== entry) return;
            entry.retry = setTimeout(snapshot, 5000);
            entry.retry.unref();
          };
          const snapshot = () => {
            entry.retry = undefined;
            if (watchers.get(symbol) !== entry) return;
            const request = new AbortController();
            entry.request = request;
            void quote(key, request.signal)
              .then((q) => {
                if (watchers.get(symbol) !== entry) return;
                if (!q) return retry();
                entry.base = mergeSnapshot(entry.base, q);
                for (const l of entry.listeners) l(entry.base);
              })
              .catch((err) => {
                if (request.signal.aborted) return;
                if (!(err instanceof RateLimited)) console.error("finnhub snapshot", err instanceof Error ? err.message : String(err));
                retry();
              }).finally(() => { if (entry.request === request) entry.request = undefined; });
          };
          entry.refresh = snapshot;
          snapshot();
          if (!tapes.has(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", symbol }));
        }
        w.listeners.add(onQuote);
      }
      ensureSocket();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        for (const symbol of symbols) {
          const w = watchers.get(symbol);
          if (!w) continue;
          w.listeners.delete(onQuote);
          if (w.listeners.size) continue;
          if (w.retry) clearTimeout(w.retry);
          w.request?.abort();
          watchers.delete(symbol);
          if (!watched(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", symbol }));
        }
        stopWhenIdle();
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
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const cur = tapes.get(symbol);
        if (!cur?.delete(onTrade) || cur.size) return;
        tapes.delete(symbol);
        if (!watched(symbol) && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", symbol }));
        stopWhenIdle();
      };
    },
  };
}
