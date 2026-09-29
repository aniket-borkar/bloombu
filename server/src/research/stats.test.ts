import { describe, expect, it } from "vitest";
import type { Bar } from "../types.js";
import { alignedReturns, correlation, correlationMatrix, excessKurtosis, invert, ols, returnStats, skewness, stdev } from "./stats.js";

const DAY = 86_400_000;
const bars = (closes: number[], skip: number[] = []): Bar[] =>
  closes.flatMap((c, i) => (skip.includes(i) ? [] : [{ t: i * DAY + 20 * 3_600_000, o: c, h: c, l: c, c, v: null }]));
/** Seeded uniform noise in [-0.01, 0.01) (mulberry32), independent across seeds. */
function noiseSeries(n: number, seed: number): number[] {
  let s = seed >>> 0;
  return Array.from({ length: n }, () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 0.02;
  });
}

describe("alignedReturns", () => {
  it("uses only the days every series traded", () => {
    const { days, returns } = alignedReturns([bars([100, 110, 121, 133.1]), bars([50, 50, 55, 55], [2])]);
    expect(days).toEqual([DAY, 3 * DAY]);
    expect(returns[0].map((r) => +r.toFixed(6))).toEqual([0.1, 0.21]);
    expect(returns[1].map((r) => +r.toFixed(6))).toEqual([0, 0.1]);
  });
});

describe("return statistics", () => {
  it("summarizes returns, drawdown and shape", () => {
    const s = returnStats([0.1, -0.5, 0.2]);
    expect(s.totalReturnPct).toBeCloseTo((1.1 * 0.5 * 1.2 - 1) * 100, 8);
    expect(s.maxDrawdownPct).toBeCloseTo(-50, 8);
    expect(s.bestDayPct).toBeCloseTo(20, 8);
    expect(s.worstDayPct).toBeCloseTo(-50, 8);
    expect(s.annualizedVolPct).toBeCloseTo(stdev([0.1, -0.5, 0.2]) * Math.sqrt(252) * 100, 8);
    expect(skewness([1, 2, 3])).toBeCloseTo(0, 10);
    expect(skewness([0, 0, 0, 10])).toBeGreaterThan(0);
    expect(excessKurtosis([0, 0, 0, 0, 0, 0, 0, 0, 0, 10])).toBeGreaterThan(0);
  });

  it("correlates series", () => {
    const a = noiseSeries(50, 1);
    expect(correlation(a, a.map((x) => 2 * x + 0.001))).toBeCloseTo(1, 10);
    expect(correlation(a, a.map((x) => -x))).toBeCloseTo(-1, 10);
    const m = correlationMatrix([a, a.map((x) => -x)]);
    expect(m[0][0]).toBe(1);
    expect(m[0][1]).toBeCloseTo(-1, 10);
  });
});

describe("regression", () => {
  it("inverts small matrices and rejects singular ones", () => {
    expect(invert([[4, 7], [2, 6]])!.flat().map((v) => +v.toFixed(6))).toEqual([0.6, -0.7, -0.2, 0.4]);
    expect(invert([[1, 2], [2, 4]])).toBeNull();
  });

  it("recovers factor loadings, alpha and fit", () => {
    const n = 300;
    const mkt = noiseSeries(n, 2);
    const size = noiseSeries(n, 3);
    const raw = noiseSeries(n, 4);
    const idio = raw.map((v) => v - raw.reduce((s, x) => s + x, 0) / n);
    const y = mkt.map((m, i) => 0.0002 + 1.2 * m - 0.4 * size[i] + idio[i] * 0.2);
    const r = ols(y, [mkt, size])!;
    expect(r.n).toBe(n);
    expect(r.betas[0]).toBeCloseTo(1.2, 1);
    expect(r.betas[1]).toBeCloseTo(-0.4, 1);
    expect(r.alphaAnnualPct).toBeCloseTo(0.0002 * 252 * 100, 0);
    expect(r.r2).toBeGreaterThan(0.9);
    expect(Math.abs(r.tStats[0])).toBeGreaterThan(10);
  });

  it("returns null for collinear factors or too little data", () => {
    const x = noiseSeries(30, 5);
    expect(ols(x, [x, x.map((v) => v * 2)])).toBeNull();
    expect(ols([0.01, 0.02], [[0.01, 0.03]])).toBeNull();
  });
});
