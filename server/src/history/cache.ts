import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { INTERVAL_MS, type Bar, type Interval } from "../types.js";

export type HistoryFetcher = (security: string, interval: Interval, from: Date, to: Date) => Promise<Bar[]>;

interface Coverage {
  from_ts: number;
  to_ts: number;
  fetched_at: number;
}

/** How long the newest (possibly still forming) bar may be served before refetching the tail. */
const MAX_TAIL_AGE_MS = 60_000;

/**
 * SQLite-backed bar cache. Tracks the time range already requested per
 * (security, interval) and fetches only what lies outside it, plus the tail
 * when it is stale. Ranges a provider cannot supply (for example intraday bars
 * beyond its lookback) are still recorded as covered, so old cached bars are
 * kept and not re-requested.
 */
export class HistoryCache {
  private db: DatabaseSync;
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    file: string,
    private fetcher: HistoryFetcher,
    private now: () => number = Date.now,
    private log: (msg: string) => void = console.error,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bars (
        security TEXT NOT NULL,
        interval TEXT NOT NULL,
        ts INTEGER NOT NULL,
        o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL,
        PRIMARY KEY (security, interval, ts)
      );
      CREATE TABLE IF NOT EXISTS coverage (
        security TEXT NOT NULL,
        interval TEXT NOT NULL,
        from_ts INTEGER NOT NULL,
        to_ts INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (security, interval)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Bars with start time in [from, to], oldest first. */
  get(security: string, interval: Interval, from: number, to: number): Promise<Bar[]> {
    const key = `${security}|${interval}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.load(security, interval, from, to));
    this.locks.set(key, run);
    run.finally(() => {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }).catch(() => {});
    return run;
  }

  private async load(security: string, interval: Interval, from: number, requestedTo: number): Promise<Bar[]> {
    const now = this.now();
    const to = Math.min(requestedTo, now);
    const cov = this.db
      .prepare("SELECT from_ts, to_ts, fetched_at FROM coverage WHERE security = ? AND interval = ?")
      .get(security, interval) as Coverage | undefined;

    const gaps: [number, number][] = [];
    if (!cov) {
      gaps.push([from, to]);
    } else {
      if (from < cov.from_ts) gaps.push([from, cov.from_ts]);
      const maxAge = Math.min(INTERVAL_MS[interval], MAX_TAIL_AGE_MS);
      const tailStale = now - cov.fetched_at >= maxAge || to - cov.to_ts >= maxAge;
      if (to > cov.to_ts && tailStale) {
        const last = this.db
          .prepare("SELECT MAX(ts) AS ts FROM bars WHERE security = ? AND interval = ?")
          .get(security, interval) as { ts: number | null };
        gaps.push([last.ts ?? cov.to_ts, to]);
      }
    }

    if (gaps.length) {
      try {
        const fetched = await Promise.all(gaps.map(([a, b]) => this.fetcher(security, interval, new Date(a), new Date(b))));
        this.store(security, interval, fetched.flat());
        const newFrom = cov ? Math.min(cov.from_ts, from) : from;
        const newTo = cov ? Math.max(cov.to_ts, to) : to;
        const tailFetched = !cov || gaps.some(([, b]) => b === to && to > cov.to_ts);
        this.db
          .prepare(
            `INSERT INTO coverage (security, interval, from_ts, to_ts, fetched_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (security, interval) DO UPDATE SET from_ts = excluded.from_ts, to_ts = excluded.to_ts, fetched_at = excluded.fetched_at`,
          )
          .run(security, interval, newFrom, newTo, tailFetched ? now : cov!.fetched_at);
      } catch (err) {
        if (!cov) throw err;
        this.log(`history refresh failed for ${security} ${interval}, serving cache: ${(err as Error).message}`);
      }
    }

    return this.db
      .prepare(
        "SELECT ts AS t, o, h, l, c, v FROM bars WHERE security = ? AND interval = ? AND ts >= ? AND ts <= ? ORDER BY ts",
      )
      .all(security, interval, from, to) as unknown as Bar[];
  }

  private store(security: string, interval: Interval, bars: Bar[]): void {
    if (!bars.length) return;
    const stmt = this.db.prepare(
      `INSERT INTO bars (security, interval, ts, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (security, interval, ts) DO UPDATE SET o = excluded.o, h = excluded.h, l = excluded.l, c = excluded.c, v = excluded.v`,
    );
    this.db.exec("BEGIN");
    try {
      for (const b of bars) stmt.run(security, interval, b.t, b.o, b.h, b.l, b.c, b.v);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
