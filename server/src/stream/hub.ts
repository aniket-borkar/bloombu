import type { ProviderPlugin } from "../providers/DataProvider.js";
import { normalizeSecurity } from "../symbology.js";
import type { Quote } from "../types.js";

export interface StreamClient {
  send(data: string): void;
}

export interface QuoteSource {
  quotes(securities: string[]): Promise<Quote[]>;
  streamingPlugin(security: string): ProviderPlugin | null;
}

export type ClientMessage = { op: "sub" | "unsub"; securities: string[] };
export type ServerMessage = { type: "quote"; quote: Quote } | { type: "error"; message: string };

const MAX_SUBSCRIPTIONS_PER_CLIENT = 200;

const CHANGE_FIELDS = ["last", "change", "bid", "ask", "bidSize", "askSize", "high", "low", "volume", "time", "marketState"] as const;

function changed(a: Quote, b: Quote): boolean {
  return CHANGE_FIELDS.some((f) => a[f] !== b[f]);
}

/**
 * Fans live quotes out to WebSocket clients. Subscriptions are reference-counted
 * across clients, so each distinct security is fetched once per tick no matter
 * how many clients watch it. Securities whose provider supports native push are
 * subscribed upstream instead of polled.
 */
export class StreamHub {
  private clients = new Map<StreamClient, Set<string>>();
  private counts = new Map<string, number>();
  private last = new Map<string, Quote>();
  private native = new Map<string, () => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(
    private source: QuoteSource,
    private intervalMs: number,
    private log: (msg: string) => void = console.error,
  ) {}

  connect(client: StreamClient): void {
    this.clients.set(client, new Set());
  }

  disconnect(client: StreamClient): void {
    const subs = this.clients.get(client);
    if (!subs) return;
    this.clients.delete(client);
    for (const s of subs) this.release(s);
  }

  handleMessage(client: StreamClient, raw: string): void {
    const subs = this.clients.get(client);
    if (!subs) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(client, { type: "error", message: "invalid JSON" });
    }
    if (
      !msg ||
      (msg.op !== "sub" && msg.op !== "unsub") ||
      !Array.isArray(msg.securities) ||
      !msg.securities.every((s) => typeof s === "string")
    ) {
      return this.send(client, { type: "error", message: 'expected {"op":"sub"|"unsub","securities":[...]}' });
    }

    const fresh: string[] = [];
    for (const s of msg.securities) {
      const key = normalizeSecurity(s);
      if (!key) continue;
      if (msg.op === "sub") {
        if (subs.has(key)) continue;
        if (subs.size >= MAX_SUBSCRIPTIONS_PER_CLIENT) {
          this.send(client, { type: "error", message: `subscription limit of ${MAX_SUBSCRIPTIONS_PER_CLIENT} reached` });
          break;
        }
        subs.add(key);
        this.retain(key);
        const cached = this.last.get(key);
        if (cached) this.send(client, { type: "quote", quote: cached });
        else fresh.push(key);
      } else if (subs.delete(key)) {
        this.release(key);
      }
    }
    if (fresh.length) void this.poll(fresh);
  }

  /** Fetch and publish quotes for `keys`, or for every polled subscription on a timer tick. */
  async poll(keys?: string[]): Promise<void> {
    const tick = !keys;
    if (tick && this.polling) return;
    const list = (keys ?? [...this.counts.keys()]).filter((k) => this.counts.has(k) && !this.native.has(k));
    if (!list.length) return;
    if (tick) this.polling = true;
    try {
      for (const q of await this.source.quotes(list)) this.publish(q);
    } catch (err) {
      this.log(`stream poll failed: ${(err as Error).message}`);
    } finally {
      if (tick) this.polling = false;
    }
  }

  stats(): { clients: number; securities: number } {
    return { clients: this.clients.size, securities: this.counts.size };
  }

  subscriberCount(security: string): number {
    return this.counts.get(security) ?? 0;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const unsub of this.native.values()) unsub();
    this.native.clear();
  }

  private retain(key: string): void {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n > 1) return;
    const plugin = this.source.streamingPlugin(key);
    if (plugin?.subscribe) this.native.set(key, plugin.subscribe([key], (q) => this.publish(q)));
    if (!this.timer) this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  private release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) {
      this.counts.set(key, n);
      return;
    }
    this.counts.delete(key);
    this.last.delete(key);
    this.native.get(key)?.();
    this.native.delete(key);
    if (!this.counts.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private publish(q: Quote): void {
    if (!this.counts.has(q.security)) return;
    const prev = this.last.get(q.security);
    if (prev && !changed(prev, q)) return;
    this.last.set(q.security, q);
    const msg = JSON.stringify({ type: "quote", quote: q } satisfies ServerMessage);
    for (const [client, subs] of this.clients) {
      if (subs.has(q.security)) client.send(msg);
    }
  }

  private send(client: StreamClient, msg: ServerMessage): void {
    client.send(JSON.stringify(msg));
  }
}
