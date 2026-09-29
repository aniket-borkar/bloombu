import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";

/**
 * Persistent key/value cache for slow-changing public data (index members,
 * central-bank rates, calendars). It survives restarts so free sources are
 * not re-fetched every time the server reloads.
 */
export class KvCache {
  private db: DatabaseSync;
  private inflight = new Map<string, Promise<unknown>>();

  constructor(
    file: string,
    private now: () => number = Date.now,
  ) {
    this.db = openDatabase(file);
    this.db.exec("CREATE TABLE IF NOT EXISTS kv_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)");
  }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value, expires FROM kv_cache WHERE key = ?").get(key) as { value: string; expires: number } | undefined;
    if (!row || row.expires <= this.now()) return undefined;
    return JSON.parse(row.value) as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.db
      .prepare("INSERT INTO kv_cache (key, value, expires) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires = excluded.expires")
      .run(key, JSON.stringify(value ?? null), this.now() + ttlMs);
  }

  /** Cached value for `key`, loading it once (even under concurrent callers) when missing or expired. */
  async wrap<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const pending = this.inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const p = load()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  close(): void {
    this.db.close();
  }
}
