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
  completed: number;
  requests: { started: number; ok?: boolean; ms?: number }[];
}

const DAY_MINUTES = 1440;

/**
 * Per-provider request counts in one-minute buckets over the last 24 hours.
 * Requests reserve budget synchronously before I/O. Exact start times in the
 * boundary bucket enforce rolling limits even across a minute/day boundary.
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
    const list = (this.buckets.get(id) ?? []).filter((b) => b.minute >= min);
    this.buckets.set(id, list);
    return list;
  }

  private sum(list: Bucket[], minutes: number, field: "calls" | "errors" | "ms" | "completed"): number {
    const from = this.now() - minutes * 60_000;
    const boundary = Math.floor(from / 60_000);
    return list.reduce((sum, b) => {
      if (b.minute > boundary) return sum + b[field];
      if (b.minute < boundary) return sum;
      return sum + b.requests.reduce((s, r) => {
        if (r.started <= from) return s;
        if (field === "calls") return s + 1;
        if (field === "errors") return s + (r.ok === false ? 1 : 0);
        if (field === "completed") return s + (r.ok === undefined ? 0 : 1);
        return s + (r.ms ?? 0);
      }, 0);
    }, 0);
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

  private reserve(id: string, limit?: RateLimit): (ok: boolean, ms: number) => void {
    if (!this.allow(id, limit)) throw new RateLimited(`${id} is at its free-tier request limit`);
    const list = this.list(id);
    const minute = this.current();
    let b = list.find((x) => x.minute === minute);
    if (!b) list.push((b = { minute, calls: 0, errors: 0, ms: 0, completed: 0, requests: [] }));
    const request: Bucket["requests"][number] = { started: this.now() };
    b.requests.push(request);
    b.calls++;
    return (ok, ms) => {
      request.ok = ok;
      request.ms = ms;
      b.completed++;
      if (!ok) b.errors++;
      b.ms += ms;
    };
  }

  /** Reserve one outgoing request before dispatch; denied requests never run. */
  async run<T>(id: string, limit: RateLimit | undefined, request: () => Promise<T>): Promise<T> {
    const finish = this.reserve(id, limit);
    const started = this.now();
    try {
      const result = await request();
      finish(true, this.now() - started);
      return result;
    } catch (err) {
      finish(false, this.now() - started);
      throw err;
    }
  }

  /** Record an already completed request (e.g. historical usage supplied by a caller). */
  record(id: string, ok: boolean, ms: number): void {
    this.reserve(id)(ok, ms);
  }

  usage(id: string, limit?: RateLimit): ProviderUsage {
    const list = this.list(id);
    const completed = this.sum(list, DAY_MINUTES, "completed");
    return {
      id,
      limit: limit ?? null,
      lastMinute: this.sum(list, 1, "calls"),
      lastHour: this.sum(list, 60, "calls"),
      last24h: this.sum(list, DAY_MINUTES, "calls"),
      errors24h: this.sum(list, DAY_MINUTES, "errors"),
      avgMs: completed ? this.sum(list, DAY_MINUTES, "ms") / completed : null,
      throttled: this.skipped.get(id) ?? 0,
    };
  }
}
