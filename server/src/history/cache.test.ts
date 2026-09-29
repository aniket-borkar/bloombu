import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock.js";
import type { Bar, Interval } from "../types.js";
import { HistoryCache } from "./cache.js";
import { parseHistoryQuery } from "./ranges.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 25, 15, 30);

let dir: string;
let now: number;
let calls: [number, number][];
let fail: boolean;

const mock = createMockProvider(() => now);
const fetcher = async (security: string, interval: Interval, from: Date, to: Date): Promise<Bar[]> => {
  calls.push([from.getTime(), to.getTime()]);
  if (fail) throw new Error("provider down");
  return mock.history!(security, interval, from, to);
};

const make = (file = path.join(dir, "cache.db")) => new HistoryCache(file, fetcher, () => now, () => {});

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "blmbu-cache-"));
  now = T0;
  calls = [];
  fail = false;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("HistoryCache", () => {
  it("fetches once, then serves from cache while fresh", async () => {
    const c = make();
    const a = await c.get("SPX Index", "1d", T0 - 30 * DAY, T0);
    expect(a.length).toBeGreaterThan(25);
    expect(calls).toHaveLength(1);
    now += 10_000;
    const b = await c.get("SPX Index", "1d", T0 - 30 * DAY, now);
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
  });

  it("fetches only the stale tail, starting at the newest cached bar", async () => {
    const c = make();
    const first = await c.get("SPX Index", "1d", T0 - 30 * DAY, T0);
    const lastTs = first[first.length - 1].t;
    now += 2 * DAY;
    const second = await c.get("SPX Index", "1d", T0 - 30 * DAY, now);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([lastTs, now]);
    expect(second.length).toBe(first.length + 2);
  });

  it("fetches only the missing older range", async () => {
    const c = make();
    await c.get("SPX Index", "1d", T0 - 30 * DAY, T0);
    const longer = await c.get("SPX Index", "1d", T0 - 90 * DAY, T0);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual([T0 - 90 * DAY, T0 - 30 * DAY]);
    const ts = longer.map((b) => b.t);
    expect(new Set(ts).size).toBe(ts.length);
    expect(ts).toEqual([...ts].sort((x, y) => x - y));
  });

  it("does not re-request ranges the provider could not supply", async () => {
    const empty = new HistoryCache(
      path.join(dir, "e.db"),
      async (_s, _i, from, to) => {
        calls.push([from.getTime(), to.getTime()]);
        return [];
      },
      () => now,
      () => {},
    );
    await empty.get("SPX Index", "1d", T0 - 10 * DAY, T0);
    await empty.get("SPX Index", "1d", T0 - 10 * DAY, T0);
    expect(calls).toHaveLength(1);
    empty.close();
  });

  it("persists across instances", async () => {
    const file = path.join(dir, "persist.db");
    const a = make(file);
    const bars = await a.get("AAPL US Equity", "1h", T0 - 2 * DAY, T0);
    a.close();
    const b = make(file);
    expect(await b.get("AAPL US Equity", "1h", T0 - 2 * DAY, T0)).toEqual(bars);
    expect(calls).toHaveLength(1);
    b.close();
  });

  it("serves stale cache when a refresh fails, but throws with nothing cached", async () => {
    const c = make();
    const bars = await c.get("SPX Index", "1d", T0 - 10 * DAY, T0);
    fail = true;
    now += DAY;
    expect(await c.get("SPX Index", "1d", T0 - 10 * DAY, now)).toEqual(bars);
    await expect(c.get("NKY Index", "1d", T0 - 10 * DAY, now)).rejects.toThrow("provider down");
  });

  it("serializes concurrent requests for the same key", async () => {
    const c = make();
    await Promise.all([
      c.get("SPX Index", "1d", T0 - 10 * DAY, T0),
      c.get("SPX Index", "1d", T0 - 10 * DAY, T0),
      c.get("SPX Index", "1d", T0 - 10 * DAY, T0),
    ]);
    expect(calls).toHaveLength(1);
  });

  it("keeps intervals separate", async () => {
    const c = make();
    await c.get("SPX Index", "1d", T0 - 10 * DAY, T0);
    await c.get("SPX Index", "1h", T0 - 2 * DAY, T0);
    expect(calls).toHaveLength(2);
  });
});

describe("parseHistoryQuery", () => {
  it("defaults to 1d over 1y", () => {
    expect(parseHistoryQuery({})).toEqual({ interval: "1d", range: "1y" });
  });

  it("rejects unknown values and too-long intraday ranges", () => {
    expect(parseHistoryQuery({ interval: "2m" })).toHaveProperty("error");
    expect(parseHistoryQuery({ range: "10y" })).toHaveProperty("error");
    expect(parseHistoryQuery({ interval: "1m", range: "1mo" })).toHaveProperty("error");
    expect(parseHistoryQuery({ interval: "1m", range: "5d" })).toEqual({ interval: "1m", range: "5d" });
  });
});
