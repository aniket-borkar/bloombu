import { parseSecurity } from "../symbology.js";
import type {
  Bar,
  ExposureRow,
  HoldingAnalytics,
  PortfolioAnalytics,
  PortfolioHolding,
  PortfolioKind,
  Quote,
} from "../types.js";

const TRADING_DAYS = 252;
const Z95 = 1.6448536269514722;

/** Quote currencies expressed in minor units, mapped to their major currency and scale. */
const MINOR_UNITS: Record<string, [string, number]> = {
  GBp: ["GBP", 0.01],
  GBX: ["GBP", 0.01],
  ZAc: ["ZAR", 0.01],
  ZAC: ["ZAR", 0.01],
  ILA: ["ILS", 0.01],
};

export function normalizeCurrency(currency: string | null, base: string): { currency: string; scale: number } {
  if (!currency) return { currency: base, scale: 1 };
  const minor = MINOR_UNITS[currency];
  if (minor) return { currency: minor[0], scale: minor[1] };
  return { currency: currency.toUpperCase(), scale: 1 };
}

const COUNTRY_BY_EXCHANGE: Record<string, string> = {
  US: "United States", UN: "United States", UW: "United States", UQ: "United States", UA: "United States", UP: "United States",
  LN: "United Kingdom", GY: "Germany", GR: "Germany", FP: "France", NA: "Netherlands", BB: "Belgium", IM: "Italy",
  SM: "Spain", SW: "Switzerland", SS: "Sweden", DC: "Denmark", NO: "Norway", FH: "Finland", ID: "Ireland",
  PL: "Portugal", AV: "Austria", JT: "Japan", JP: "Japan", HK: "Hong Kong", AU: "Australia", AT: "Australia",
  CN: "Canada", CT: "Canada", KS: "South Korea", TT: "Taiwan", IN: "India", IB: "India", SP: "Singapore",
  BZ: "Brazil", MM: "Mexico", CH: "China", C1: "China", C2: "China",
};

export function classify(security: string): { assetClass: string; country: string } {
  const p = parseSecurity(security);
  const assetClass = p?.sector ?? "Other";
  const country = p?.sector === "Equity" ? (COUNTRY_BY_EXCHANGE[p.exchange ?? "US"] ?? "Other") : "Global";
  return { assetClass, country };
}

const dateKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export interface FxSeries {
  /** USD value of one unit of the currency, now. */
  now: number | null;
  /** Daily USD value of one unit, as bars (close used). */
  bars: Bar[];
}

export interface AnalyticsInput {
  name: string;
  kind: PortfolioKind;
  baseCurrency: string;
  notional: number | null;
  holdings: PortfolioHolding[];
  quotes: Map<string, Quote>;
  bars: Map<string, Bar[]>;
  /** USD value per unit for each currency needed (USD itself may be omitted). */
  usdPer: Map<string, FxSeries>;
  sectors: Map<string, string | null>;
  benchmark: { security: string; bars: Bar[] };
  riskFreePct: number | null;
  range: string;
  now: number;
}

function mean(v: number[]): number {
  return v.reduce((s, x) => s + x, 0) / v.length;
}

/** Sample standard deviation. */
function stdev(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return NaN;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

function correlation(a: number[], b: number[]): number | null {
  const c = covariance(a, b) / (stdev(a) * stdev(b));
  return Number.isFinite(c) ? c : null;
}

/** Linear-interpolated quantile of a sample (q in [0, 1]). */
export function quantile(values: number[], q: number): number {
  const s = [...values].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function maxDrawdown(values: number[]): { pct: number; peak: number; trough: number } {
  let peak = 0;
  let best = { pct: 0, peak: 0, trough: 0 };
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[peak]) peak = i;
    const dd = values[i] / values[peak] - 1;
    if (dd < best.pct) best = { pct: dd, peak, trough: i };
  }
  return best;
}

const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const orNull = (x: number) => (Number.isFinite(x) ? x : null);

function exposure(items: { key: string; value: number }[], total: number): ExposureRow[] {
  const sums = new Map<string, number>();
  for (const { key, value } of items) sums.set(key, (sums.get(key) ?? 0) + value);
  return [...sums.entries()]
    .map(([key, value]) => ({ key, weightPct: (value / total) * 100 }))
    .sort((a, b) => b.weightPct - a.weightPct);
}

/** Close price on each date of `dates`, carrying the last known value forward. */
function alignForward(bars: Bar[], dates: string[]): (number | null)[] {
  const byDate = new Map(bars.map((b) => [dateKey(b.t), b.c]));
  let last: number | null = null;
  return dates.map((d) => {
    const v = byDate.get(d);
    if (v !== undefined && Number.isFinite(v)) last = v;
    return last;
  });
}

/**
 * Holdings-based portfolio analytics: current holdings are held constant over
 * the lookback window (the default holdings-based view). Values are converted
 * to the base currency with daily FX; minor-unit quotes (GBp) are scaled.
 */
export function analyzePortfolio(input: AnalyticsInput): PortfolioAnalytics {
  const base = input.baseCurrency;
  const warnings: string[] = [];
  const fxNow = (ccy: string): number | null => {
    if (ccy === base) return 1;
    const c = ccy === "USD" ? 1 : input.usdPer.get(ccy)?.now;
    const b = base === "USD" ? 1 : input.usdPer.get(base)?.now;
    return finite(c) && finite(b) && b !== 0 ? c / b : null;
  };

  // ---- Current valuation ----
  interface Row extends HoldingAnalytics {
    q: number | null;
  }
  const rows: Row[] = input.holdings.map((h) => {
    const q = input.quotes.get(h.security);
    const { assetClass, country } = classify(h.security);
    const { currency, scale } = normalizeCurrency(q?.currency ?? null, base);
    const fx = fxNow(currency);
    let error: string | null = null;
    if (!q || !finite(q.last)) error = "NO QUOTE";
    else if (fx === null) error = `NO FX RATE ${currency}/${base}`;
    return {
      security: h.security,
      name: q?.name ?? h.security,
      assetClass,
      sector: input.sectors.get(h.security) ?? assetClass,
      country,
      currency,
      quantity: input.kind === "positions" ? h.quantity : null,
      last: q?.last ?? null,
      prevClose: q?.prevClose ?? null,
      priceScale: scale,
      fxToBase: fx,
      marketValue: null,
      weightPct: null,
      dayPnl: null,
      costValue: null,
      unrealizedPnl: null,
      unrealizedPct: null,
      periodReturnPct: null,
      contributionPct: null,
      riskContributionPct: null,
      error,
      q: null,
    };
  });

  const valid = rows.filter((r) => !r.error);
  if (input.kind === "model") {
    const weights = valid.map((r) => input.holdings[rows.indexOf(r)].weight ?? 0);
    const sum = weights.reduce((s, w) => s + w, 0);
    if (sum > 0 && Math.abs(sum - 100) > 0.01) warnings.push(`Weights sum to ${sum.toFixed(2)}%; normalized to 100%.`);
    const notional = input.notional ?? 1_000_000;
    valid.forEach((r, i) => {
      const unitValue = r.last! * r.priceScale * r.fxToBase!;
      r.q = sum > 0 && unitValue !== 0 ? (notional * (weights[i] / sum)) / unitValue : null;
      r.quantity = r.q;
    });
  } else {
    for (const r of valid) r.q = input.holdings[rows.indexOf(r)].quantity;
  }

  for (const r of valid) {
    if (!finite(r.q)) continue;
    const unit = r.priceScale * r.fxToBase!;
    r.marketValue = r.q * r.last! * unit;
    r.dayPnl = finite(r.prevClose) ? r.q * (r.last! - r.prevClose) * unit : null;
    const cost = input.holdings[rows.indexOf(r)].cost;
    if (input.kind === "positions" && finite(cost)) {
      r.costValue = r.q * cost * unit;
      r.unrealizedPnl = r.marketValue - r.costValue;
      r.unrealizedPct = r.costValue !== 0 ? (r.unrealizedPnl / Math.abs(r.costValue)) * 100 : null;
    }
  }

  const priced = valid.filter((r) => finite(r.marketValue));
  const totalMv = priced.reduce((s, r) => s + r.marketValue!, 0);
  const weightsUsable = totalMv > 0;
  if (!weightsUsable && priced.length) warnings.push("Net market value is not positive; weights are not shown.");
  for (const r of priced) r.weightPct = weightsUsable ? (r.marketValue! / totalMv) * 100 : null;
  for (const r of rows.filter((x) => x.error)) warnings.push(`${r.security}: ${r.error}`);

  const costRows = priced.filter((r) => finite(r.costValue));
  const totals = {
    marketValue: totalMv,
    dayPnl: priced.reduce((s, r) => s + (r.dayPnl ?? 0), 0),
    costValue: costRows.length ? costRows.reduce((s, r) => s + r.costValue!, 0) : null,
    unrealizedPnl: costRows.length ? costRows.reduce((s, r) => s + r.unrealizedPnl!, 0) : null,
  };

  // ---- Historical series (static holdings) ----
  const inRange = priced.filter((r) => (input.bars.get(r.security)?.length ?? 0) > 1);
  for (const r of priced) {
    if (!inRange.includes(r)) warnings.push(`${r.security}: no price history; excluded from performance and risk.`);
  }
  const dateSet = new Set<string>();
  for (const r of inRange) for (const b of input.bars.get(r.security)!) dateSet.add(dateKey(b.t));
  const allDates = [...dateSet].sort();

  const fxSeries = (ccy: string, dates: string[]): (number | null)[] => {
    if (ccy === base) return dates.map(() => 1);
    const series = (c: string) => {
      if (c === "USD") return dates.map(() => 1);
      const s = input.usdPer.get(c);
      if (!s) return dates.map(() => null);
      const aligned = s.bars.length ? alignForward(s.bars, dates) : dates.map(() => null);
      return aligned.map((v) => v ?? s.now ?? null);
    };
    const c = series(ccy);
    const b = series(base);
    return dates.map((_, i) => (finite(c[i]) && finite(b[i]) && b[i] !== 0 ? c[i]! / b[i]! : null));
  };

  // A portfolio can contain several lots of the same security. Keep each
  // lot's quantity in its own series instead of overwriting it by ticker.
  const valueSeries = new Map<Row, (number | null)[]>();
  for (const r of inRange) {
    const px = alignForward(input.bars.get(r.security)!, allDates);
    const fx = fxSeries(r.currency, allDates);
    valueSeries.set(
      r,
      px.map((p, i) => (finite(p) && finite(fx[i]) ? r.q! * p * r.priceScale * fx[i]! : null)),
    );
  }
  let startIdx = allDates.findIndex((_, i) => inRange.every((r) => finite(valueSeries.get(r)![i])));
  if (startIdx < 0) startIdx = allDates.length;
  if (startIdx > 0 && startIdx < allDates.length) {
    warnings.push(`Performance starts ${allDates[startIdx]}, the first date with prices for every holding.`);
  }
  const dates = allDates.slice(startIdx);
  const V = dates.map((_, j) => inRange.reduce((s, r) => s + valueSeries.get(r)![startIdx + j]!, 0));
  const benchAligned = dates.length ? alignForward(input.benchmark.bars, dates) : [];

  const rp: number[] = [];
  const rb: (number | null)[] = [];
  for (let i = 1; i < V.length; i++) {
    rp.push(V[i - 1] !== 0 ? V[i] / V[i - 1] - 1 : 0);
    const b0 = benchAligned[i - 1];
    const b1 = benchAligned[i];
    rb.push(finite(b0) && finite(b1) && b0 !== 0 ? b1 / b0 - 1 : null);
  }

  const firstBench = benchAligned.find(finite) ?? null;
  const points = dates.map((d, i) => ({
    t: Date.parse(`${d}T00:00:00Z`),
    portfolio: V[0] ? (V[i] / V[0] - 1) * 100 : 0,
    benchmark: finite(benchAligned[i]) && finite(firstBench) ? (benchAligned[i]! / firstBench - 1) * 100 : null,
  }));
  const totalReturn = V.length > 1 && V[0] !== 0 ? V[V.length - 1] / V[0] - 1 : null;
  const lastBench = [...benchAligned].reverse().find(finite) ?? null;
  const benchReturn = finite(firstBench) && finite(lastBench) ? lastBench / firstBench - 1 : null;
  const annualized = totalReturn !== null && rp.length >= 20 ? Math.pow(1 + totalReturn, TRADING_DAYS / rp.length) - 1 : null;

  // ---- Risk ----
  const n = rp.length;
  const paired = rp.map((r, i) => [r, rb[i]] as const).filter((x): x is readonly [number, number] => finite(x[1]));
  const pr = paired.map((x) => x[0]);
  const br = paired.map((x) => x[1]);
  const volD = stdev(rp);
  const benchVolD = stdev(br);
  const beta = paired.length > 2 ? covariance(pr, br) / (benchVolD * benchVolD) : NaN;
  const active = paired.map(([p, b]) => p - b);
  const te = stdev(active) * Math.sqrt(TRADING_DAYS);
  const benchAnn = benchReturn !== null && br.length >= 20 ? Math.pow(1 + benchReturn, TRADING_DAYS / br.length) - 1 : null;
  const rf = input.riskFreePct !== null ? input.riskFreePct / 100 : null;
  const vol = volD * Math.sqrt(TRADING_DAYS);
  const dd = V.length > 1 ? maxDrawdown(V) : null;
  const q05 = n >= 20 ? quantile(rp, 0.05) : NaN;
  const tail = rp.filter((r) => r <= q05);

  const risk: PortfolioAnalytics["risk"] = {
    observations: n,
    volatilityPct: n >= 2 ? orNull(vol * 100) : null,
    benchmarkVolatilityPct: br.length >= 2 ? orNull(benchVolD * Math.sqrt(TRADING_DAYS) * 100) : null,
    beta: orNull(beta),
    correlation: paired.length > 2 ? correlation(pr, br) : null,
    trackingErrorPct: paired.length > 2 ? orNull(te * 100) : null,
    informationRatio: annualized !== null && benchAnn !== null && te > 0 ? orNull((annualized - benchAnn) / te) : null,
    sharpe: annualized !== null && rf !== null && vol > 0 ? orNull((annualized - rf) / vol) : null,
    riskFreePct: input.riskFreePct,
    maxDrawdownPct: dd ? dd.pct * 100 : null,
    maxDrawdownPeak: dd && dd.pct < 0 ? dates[dd.peak] : null,
    maxDrawdownTrough: dd && dd.pct < 0 ? dates[dd.trough] : null,
    var95Historical: Number.isFinite(q05) ? Math.max(0, -q05) * totalMv : null,
    var95Parametric: n >= 20 ? Math.max(0, Z95 * volD - mean(rp)) * totalMv : null,
    cvar95: tail.length ? Math.max(0, -mean(tail)) * totalMv : null,
  };

  // ---- Per-holding returns, contribution, risk contribution ----
  const holdingReturns = new Map<Row, number[]>();
  for (const r of inRange) {
    const vs = valueSeries.get(r)!.slice(startIdx) as number[];
    const rets: number[] = [];
    let contribution = 0;
    for (let i = 1; i < vs.length; i++) {
      const ret = vs[i - 1] !== 0 ? vs[i] / vs[i - 1] - 1 : 0;
      rets.push(ret);
      contribution += V[i - 1] !== 0 ? (vs[i - 1] / V[i - 1]) * ret : 0;
    }
    holdingReturns.set(r, rets);
    r.periodReturnPct = vs.length > 1 && vs[0] !== 0 ? (vs[vs.length - 1] / vs[0] - 1) * 100 : null;
    r.contributionPct = vs.length > 1 ? contribution * 100 : null;
  }
  const varP = volD * volD;
  if (n > 2 && varP > 0 && weightsUsable) {
    const raw = inRange.map((r) => ((r.weightPct ?? 0) / 100) * covariance(holdingReturns.get(r)!, rp));
    const total = raw.reduce((s, x) => s + x, 0);
    inRange.forEach((r, i) => {
      r.riskContributionPct = total !== 0 ? orNull((raw[i] / total) * 100) : null;
    });
  }

  const weightsBySecurity = new Map<string, number>();
  for (const r of inRange) weightsBySecurity.set(r.security, (weightsBySecurity.get(r.security) ?? 0) + (r.weightPct ?? 0));
  const top = [...new Map(inRange.map((r) => [r.security, r])).values()]
    .sort((a, b) => Math.abs(weightsBySecurity.get(b.security)!) - Math.abs(weightsBySecurity.get(a.security)!))
    .slice(0, 8);
  const matrix = top.map((a) => top.map((b) => (a === b ? 1 : correlation(holdingReturns.get(a)!, holdingReturns.get(b)!))));

  const exposures = weightsUsable
    ? {
        assetClass: exposure(priced.map((r) => ({ key: r.assetClass, value: r.marketValue! })), totalMv),
        sector: exposure(priced.map((r) => ({ key: r.sector, value: r.marketValue! })), totalMv),
        country: exposure(priced.map((r) => ({ key: r.country, value: r.marketValue! })), totalMv),
        currency: exposure(priced.map((r) => ({ key: r.currency, value: r.marketValue! })), totalMv),
      }
    : { assetClass: [], sector: [], country: [], currency: [] };

  const bySectorMap = new Map<string, { weightPct: number; contributionPct: number }>();
  for (const r of priced) {
    const s = bySectorMap.get(r.sector) ?? { weightPct: 0, contributionPct: 0 };
    s.weightPct += r.weightPct ?? 0;
    s.contributionPct += r.contributionPct ?? 0;
    bySectorMap.set(r.sector, s);
  }
  const contributions = inRange.map((r) => r.contributionPct).filter(finite);

  return {
    name: input.name,
    kind: input.kind,
    baseCurrency: base,
    asOf: new Date(input.now).toISOString(),
    range: input.range,
    benchmark: input.benchmark.security,
    totals,
    holdings: rows.map(({ q: _q, ...rest }) => rest),
    performance: {
      start: dates[0] ?? null,
      points,
      totalReturnPct: totalReturn !== null ? totalReturn * 100 : null,
      benchmarkReturnPct: benchReturn !== null ? benchReturn * 100 : null,
      annualizedPct: annualized !== null ? annualized * 100 : null,
    },
    risk,
    correlation: { securities: top.map((r) => r.security), matrix },
    exposures,
    attribution: {
      bySector: [...bySectorMap.entries()]
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => b.contributionPct - a.contributionPct),
      totalContributionPct: contributions.length ? contributions.reduce((s, x) => s + x, 0) : null,
    },
    warnings,
  };
}
