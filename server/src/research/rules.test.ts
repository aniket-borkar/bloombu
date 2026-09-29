import { describe, expect, it } from "vitest";
import { RuleError, evaluateRule, parseRule, ruleSignal, type RuleBar } from "./rules.js";

const DAY = 86_400_000;
const bars = (closes: number[], extra: Partial<RuleBar> = {}): RuleBar[] =>
  closes.map((c, i) => ({ t: i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1000 + i, ...extra }));

describe("parseRule", () => {
  it("parses precedence, words and comparisons", () => {
    expect(() => parseRule("sma(close, 50) > sma(close, 200) and not rsi(close) > 70 or close = 5")).not.toThrow();
    expect(evaluateRule("1 + 2 * 3", bars([1]))).toEqual([7]);
    expect(evaluateRule("(1 + 2) * 3 > 8", bars([1]))).toEqual([1]);
  });

  it.each([
    ["", /empty/],
    ["foo(close)", /Unknown name "foo"/],
    ["sma(close)", /takes 2 arguments/],
    ["sma(close, 0)", /lookback/],
    ["sma(close, 2.5)", /lookback/],
    ["sma(close, n)", /Unknown name "n"/],
    ["close >", /ended/],
    ["close > 1 1", /Unexpected "1"/],
    ["close # 1", /Unexpected "#"/],
  ])("rejects %s with a position", (src, message) => {
    expect(() => parseRule(src)).toThrow(message);
    try {
      parseRule(src);
    } catch (e) {
      expect(e).toBeInstanceOf(RuleError);
    }
  });
});

describe("indicators", () => {
  const b = bars([1, 2, 3, 4, 5, 6]);

  it("computes rolling and shifted series", () => {
    expect(evaluateRule("sma(close, 3)", b).map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, 2, 3, 4, 5]);
    expect(evaluateRule("highest(high, 2)", b).map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, 3, 4, 5, 6, 7]);
    expect(evaluateRule("lowest(low, 2)", b).map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, 0, 1, 2, 3, 4]);
    expect(evaluateRule("prev(close, 2)", b).map((v) => (Number.isNaN(v) ? null : v))).toEqual([null, null, 1, 2, 3, 4]);
    expect(evaluateRule("change(close)", b)[1]).toBeCloseTo(100, 10);
  });

  it("seeds EMA with the SMA of the first n values", () => {
    const e = evaluateRule("ema(close, 3)", b);
    expect(Number.isNaN(e[1])).toBe(true);
    expect(e[2]).toBeCloseTo(2, 10);
    expect(e[3]).toBeCloseTo(4 * 0.5 + 2 * 0.5, 10);
  });

  it("computes Wilder RSI", () => {
    const up = evaluateRule("rsi(close, 3)", bars([1, 2, 3, 4, 5]));
    expect(up[3]).toBe(100);
    const mixed = evaluateRule("rsi(close, 2)", bars([10, 11, 10, 11]));
    expect(mixed[2]).toBeCloseTo(50, 10);
    expect(mixed[3]).toBeCloseTo(100 - 100 / (1 + 0.75 / 0.25), 10);
  });

  it("detects crosses only on the crossing bar", () => {
    const b2 = bars([1, 1, 3, 4, 2, 1]);
    expect(ruleSignal("crossAbove(close, 2)", b2)).toEqual([false, false, true, false, false, false]);
    expect(ruleSignal("crossBelow(close, 2)", b2)).toEqual([false, false, false, false, false, true]);
  });

  it("treats undefined values as false in signals and handles missing volume", () => {
    expect(ruleSignal("sma(close, 5) > 0", b)).toEqual([false, false, false, false, true, true]);
    expect(ruleSignal("volume > 0", bars([1, 2], { v: null }))).toEqual([false, false]);
  });
});
