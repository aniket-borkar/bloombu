import { maxDrawdown } from "../portfolio/analytics.js";
import type { Bar } from "../types.js";

export const TRADING_DAYS = 252;
const DAY_MS = 86_400_000;

/** Close-to-close daily returns of each series over the days every series traded, oldest first. */
export function alignedReturns(series: Bar[][]): { days: number[]; returns: number[][] } {
  if (!series.length) return { days: [], returns: [] };
  const byDay = series.map((bars) => new Map(bars.filter((b) => Number.isFinite(b.c) && b.c > 0).map((b) => [Math.floor(b.t / DAY_MS), b.c])));
  const days = [...byDay[0].keys()].filter((d) => byDay.every((m) => m.has(d))).sort((a, b) => a - b);
  return {
    days: days.slice(1).map((d) => d * DAY_MS),
    returns: byDay.map((m) => days.slice(1).map((d, i) => m.get(d)! / m.get(days[i])! - 1)),
  };
}

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

/** Sample standard deviation. */
export function stdev(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

const centralMoment = (xs: number[], k: number) => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** k));
};

export function skewness(xs: number[]): number {
  const m2 = centralMoment(xs, 2);
  return xs.length > 2 && m2 ? centralMoment(xs, 3) / m2 ** 1.5 : NaN;
}

/** Kurtosis minus 3, so a normal distribution scores 0 and fat tails score above it. */
export function excessKurtosis(xs: number[]): number {
  const m2 = centralMoment(xs, 2);
  return xs.length > 3 && m2 ? centralMoment(xs, 4) / m2 ** 2 - 3 : NaN;
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : NaN;
}

export function correlationMatrix(returns: number[][]): number[][] {
  return returns.map((a, i) => returns.map((b, j) => (i === j ? 1 : correlation(a, b))));
}

export interface ReturnStats {
  days: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  annualizedVolPct: number;
  /** Mean over standard deviation of daily returns, annualized, with a zero risk-free rate. */
  sharpe: number;
  maxDrawdownPct: number;
  skew: number;
  excessKurtosis: number;
  bestDayPct: number;
  worstDayPct: number;
}

export function returnStats(rets: number[]): ReturnStats {
  const levels = [1];
  for (const r of rets) levels.push(levels[levels.length - 1] * (1 + r));
  const total = levels[levels.length - 1];
  const years = rets.length / TRADING_DAYS;
  const sd = stdev(rets);
  return {
    days: rets.length,
    totalReturnPct: (total - 1) * 100,
    annualizedReturnPct: years > 0 ? (total ** (1 / years) - 1) * 100 : NaN,
    annualizedVolPct: sd * Math.sqrt(TRADING_DAYS) * 100,
    sharpe: sd ? (mean(rets) / sd) * Math.sqrt(TRADING_DAYS) : NaN,
    maxDrawdownPct: maxDrawdown(levels).pct * 100,
    skew: skewness(rets),
    excessKurtosis: excessKurtosis(rets),
    bestDayPct: rets.length ? Math.max(...rets) * 100 : NaN,
    worstDayPct: rets.length ? Math.min(...rets) * 100 : NaN,
  };
}

/** Inverse of a small square matrix by Gauss-Jordan elimination with partial pivoting; null when singular. */
export function invert(m: number[][]): number[][] | null {
  const n = m.length;
  const scale = Math.max(...m.flat().map(Math.abs)) || 1;
  const a = m.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12 * scale) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let j = 0; j < 2 * n; j++) a[col][j] /= d;
    for (let r = 0; r < n; r++) {
      const f = a[r][col];
      if (r !== col && f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

export interface Regression {
  n: number;
  /** The daily intercept annualized: return the factors do not explain. */
  alphaAnnualPct: number;
  alphaTStat: number;
  betas: number[];
  tStats: number[];
  r2: number;
}

/**
 * Ordinary least squares of `y` on the factor series plus an intercept. Null
 * when there are too few observations or the factors are collinear.
 */
export function ols(y: number[], factors: number[][]): Regression | null {
  const n = y.length;
  const p = factors.length + 1;
  if (n < p + 2 || factors.some((f) => f.length !== n)) return null;
  const rows = y.map((_, i) => [1, ...factors.map((f) => f[i])]);
  const xtx = Array.from({ length: p }, (_, a) => Array.from({ length: p }, (_, b) => rows.reduce((s, r) => s + r[a] * r[b], 0)));
  const xty = Array.from({ length: p }, (_, a) => rows.reduce((s, r, i) => s + r[a] * y[i], 0));
  const inv = invert(xtx);
  if (!inv) return null;
  const coef = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j], 0));
  const residual = rows.map((r, i) => y[i] - r.reduce((s, v, j) => s + v * coef[j], 0));
  const ssr = residual.reduce((s, e) => s + e * e, 0);
  const my = mean(y);
  const sst = y.reduce((s, v) => s + (v - my) ** 2, 0);
  const se = inv.map((row, j) => Math.sqrt(Math.max(row[j], 0) * (ssr / (n - p))));
  const t = (j: number) => (se[j] > 0 ? coef[j] / se[j] : NaN);
  return {
    n,
    alphaAnnualPct: coef[0] * TRADING_DAYS * 100,
    alphaTStat: t(0),
    betas: coef.slice(1),
    tStats: coef.slice(1).map((_, j) => t(j + 1)),
    r2: sst ? 1 - ssr / sst : NaN,
  };
}
