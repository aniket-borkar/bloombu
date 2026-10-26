import type { Quote } from "./api";
import type { Trade } from "../../server/src/types";
import { useConnection } from "./store/connection";

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

  constructor(private url: () => string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
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
    }
    set.add(listener);
    this.ensureSocket();
    return () => {
      set.delete(listener);
      if (set.size || this.listeners.get(security) !== set) return;
      this.listeners.delete(security);
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

  private ensureSocket(): void {
    if (this.ws || this.reconnectTimer) return;
    const ws = new WebSocket(this.url());
    this.ws = ws;
    useConnection.setState({ socket: "connecting" });

    ws.onopen = () => {
      this.attempts = 0;
      useConnection.setState({ socket: "open" });
      if (this.listeners.size) this.send({ op: "sub", securities: [...this.listeners.keys()] });
      for (const security of this.tradeSubscriptions.keys()) this.send({ op: "trades.sub", security });
      for (const fn of this.openCallbacks) fn();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; quote?: Quote; security?: string; available?: boolean; trades?: Trade[]; trade?: Trade };
      if (msg.type === "quote" && msg.quote) {
        for (const l of this.listeners.get(msg.quote.security) ?? []) l(msg.quote);
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
      this.ws = null;
      this.tradeSnapshots.clear();
      useConnection.setState({ socket: "closed" });
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempts++);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (this.wanted) this.ensureSocket();
      }, delay);
    };
    ws.onerror = () => ws.close();
  }
}

export const quoteStream = new QuoteStream(
  () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
);
