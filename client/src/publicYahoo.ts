import { sourceTimeNs } from "../../server/src/sourceTime";
import { normalizeSecurity, toYahoo } from "../../server/src/symbology";
import { applyYahooTick, decodeYahooPricingMessage, mergeYahooSeed, yahooQuoteTime, YAHOO_MAX_FRAME } from "../../server/src/providers/yahooWire";
import type { Quote } from "./api";

export const PUBLIC_YAHOO_URL = "wss://streamer.finance.yahoo.com/?version=2";
export const YAHOO_DIRECT_IDLE_MS = 8_000;
type Listener = { onQuote: (quote: Quote) => void; onUnavailable: () => void };
interface Watch { symbol: string; listeners: Set<Listener>; receivedAt: number; live: boolean }

export function publicYahooSymbol(security: string): string | null {
  return normalizeSecurity(security) ? toYahoo(security) : null;
}

/** The caller must authorize each security through the server's provider policy first. */
export class PublicYahooStream {
  private watches = new Map<string, Watch>();
  private latest = new Map<string, Quote>();
  private native = new Set<string>();
  private socket: WebSocket | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private handshake: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = false;

  /** Store REST/relay metadata without republishing or rewinding a native tick. */
  seed(incoming: Quote): void {
    const security = normalizeSecurity(incoming.security);
    if (!security || !publicYahooSymbol(security) || this.stopped) return;
    const previous = this.latest.get(security);
    if (!previous || yahooQuoteTime(incoming) > yahooQuoteTime(previous)) this.native.delete(security);
    this.latest.set(security, mergeYahooSeed({ ...incoming, security }, previous, this.native.has(security)));
    if (this.latest.size > 1024) for (const key of this.latest.keys()) {
      if (!this.watches.has(key)) { this.latest.delete(key); this.native.delete(key); }
      if (this.latest.size <= 1024) break;
    }
  }

  subscribe(input: string, onQuote: Listener["onQuote"], onUnavailable: Listener["onUnavailable"]): () => void {
    const security = normalizeSecurity(input);
    const symbol = publicYahooSymbol(input);
    if (!security || !symbol || this.stopped) return () => {};
    let watch = this.watches.get(security);
    if (!watch) {
      const first = ![...this.watches.values()].some((value) => value.symbol === symbol);
      this.watches.set(security, (watch = { symbol, listeners: new Set(), receivedAt: performance.now(), live: false }));
      if (first) this.send("subscribe", [symbol]);
    }
    const listener = { onQuote, onUnavailable };
    watch.listeners.add(listener);
    this.connect();
    if (!this.watchdog) this.watchdog = setInterval(() => {
      const now = performance.now();
      for (const value of this.watches.values()) if (value.live && now - value.receivedAt >= YAHOO_DIRECT_IDLE_MS) this.unavailable(value);
    }, 1000);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.watches.get(security) !== watch || !watch.listeners.delete(listener) || watch.listeners.size) return;
      this.watches.delete(security);
      this.latest.delete(security);
      this.native.delete(security);
      if (![...this.watches.values()].some((value) => value.symbol === symbol)) this.send("unsubscribe", [symbol]);
      if (!this.watches.size) this.stopSocket();
    };
  }

  close(): void {
    this.stopped = true;
    this.watches.clear();
    this.latest.clear();
    this.native.clear();
    this.stopSocket();
  }

  private symbols(): string[] { return [...new Set([...this.watches.values()].map((watch) => watch.symbol))]; }

  private unavailable(watch: Watch): void {
    if (!watch.live) return;
    watch.live = false;
    for (const listener of watch.listeners) listener.onUnavailable();
  }

  private send(operation: "subscribe" | "unsubscribe", symbols: string[]): void {
    if (this.socket?.readyState === WebSocket.OPEN && symbols.length) this.socket.send(JSON.stringify({ [operation]: symbols }));
  }

  private connect(): void {
    if (this.socket || this.reconnect || !this.watches.size || this.stopped) return;
    let ws: WebSocket;
    try { ws = new WebSocket(PUBLIC_YAHOO_URL); }
    catch { this.scheduleReconnect(); return; }
    this.socket = ws;
    this.handshake = setTimeout(() => {
      this.handshake = null;
      if (this.socket === ws && ws.readyState !== WebSocket.OPEN) ws.close();
    }, YAHOO_DIRECT_IDLE_MS);
    ws.onopen = () => {
      if (this.socket !== ws) return;
      if (this.handshake) clearTimeout(this.handshake);
      this.handshake = null;
      this.send("subscribe", this.symbols());
      this.heartbeat = setInterval(() => this.send("subscribe", this.symbols()), 15_000);
    };
    ws.onmessage = (event) => {
      if (this.socket !== ws || typeof event.data !== "string" || event.data.length > YAHOO_MAX_FRAME) return;
      let frame: unknown;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!frame || typeof frame !== "object" || !("message" in frame) || typeof frame.message !== "string") return;
      const tick = decodeYahooPricingMessage(frame.message);
      if (!tick) return;
      const time = sourceTimeNs(tick.time)!;
      for (const [security, watch] of this.watches) {
        if (watch.symbol !== tick.id) continue;
        const previous = this.latest.get(security);
        if (previous && time < yahooQuoteTime(previous)) continue;
        const quote = applyYahooTick(security, tick, previous);
        this.latest.set(security, quote);
        this.native.add(security);
        watch.receivedAt = performance.now();
        watch.live = true;
        this.attempts = 0;
        for (const listener of watch.listeners) listener.onQuote(quote);
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.stopConnectionTimers();
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
    }, Math.min(30_000, 1000 * 2 ** Math.min(this.attempts++, 5)));
  }

  private stopConnectionTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.handshake) clearTimeout(this.handshake);
    this.heartbeat = this.handshake = null;
  }

  private stopSocket(): void {
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.watchdog) clearInterval(this.watchdog);
    this.reconnect = this.watchdog = null;
    this.stopConnectionTimers();
    const previous = this.socket;
    this.socket = null;
    previous?.close();
    this.attempts = 0;
  }
}
