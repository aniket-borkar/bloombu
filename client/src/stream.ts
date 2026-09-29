import type { Quote } from "./api";
import { useConnection } from "./store/connection";

type Listener = (q: Quote) => void;
type MessageHandler = (msg: { type: string; [key: string]: unknown }) => void;

const MAX_BACKOFF_MS = 30_000;

/**
 * One shared WebSocket for the whole app: reference-counted quote subscriptions,
 * plus typed message channels (chat), with reconnect and backoff.
 */
export class QuoteStream {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private handlers = new Map<string, Set<MessageHandler>>();
  private openCallbacks = new Set<() => void>();
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: () => string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private get wanted(): boolean {
    return this.listeners.size > 0 || this.handlers.size > 0;
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
      for (const fn of this.openCallbacks) fn();
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as { type: string; quote?: Quote };
      if (msg.type === "quote" && msg.quote) {
        for (const l of this.listeners.get(msg.quote.security) ?? []) l(msg.quote);
        return;
      }
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    };
    ws.onclose = () => {
      this.ws = null;
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
