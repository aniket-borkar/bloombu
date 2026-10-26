import type { Bar } from "../types.js";

export interface BacktestInput {
  bars: Bar[];
  entry: boolean[];
  /** Exit signal per bar; null means "exit when the entry rule is no longer true". */
  exit: boolean[] | null;
  direction: "long" | "short";
  /** Cost per side in basis points of traded value. */
  costBps: number;
}

export interface Trade {
  entryDate: number;
  entryPrice: number;
  exitDate: number;
  exitPrice: number;
  returnPct: number;
  bars: number;
  open: boolean;
}

export interface BacktestStats {
  totalReturnPct: number;
  buyHoldReturnPct: number;
  cagrPct: number | null;
  volatilityPct: number | null;
  sharpe: number | null;
  maxDrawdownPct: number;
  trades: number;
  winRatePct: number | null;
  avgTradePct: number | null;
  bestTradePct: number | null;
  worstTradePct: number | null;
  exposurePct: number;
}

export interface BacktestResult {
  curve: { t: number; strategy: number; buyHold: number }[];
  trades: Trade[];
  stats: BacktestStats;
}

/**
 * Daily backtest. Signals are read at each bar's close and orders fill at the
 * next bar's open (no look-ahead). Positions are 100% of equity, marked to the
 * close each day; costs are charged on entry and exit.
 */
export function backtest({ bars, entry, exit, direction, costBps }: BacktestInput): BacktestResult {
  const n = bars.length;
  const side = direction === "long" ? 1 : -1;
  const cost = costBps / 10_000;
  let equity = 1;
  let pos = 0;
  let mark = 0;
  let entryPrice = 0;
  let entryIdx = 0;
  let entryEquity = 1;
  let pending: "enter" | "exit" | null = null;
  let barsInMarket = 0;
  const trades: Trade[] = [];
  const equityCurve: number[] = [];

  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (pending === "enter") {
      pos = side;
      entryPrice = b.o;
      mark = b.o;
      entryIdx = i;
      entryEquity = equity;
      equity *= 1 - cost;
    } else if (pending === "exit") {
      equity *= 1 + pos * (b.o / mark - 1);
      equity *= 1 - cost;
      trades.push({
        entryDate: bars[entryIdx].t,
        entryPrice,
        exitDate: b.t,
        exitPrice: b.o,
        returnPct: (equity / entryEquity - 1) * 100,
        bars: i - entryIdx,
        open: false,
      });
      pos = 0;
    }
    pending = null;
    if (pos !== 0) {
      equity *= 1 + pos * (b.c / mark - 1);
      mark = b.c;
      barsInMarket++;
    }
    equityCurve.push(equity);
    if (i === n - 1) break;
    const wantExit = exit ? exit[i] : !entry[i];
    if (pos === 0 && entry[i]) pending = "enter";
    else if (pos !== 0 && wantExit) pending = "exit";
  }
  if (pos !== 0 && n) {
    trades.push({
      entryDate: bars[entryIdx].t,
      entryPrice,
      exitDate: bars[n - 1].t,
      exitPrice: bars[n - 1].c,
      returnPct: (equity / entryEquity - 1) * 100,
      bars: n - 1 - entryIdx,
      open: true,
    });
  }

  const first = bars[0]?.c ?? 1;
  const curve = bars.map((b, i) => ({ t: b.t, strategy: (equityCurve[i] - 1) * 100, buyHold: (b.c / first - 1) * 100 }));
  const rets = equityCurve.slice(1).map((e, i) => e / equityCurve[i] - 1);
  const mean = rets.length ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  let peak = -Infinity;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDd = Math.min(maxDd, e / peak - 1);
  }
  const closed = trades.map((t) => t.returnPct);
  const years = n > 1 ? (bars[n - 1].t - bars[0].t) / (365.25 * 86_400_000) : 0;

  return {
    curve,
    trades,
    stats: {
      totalReturnPct: (equity - 1) * 100,
      buyHoldReturnPct: n ? (bars[n - 1].c / first - 1) * 100 : 0,
      cagrPct: years >= 0.25 ? (Math.pow(equity, 1 / years) - 1) * 100 : null,
      volatilityPct: sd ? sd * Math.sqrt(252) * 100 : null,
      sharpe: sd ? (mean / sd) * Math.sqrt(252) : null,
      maxDrawdownPct: maxDd * 100,
      trades: trades.length,
      winRatePct: closed.length ? (closed.filter((r) => r > 0).length / closed.length) * 100 : null,
      avgTradePct: closed.length ? closed.reduce((s, r) => s + r, 0) / closed.length : null,
      bestTradePct: closed.length ? Math.max(...closed) : null,
      worstTradePct: closed.length ? Math.min(...closed) : null,
      exposurePct: n ? (barsInMarket / n) * 100 : 0,
    },
  };
}
