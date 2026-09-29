import type { Bar } from "../api";

const DAY = 86_400_000;
const dateKey = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Simple period returns of two series, aligned on calendar date (bars present in both). */
export function alignedReturns(a: Bar[], b: Bar[]): { x: number[]; y: number[] } {
  const bByDate = new Map(b.map((bar) => [dateKey(bar.t), bar.c]));
  const pairs = a.flatMap((bar) => {
    const other = bByDate.get(dateKey(bar.t));
    return other === undefined ? [] : [[bar.c, other] as const];
  });
  const x: number[] = [];
  const y: number[] = [];
  for (let i = 1; i < pairs.length; i++) {
    const [sPrev, mPrev] = pairs[i - 1];
    const [s, m] = pairs[i];
    if (sPrev > 0 && mPrev > 0) {
      y.push(s / sPrev - 1);
      x.push(m / mPrev - 1);
    }
  }
  return { x, y };
}

export interface Regression {
  beta: number;
  adjustedBeta: number;
  /** Intercept per period. */
  alpha: number;
  r2: number;
  correlation: number;
  n: number;
}

/** OLS of y on x. Adjusted beta uses the common 0.67 / 0.33 shrinkage toward 1. */
export function regress(x: number[], y: number[]): Regression | null {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  const beta = sxy / sxx;
  const correlation = sxy / Math.sqrt(sxx * syy);
  return { beta, adjustedBeta: 0.67 * beta + 0.33, alpha: my - beta * mx, r2: correlation ** 2, correlation, n };
}

export interface PeriodReturn {
  label: string;
  days: number;
  priceReturn: number | null;
  totalReturn: number | null;
  /** Annualized total return, for periods of a year or longer. */
  annualized: number | null;
}

/**
 * Price and total return (dividends reinvested at the ex-date close) from the
 * close at the period start to the latest close. Returns null when history
 * does not reach back to the period start.
 */
export function periodReturn(bars: Bar[], dividends: { date: string; amount: number }[], start: number): Omit<PeriodReturn, "label" | "days" | "annualized"> & { days: number } | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  let base = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].t <= start) base = i;
    else break;
  }
  if (base < 0) {
    if (bars[0].t - start > 7 * DAY) return null;
    base = 0;
  }
  const divByDate = new Map<string, number>();
  for (const d of dividends) {
    const k = d.date.slice(0, 10);
    divByDate.set(k, (divByDate.get(k) ?? 0) + d.amount);
  }
  let shares = 1;
  for (let i = base + 1; i < bars.length; i++) {
    const div = divByDate.get(dateKey(bars[i].t));
    if (div && bars[i].c > 0) shares *= 1 + div / bars[i].c;
  }
  const b = bars[base].c;
  return {
    priceReturn: last.c / b - 1,
    totalReturn: (shares * last.c) / b - 1,
    days: (last.t - bars[base].t) / DAY,
  };
}

export function totalReturnTable(bars: Bar[], dividends: { date: string; amount: number }[], now = Date.now()): PeriodReturn[] {
  const last = bars.length ? bars[bars.length - 1].t : now;
  const ytd = Date.UTC(new Date(last).getUTCFullYear(), 0, 1) - 1;
  const periods: [string, number][] = [
    ["1M", last - 30 * DAY],
    ["3M", last - 91 * DAY],
    ["6M", last - 182 * DAY],
    ["YTD", ytd],
    ["1Y", last - 365 * DAY],
    ["3Y", last - 3 * 365 * DAY],
    ["5Y", last - 5 * 365 * DAY],
  ];
  return periods.map(([label, start]) => {
    const r = periodReturn(bars, dividends, start);
    const days = r?.days ?? (last - start) / DAY;
    return {
      label,
      days,
      priceReturn: r?.priceReturn ?? null,
      totalReturn: r?.totalReturn ?? null,
      annualized: r && days >= 364 ? Math.pow(1 + r.totalReturn!, 365 / days) - 1 : null,
    };
  });
}

/** Benchmark index for beta, by listing exchange. */
export function benchmarkFor(security: string): string {
  const parts = security.trim().split(/\s+/);
  const exchange = parts.length >= 3 ? parts[parts.length - 2] : "US";
  const map: Record<string, string> = {
    LN: "UKX", GY: "DAX", GR: "DAX", FP: "CAC", NA: "AEX", SM: "IBEX", SW: "SMI", IM: "SX5E",
    JT: "NKY", JP: "NKY", HK: "HSI", AU: "AS51", AT: "AS51", CN: "SPTSX", CT: "SPTSX", KS: "KOSPI",
    TT: "TWSE", IN: "NIFTY", IB: "SENSEX", SP: "STI", BZ: "IBOV", MM: "MEXBOL", CH: "SHCOMP", C1: "SHCOMP",
  };
  return `${map[exchange] ?? "SPX"} Index`;
}
