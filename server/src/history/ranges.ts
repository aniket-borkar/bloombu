import type { Interval } from "../types.js";

const DAY = 86_400_000;

export const RANGE_MS = {
  "1d": DAY,
  "5d": 5 * DAY,
  "1mo": 31 * DAY,
  "3mo": 92 * DAY,
  "6mo": 183 * DAY,
  "1y": 366 * DAY,
  "2y": 731 * DAY,
  "5y": 1827 * DAY,
} as const;

export type Range = keyof typeof RANGE_MS;

/** Longest range allowed per interval, keeping responses bounded and within provider lookback. */
const MAX_RANGE: Record<Interval, Range> = {
  "1m": "5d",
  "5m": "1mo",
  "1h": "1y",
  "1d": "5y",
  "1wk": "5y",
};

const INTERVALS = Object.keys(MAX_RANGE) as Interval[];
const RANGES = Object.keys(RANGE_MS) as Range[];

export type HistoryQuery = { interval: Interval; range: Range } | { error: string };

export function parseHistoryQuery(q: { interval?: unknown; range?: unknown }): HistoryQuery {
  const interval = (q.interval ?? "1d") as Interval;
  const range = (q.range ?? "1y") as Range;
  if (!INTERVALS.includes(interval)) return { error: `interval must be one of ${INTERVALS.join(", ")}` };
  if (!RANGES.includes(range)) return { error: `range must be one of ${RANGES.join(", ")}` };
  if (RANGE_MS[range] > RANGE_MS[MAX_RANGE[interval]]) {
    return { error: `range ${range} is too long for interval ${interval} (max ${MAX_RANGE[interval]})` };
  }
  return { interval, range };
}
