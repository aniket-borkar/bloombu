import { describe, expect, it } from "vitest";
import type { Bar } from "../types.js";
import { backtest } from "./backtest.js";
import { ruleSignal } from "./rules.js";

const DAY = 86_400_000;
const bars = (rows: [number, number][]): Bar[] => rows.map(([o, c], i) => ({ t: i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 }));

describe("backtest", () => {
  const b = bars([
    [100, 100],
    [100, 110],
    [110, 121],
    [121, 121],
    [120, 132],
  ]);

  it("fills at the next open and marks to the close", () => {
    const r = backtest({ bars: b, entry: [true, false, false, false, false], exit: [false, true, false, false, false], direction: "long", costBps: 0 });
    expect(r.trades).toEqual([{ entryDate: DAY, entryPrice: 100, exitDate: 2 * DAY, exitPrice: 110, returnPct: expect.closeTo(10, 8), bars: 1, open: false }]);
    expect(r.curve.map((p) => +p.strategy.toFixed(6))).toEqual([0, 10, 10, 10, 10]);
    expect(r.stats.totalReturnPct).toBeCloseTo(10, 8);
    expect(r.stats.buyHoldReturnPct).toBeCloseTo(32, 8);
    expect(r.stats.exposurePct).toBeCloseTo(20, 8);
  });

  it("charges costs on both sides", () => {
    const r = backtest({ bars: b, entry: [true, false, false, false, false], exit: [false, true, false, false, false], direction: "long", costBps: 10 });
    expect(r.stats.totalReturnPct).toBeCloseTo((0.999 * 1.1 * 0.999 - 1) * 100, 8);
  });

  it("uses 'entry no longer true' as the default exit and reports open trades", () => {
    const r = backtest({ bars: b, entry: [true, true, false, true, true], exit: null, direction: "long", costBps: 0 });
    expect(r.trades.map((t) => [t.entryPrice, t.exitPrice, t.open])).toEqual([
      [100, 121, false],
      [120, 132, true],
    ]);
    expect(r.stats.winRatePct).toBe(100);
  });

  it("profits from declines when short", () => {
    const down = bars([
      [100, 100],
      [100, 90],
      [90, 81],
    ]);
    const r = backtest({ bars: down, entry: [true, false, false], exit: null, direction: "short", costBps: 0 });
    expect(r.stats.totalReturnPct).toBeCloseTo(10, 8);
    expect(r.stats.maxDrawdownPct).toBe(0);
  });

  it("runs a golden-cross rule end to end", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + 20 * Math.sin(i / 25) + i * 0.05);
    const series = closes.map((c, i) => ({ t: i * DAY, o: c, h: c, l: c, c, v: null }));
    const entry = ruleSignal("crossAbove(sma(close, 10), sma(close, 30))", series);
    const exit = ruleSignal("crossBelow(sma(close, 10), sma(close, 30))", series);
    const r = backtest({ bars: series, entry, exit, direction: "long", costBps: 5 });
    expect(r.trades.length).toBeGreaterThan(1);
    expect(r.curve).toHaveLength(300);
    expect(r.stats.maxDrawdownPct).toBeLessThanOrEqual(0);
    expect(r.stats.sharpe).not.toBeNull();
  });
});
