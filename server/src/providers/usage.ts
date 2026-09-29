/** Free-tier request budget a provider must stay under. */
export interface RateLimit {
  perMinute?: number;
  perDay?: number;
}

export interface ProviderUsage {
  id: string;
  limit: RateLimit | null;
  lastMinute: number;
  lastHour: number;
  last24h: number;
  errors24h: number;
  avgMs: number | null;
  /** Requests skipped because the provider was at its limit. */
  throttled: number;
}

export class RateLimited extends Error {}

interface Bucket {
  minute: number;
  calls: number;
  errors: number;
  ms: number;
}

const DAY_MINUTES = 1440;

/**
 * Per-provider request counts in one-minute buckets over the last 24 hours.
 * The router asks `allow` before each call so free tiers are never exceeded:
 * a provider at its limit is skipped in favor of the next one.
 */
export class UsageMeter {
  private buckets = new Map<string, Bucket[]>();
  private skipped = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  private current(): number {
    return Math.floor(this.now() / 60_000);
  }

  private list(id: string): Bucket[] {
    const min = this.current() - DAY_MINUTES;
    const list = (this.buckets.get(id) ?? []).filter((b) => b.minute > min);
    this.buckets.set(id, list);
    return list;
  }

  private sum(list: Bucket[], minutes: number, field: "calls" | "errors" | "ms"): number {
    const from = this.current() - minutes;
    return list.reduce((s, b) => (b.minute > from ? s + b[field] : s), 0);
  }

  allow(id: string, limit?: RateLimit): boolean {
    if (!limit) return true;
    const list = this.list(id);
    const over =
      (limit.perMinute !== undefined && this.sum(list, 1, "calls") >= limit.perMinute) ||
      (limit.perDay !== undefined && this.sum(list, DAY_MINUTES, "calls") >= limit.perDay);
    if (over) this.skipped.set(id, (this.skipped.get(id) ?? 0) + 1);
    return !over;
  }

  record(id: string, ok: boolean, ms: number): void {
    const list = this.list(id);
    const minute = this.current();
    let b = list.find((x) => x.minute === minute);
    if (!b) list.push((b = { minute, calls: 0, errors: 0, ms: 0 }));
    b.calls++;
    if (!ok) b.errors++;
    b.ms += ms;
  }

  usage(id: string, limit?: RateLimit): ProviderUsage {
    const list = this.list(id);
    const calls = this.sum(list, DAY_MINUTES, "calls");
    return {
      id,
      limit: limit ?? null,
      lastMinute: this.sum(list, 1, "calls"),
      lastHour: this.sum(list, 60, "calls"),
      last24h: calls,
      errors24h: this.sum(list, DAY_MINUTES, "errors"),
      avgMs: calls ? this.sum(list, DAY_MINUTES, "ms") / calls : null,
      throttled: this.skipped.get(id) ?? 0,
    };
  }
}
