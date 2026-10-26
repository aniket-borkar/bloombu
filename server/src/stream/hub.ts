import type { ProviderPlugin } from "../providers/DataProvider.js";
import { sourceTimeNs } from "../sourceTime.js";
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
export const DEFAULT_NATIVE_STALE_MS = 15_000;

const CHANGE_FIELDS = ["name", "last", "change", "changePct", "bid", "ask", "bidSize", "askSize", "open", "high", "low", "prevClose", "volume", "time", "marketState", "source", "delayMinutes", "currency", "exchange"] as const;

function changed(a: Quote, b: Quote): boolean {
  return CHANGE_FIELDS.some((f) => a[f] !== b[f]);
}

const timestamp = (q: Quote): bigint | null => sourceTimeNs(q.time);
const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);

export interface StreamHubOptions {
  now?: () => number;
  /** Request REST snapshots after this much native-feed silence, including quiet markets. */
  nativeStaleMs?: number;
}

interface NativeSubscription {
  unsubscribe: () => void;
  lastReceivedAt: number;
}

/**
 * Fans live quotes out to WebSocket clients. Subscriptions are reference-counted
 * across clients, so each distinct security is fetched once per tick no matter
 * how many clients watch it. Native push avoids regular polling while updates
 * arrive; quiet feeds also receive REST snapshots until native updates resume.
 */
export class StreamHub {
  private clients = new Map<StreamClient, Set<string>>();
  private counts = new Map<string, number>();
  private last = new Map<string, Quote>();
  private native = new Map<string, NativeSubscription>();
  private sessions = new Map<string, object>();
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private now: () => number;
  private nativeStaleMs: number;

  constructor(
    private source: QuoteSource,
    private intervalMs: number,
    private log: (msg: string) => void = console.error,
    options: StreamHubOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.nativeStaleMs = options.nativeStaleMs ?? DEFAULT_NATIVE_STALE_MS;
  }

  connect(client: StreamClient): void {
    if (this.closed) return;
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
    if (this.closed) return;
    const list = [...new Set(keys ?? this.counts.keys())].filter((key) => {
      const native = this.native.get(key);
      return this.counts.has(key) && !this.inFlight.has(key)
        && (!native || this.now() - native.lastReceivedAt >= this.nativeStaleMs);
    });
    if (!list.length) return;
    const sessions = new Map(list.map((key) => [key, this.sessions.get(key)]));
    const before = new Map(list.map((key) => [key, this.last.get(key)]));
    for (const key of list) this.inFlight.add(key);
    try {
      for (const q of await this.source.quotes(list)) {
        if (!sessions.has(q.security) || this.sessions.get(q.security) !== sessions.get(q.security)) continue;
        const current = this.last.get(q.security);
        // A native update received while REST was in flight wins unless the
        // snapshot has a provably later market timestamp.
        if (current && current !== before.get(q.security)) {
          const currentTime = timestamp(current);
          const nextTime = timestamp(q);
          if (currentTime === null || nextTime === null || nextTime <= currentTime) continue;
        }
        this.publish(q);
      }
    } catch (err) {
      this.log(`stream poll failed: ${errorMessage(err)}`);
    } finally {
      for (const key of list) this.inFlight.delete(key);
    }
  }

  stats(): { clients: number; securities: number } {
    return { clients: this.clients.size, securities: this.counts.size };
  }

  subscriberCount(security: string): number {
    return this.counts.get(security) ?? 0;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const key of this.native.keys()) this.stopNative(key);
    this.clients.clear();
    this.counts.clear();
    this.sessions.clear();
    this.last.clear();
  }

  private retain(key: string): void {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    if (n > 1) return;
    this.sessions.set(key, {});
    try {
      const plugin = this.source.streamingPlugin(key);
      if (plugin?.subscribe) {
        const native: NativeSubscription = { unsubscribe: () => {}, lastReceivedAt: this.now() };
        this.native.set(key, native);
        const unsubscribe = plugin.subscribe([key], (q) => {
          if (q.security !== key || this.native.get(key) !== native) return;
          native.lastReceivedAt = this.now();
          this.publish(q);
        });
        if (this.native.get(key) === native) native.unsubscribe = unsubscribe;
        else unsubscribe();
      }
    } catch (err) {
      this.native.delete(key);
      this.log(`stream subscribe failed for ${key}: ${errorMessage(err)}`);
    }
    if (!this.timer) this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  private release(key: string): void {
    const n = (this.counts.get(key) ?? 0) - 1;
    if (n > 0) {
      this.counts.set(key, n);
      return;
    }
    this.counts.delete(key);
    this.sessions.delete(key);
    this.last.delete(key);
    this.stopNative(key);
    if (!this.counts.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stopNative(key: string): void {
    const native = this.native.get(key);
    this.native.delete(key);
    try { native?.unsubscribe(); }
    catch (err) { this.log(`stream unsubscribe failed for ${key}: ${errorMessage(err)}`); }
  }

  private publish(q: Quote): void {
    if (this.closed || !this.counts.has(q.security)) return;
    const prev = this.last.get(q.security);
    if (prev) {
      const prevTime = timestamp(prev);
      const nextTime = timestamp(q);
      if (prevTime !== null && (nextTime === null || nextTime < prevTime)) return;
      if (!changed(prev, q)) return;
    }
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
