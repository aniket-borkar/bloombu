import type { Quote } from "./api";
import type { Trade } from "../../server/src/types";
import { useConnection } from "./store/connection";
import { sourceTimeNs } from "../../server/src/sourceTime";
import { PublicCryptoStream, publicCryptoSymbol } from "./publicCrypto";

type Listener = (q: Quote) => void;
type MessageHandler = (msg: { type: string; [key: string]: unknown }) => void;
type TradeSnapshot = { type: "trades"; security: string; available: boolean; trades: Trade[] };

const MAX_BACKOFF_MS = 30_000;

/**
 * One shared WebSocket for the whole app: reference-counted quote subscriptions,
 * plus typed message channels (chat), with reconnect and backoff.
 */
export class QuoteStream {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private tradeSubscriptions = new Map<string, number>();
  private tradeSnapshots = new Map<string, TradeSnapshot>();
  private handlers = new Map<string, Set<MessageHandler>>();
  private openCallbacks = new Set<() => void>();
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private direct: PublicCryptoStream | null = null;
  private directStops = new Map<string, () => void>();
  private directActive = new Set<string>();
  private latest = new Map<string, Quote>();

  constructor(private url: () => string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Delivery route, independent of the quote's exchange or source age. */
  routeFor(security: string): "direct" | "relay" {
    return this.directActive.has(security) ? "direct" : "relay";
  }

  private get wanted(): boolean {
    return this.listeners.size > 0 || this.tradeSubscriptions.size > 0 || this.handlers.size > 0;
  }

  /** Share one trade feed across panels, retaining it until the last panel leaves. */
  subscribeTrades(security: string): () => void {
    const count = this.tradeSubscriptions.get(security) ?? 0;
    this.tradeSubscriptions.set(security, count + 1);
    if (!count) this.send({ op: "trades.sub", security });
    this.ensureSocket();
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const remaining = (this.tradeSubscriptions.get(security) ?? 1) - 1;
      if (remaining) this.tradeSubscriptions.set(security, remaining);
      else {
        this.tradeSubscriptions.delete(security);
        this.tradeSnapshots.delete(security);
        this.send({ op: "trades.unsub", security });
      }
    };
  }

  subscribe(security: string, listener: Listener): () => void {
    let set = this.listeners.get(security);
    if (!set) {
      set = new Set();
      this.listeners.set(security, set);
      this.send({ op: "sub", securities: [security] });
      this.watchDirect(security);
    }
    set.add(listener);
    const cached = this.latest.get(security);
    if (cached) listener(cached);
    this.ensureSocket();
    return () => {
      set.delete(listener);
      if (set.size || this.listeners.get(security) !== set) return;
      this.listeners.delete(security);
      this.directStops.get(security)?.();
      this.directStops.delete(security);
      this.directActive.delete(security);
      this.latest.delete(security);
      this.send({ op: "unsub", securities: [security] });
    };
  }

  /** Receive server messages of `type`, keeping the socket open while registered. */
  on(type: string, handler: MessageHandler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler);
    if (type === "trades") {
      for (const snapshot of this.tradeSnapshots.values()) handler(snapshot);
    }
    this.ensureSocket();
    return () => {
      set.delete(handler);
      if (!set.size && this.handlers.get(type) === set) this.handlers.delete(type);
    };
  }

  /** Run `fn` now if connected and again after every reconnect. */
  onOpen(fn: () => void): () => void {
    this.openCallbacks.add(fn);
    if (this.connected) fn();
    return () => {
      this.openCallbacks.delete(fn);
    };
  }

  /** Send an arbitrary message; returns false if the socket is not open. */
  send(msg: object): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  private publish(quote: Quote): boolean {
    if (!this.listeners.has(quote.security)) return false;
    const previous = this.latest.get(quote.security);
    const before = sourceTimeNs(previous?.time);
    const after = sourceTimeNs(quote.time);
    if (before !== null && (after === null || after < before)) return false;
    this.latest.set(quote.security, quote);
    for (const listener of this.listeners.get(quote.security) ?? []) listener(quote);
    return true;
  }

  private watchDirect(security: string): void {
    if (!this.direct || this.directStops.has(security) || !publicCryptoSymbol(security)) return;
    this.directStops.set(security, this.direct.subscribe(security, (quote) => {
      if (!this.listeners.has(security)) return;
      const previous = this.latest.get(security);
      const before = sourceTimeNs(previous?.time);
      const after = sourceTimeNs(quote.time);
      // A cached exchange snapshot must not replace a newer relay observation.
      if (before !== null && (after === null || after < before)) return;
      if (!this.directActive.has(security)) {
        this.directActive.add(security);
        this.send({ op: "unsub", securities: [security] });
      }
      this.publish(quote);
    }, () => {
      if (this.directActive.delete(security) && this.listeners.has(security)) this.send({ op: "sub", securities: [security] });
    }));
  }

  private configureDirect(enabled: boolean): void {
    if (enabled) {
      this.direct ??= new PublicCryptoStream();
      for (const security of this.listeners.keys()) this.watchDirect(security);
      return;
    }
    const active = [...this.directActive];
    this.directActive.clear();
    this.directStops.clear();
    this.direct?.close();
    this.direct = null;
    for (const security of active) if (this.listeners.has(security)) this.send({ op: "sub", securities: [security] });
  }

  private ensureSocket(): void {
    if (this.ws || this.reconnectTimer) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    useConnection.setState({ socket: "connecting" });

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempts = 0;
      useConnection.setState({ socket: "open" });
      const relayed = [...this.listeners.keys()].filter((security) => !this.directActive.has(security));
      if (relayed.length) this.send({ op: "sub", securities: relayed });
      for (const security of this.tradeSubscriptions.keys()) this.send({ op: "trades.sub", security });
      for (const fn of this.openCallbacks) fn();
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let msg: { type: string; quote?: Quote; security?: string; available?: boolean; trades?: Trade[]; trade?: Trade; directKraken?: unknown };
      try { msg = JSON.parse(e.data as string); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "stream.config") {
        this.configureDirect(msg.directKraken === true);
        return;
      }
      if (msg.type === "quote" && msg.quote) {
        if (!this.directActive.has(msg.quote.security)) this.publish(msg.quote);
        return;
      }
      if (msg.type === "trades" && msg.security && msg.trades && this.tradeSubscriptions.has(msg.security)) {
        this.tradeSnapshots.set(msg.security, { type: "trades", security: msg.security, available: !!msg.available, trades: msg.trades });
      } else if (msg.type === "trade" && msg.security && msg.trade) {
        const snapshot = this.tradeSnapshots.get(msg.security);
        if (snapshot) this.tradeSnapshots.set(msg.security, { ...snapshot, trades: [...snapshot.trades, msg.trade].slice(-500) });
      }
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.tradeSnapshots.clear();
      useConnection.setState({ socket: "closed" });
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wanted) this.ensureSocket();
      }, delay);
    };
    ws.onerror = () => { if (this.ws === ws) ws.close(); };
  }
}

export const quoteStream = new QuoteStream(
  () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
);
