import type { Capability, ProviderPlugin } from "./DataProvider.js";
import { CAPABILITIES } from "./DataProvider.js";
import type { Bar, FomcMeeting, IndexMembers, Interval, Quote, SearchResult, Sector, Valuation } from "../types.js";
import { normalizeSecurity, sectorOf } from "../symbology.js";
import { RateLimited, UsageMeter, type ProviderUsage } from "./usage.js";

export interface ProviderInfo {
  id: string;
  capabilities: Capability[];
  sectors: readonly Sector[];
}

const isEmpty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/**
 * Routes each request to the first plugin (in priority order) that supports the
 * capability and the security's sector, falling back to the next plugin when a
 * plugin throws or returns nothing for a security.
 */
export class ProviderRouter {
  constructor(
    readonly plugins: ProviderPlugin[],
    private log: (msg: string) => void = console.error,
    readonly meter: UsageMeter = new UsageMeter(),
  ) {}

  /** One metered provider call; providers at their free-tier limit are skipped. */
  private async call<T>(plugin: ProviderPlugin, capability: Capability, fn: () => Promise<T>): Promise<T> {
    if (!this.meter.allow(plugin.id, plugin.rateLimit)) {
      throw new RateLimited(`${plugin.id} is at its free-tier limit (${plugin.rateLimit?.perMinute ?? plugin.rateLimit?.perDay} requests per ${plugin.rateLimit?.perMinute ? "minute" : "day"}) for ${capability}`);
    }
    const t0 = Date.now();
    try {
      const result = await fn();
      this.meter.record(plugin.id, true, Date.now() - t0);
      return result;
    } catch (err) {
      this.meter.record(plugin.id, false, Date.now() - t0);
      throw err;
    }
  }

  private failed(plugin: ProviderPlugin, capability: Capability, err: unknown): void {
    if (!(err instanceof RateLimited)) this.log(`provider ${plugin.id} ${capability} failed: ${(err as Error).message}`);
  }

  usage(): ProviderUsage[] {
    return this.plugins.map((p) => this.meter.usage(p.id, p.rateLimit));
  }

  private eligible(capability: Capability, security?: string): ProviderPlugin[] {
    const sector = security ? sectorOf(security) : null;
    return this.plugins.filter(
      (p) => p[capability] && (!security || (sector !== null && p.sectors.includes(sector) && (!p.covers || p.covers(security)))),
    );
  }

  has(capability: Capability): boolean {
    return this.plugins.some((p) => p[capability]);
  }

  /**
   * Call `capability` on each eligible plugin in turn and return the first
   * non-empty result. Throws the last error only if every attempt failed.
   */
  async first<T>(capability: Capability, security: string | null, call: (p: ProviderPlugin) => Promise<T>): Promise<T | null> {
    let lastError: unknown = null;
    for (const plugin of this.eligible(capability, security ?? undefined)) {
      try {
        const result = await this.call(plugin, capability, () => call(plugin));
        if (!isEmpty(result)) return result;
      } catch (err) {
        lastError = err;
        this.failed(plugin, capability, err);
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  /** Call `capability` on every eligible plugin and return each non-empty result (for merging sources). */
  async all<T>(capability: Capability, security: string | null, call: (p: ProviderPlugin) => Promise<T>): Promise<T[]> {
    const plugins = this.eligible(capability, security ?? undefined);
    const settled = await Promise.allSettled(plugins.map((p) => this.call(p, capability, () => call(p))));
    return settled.flatMap((s, i) => {
      if (s.status === "rejected") {
        this.failed(plugins[i], capability, s.reason);
        return [];
      }
      return isEmpty(s.value) ? [] : [s.value];
    });
  }

  /** Batch capability: each security goes to the first plugin that returns it. */
  private async batch<T extends { security: string }>(
    capability: "quotes" | "valuations",
    securities: string[],
    call: (p: ProviderPlugin, batch: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const pending = new Set(securities.map(normalizeSecurity).filter((s): s is string => !!s));
    const found = new Map<string, T>();
    let lastError: unknown = null;
    let anySucceeded = false;

    for (const plugin of this.plugins) {
      if (!plugin[capability] || !pending.size) continue;
      const batch = [...pending].filter((s) => this.eligible(capability, s).includes(plugin));
      if (!batch.length) continue;
      try {
        const results = await this.call(plugin, capability, () => call(plugin, batch));
        anySucceeded = true;
        for (const r of results) {
          if (pending.delete(r.security)) found.set(r.security, r);
        }
      } catch (err) {
        lastError = err;
        this.failed(plugin, capability, err);
      }
    }

    if (!anySucceeded && lastError) throw lastError;
    const order = securities.map(normalizeSecurity);
    return [...found.values()].sort((a, b) => order.indexOf(a.security) - order.indexOf(b.security));
  }

  quotes(securities: string[]): Promise<Quote[]> {
    return this.batch("quotes", securities, (p, b) => p.quotes!(b));
  }

  async quote(security: string): Promise<Quote | null> {
    const [q] = await this.quotes([security]);
    return q ?? null;
  }

  valuations(securities: string[]): Promise<Valuation[]> {
    return this.batch("valuations", securities, (p, b) => p.valuations!(b));
  }

  async fomcCalendar(): Promise<FomcMeeting[]> {
    return (await this.first("fomcCalendar", null, (p) => p.fomcCalendar!())) ?? [];
  }

  indexMembers(security: string): Promise<IndexMembers | null> {
    return this.first("indexMembers", security, (p) => p.indexMembers!(security));
  }

  async search(query: string): Promise<SearchResult[]> {
    return (await this.first("search", null, (p) => p.search!(query))) ?? [];
  }

  async history(security: string, interval: Interval, from: Date, to: Date): Promise<Bar[]> {
    return (await this.first("history", security, (p) => p.history!(security, interval, from, to))) ?? [];
  }

  /** The plugin that would serve quotes for `security`, if it supports native push. */
  streamingPlugin(security: string): ProviderPlugin | null {
    const first = this.eligible("quotes", security)[0];
    return first?.subscribe ? first : null;
  }

  /** The first plugin that streams individual trades for `security`. */
  tradesPlugin(security: string): ProviderPlugin | null {
    return this.eligible("subscribeTrades", security)[0] ?? null;
  }

  describe(): ProviderInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      capabilities: CAPABILITIES.filter((c) => typeof p[c] === "function"),
      sectors: p.sectors,
    }));
  }
}
