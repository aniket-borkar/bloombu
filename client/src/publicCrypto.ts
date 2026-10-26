import { sourceTimeNs } from "../../server/src/sourceTime";
import { cryptoPair } from "../../server/src/symbology";
import type { Quote } from "./api";

export const PUBLIC_KRAKEN_URL = "wss://ws.kraken.com/v2";
export const DIRECT_IDLE_MS = 8_000;
const NAMES: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const positive = (v: unknown): number | null => { const n = number(v); return n !== null && n > 0 ? n : null; };
const size = (v: unknown): number | null => { const n = number(v); return n !== null && n >= 0 ? n : null; };

/** The same nine public pairs covered by the configured server Kraken adapter. */
export function publicCryptoSymbol(security: string): string | null {
  const pair = cryptoPair(security);
  if (!pair) return null;
  const [base, currency] = pair.split("-");
  return NAMES[base] && ["USD", "EUR", "GBP"].includes(currency) ? `${base}/${currency}` : null;
}

export function publicCryptoQuote(raw: unknown, security: string): Quote | null {
  const data = object(raw);
  const symbol = publicCryptoSymbol(security);
  const last = positive(data.last);
  const at = typeof data.timestamp === "string" && sourceTimeNs(data.timestamp) !== null ? data.timestamp : null;
  if (!symbol || data.symbol !== symbol || last === null || at === null) return null;
  const [base, currency] = symbol.split("/");
  const change = number(data.change);
  const reference = change !== null ? last - change : null;
  return {
    security, name: `${NAMES[base]} ${currency}`, last, change, changePct: number(data.change_pct),
    bid: positive(data.bid), ask: positive(data.ask), bidSize: size(data.bid_qty), askSize: size(data.ask_qty),
    open: null, high: positive(data.high), low: positive(data.low), volume: size(data.volume),
    prevClose: reference !== null && reference > 0 ? reference : null,
    currency, exchange: "Kraken", marketState: "REGULAR", time: at, delayMinutes: 0, source: "Kraken",
  };
}

interface Watch {
  symbol: string;
  onQuote: (quote: Quote) => void;
  onUnavailable: () => void;
  time: bigint | null;
  receivedAt: number;
  live: boolean;
}

/** One public connection for direct quote delivery; timers only detect failure. */
export class PublicCryptoStream {
  private watches = new Map<string, Watch>();
  private socket: WebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private attempts = 0;
  private stopped = false;

  subscribe(security: string, onQuote: Watch["onQuote"], onUnavailable: Watch["onUnavailable"]): () => void {
    const symbol = publicCryptoSymbol(security);
    if (!symbol || this.stopped) return () => {};
    const first = ![...this.watches.values()].some((w) => w.symbol === symbol);
    const watch: Watch = { symbol, onQuote, onUnavailable, time: null, receivedAt: performance.now(), live: false };
    this.watches.set(security, watch);
    if (first) this.send("subscribe", [symbol]);
    this.connect();
    if (!this.watchdog) this.watchdog = setInterval(() => {
      const now = performance.now();
      for (const value of this.watches.values()) {
        if (value.live && now - value.receivedAt >= DIRECT_IDLE_MS) this.unavailable(value);
      }
    }, 1000);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.watches.get(security) !== watch) return;
      this.watches.delete(security);
      if (![...this.watches.values()].some((w) => w.symbol === symbol)) this.send("unsubscribe", [symbol]);
      if (!this.watches.size) this.stopSocket();
    };
  }

  close(): void {
    this.stopped = true;
    this.watches.clear();
    this.stopSocket();
  }

  private unavailable(watch: Watch): void {
    if (!watch.live) return;
    watch.live = false;
    watch.onUnavailable();
  }

  private send(method: "subscribe" | "unsubscribe", symbols: string[]): void {
    if (this.socket?.readyState !== WebSocket.OPEN || !symbols.length) return;
    this.socket.send(JSON.stringify({ method, params: {
      channel: "ticker", symbol: symbols, event_trigger: "trades", ...(method === "subscribe" ? { snapshot: true } : {}),
    } }));
  }

  private connect(): void {
    if (this.socket || this.reconnect || !this.watches.size || this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(PUBLIC_KRAKEN_URL); }
    catch { this.scheduleReconnect(); return; }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.send("subscribe", [...new Set([...this.watches.values()].map((w) => w.symbol))]);
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || typeof event.data !== "string") return;
      let message: Record<string, unknown>;
      try { message = object(JSON.parse(event.data)); } catch { return; }
      if (message.success === false) {
        const symbol = object(message.result).symbol;
        for (const value of this.watches.values()) if (!symbol || value.symbol === symbol) this.unavailable(value);
        return;
      }
      if (message.channel !== "ticker" || !Array.isArray(message.data)) return;
      for (const data of message.data) {
        const symbol = object(data).symbol;
        for (const [security, watch] of this.watches) {
          if (watch.symbol !== symbol) continue;
          const quote = publicCryptoQuote(data, security);
          if (!quote) continue;
          const at = sourceTimeNs(quote.time)!;
          if (watch.time !== null && at < watch.time) continue;
          watch.time = at;
          watch.receivedAt = performance.now();
          watch.live = true;
          this.attempts = 0;
          watch.onQuote(quote);
        }
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      for (const watch of this.watches.values()) this.unavailable(watch);
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      if (this.socket !== ws) return;
      for (const watch of this.watches.values()) this.unavailable(watch);
      ws.close();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnect || !this.watches.size || this.stopped) return;
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, Math.min(30_000, 1000 * 2 ** this.attempts++));
  }

  private stopSocket(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnect = this.watchdog = null;
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    this.attempts = 0;
  }
}
