import { describe, expect, it } from "vitest";
import type { Bar } from "../api";
import { alignedReturns, benchmarkFor, periodReturn, regress, totalReturnTable } from "./analytics";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1, 13, 30);
const bars = (closes: number[], step = DAY, t0 = T0): Bar[] =>
  closes.map((c, i) => ({ t: t0 + i * step, o: c, h: c, l: c, c, v: null }));

describe("regress", () => {
  it("recovers a known linear relationship", () => {
    const x = [0.01, -0.02, 0.03, 0.005, -0.01, 0.02];
    const y = x.map((v) => 0.001 + 1.5 * v);
    const r = regress(x, y)!;
    expect(r.beta).toBeCloseTo(1.5, 10);
    expect(r.alpha).toBeCloseTo(0.001, 10);
    expect(r.r2).toBeCloseTo(1, 10);
    expect(r.adjustedBeta).toBeCloseTo(0.67 * 1.5 + 0.33, 10);
    expect(r.n).toBe(6);
  });

  it("returns null without variation or enough points", () => {
    expect(regress([0.01, 0.01, 0.01], [0.02, 0.01, 0.03])).toBeNull();
    expect(regress([0.01], [0.02])).toBeNull();
  });
});

describe("alignedReturns", () => {
  it("aligns on calendar date and skips unmatched bars", () => {
    const stock = bars([100, 110, 121, 133.1]);
    const index = [...bars([10, 11]), ...bars([12.1], DAY, T0 + 3 * DAY)];
    const { x, y } = alignedReturns(stock, index);
    expect(y.map((v) => +v.toFixed(6))).toEqual([0.1, 0.21]);
    expect(x.map((v) => +v.toFixed(6))).toEqual([0.1, 0.1]);
  });
});

describe("periodReturn", () => {
  it("reinvests dividends at the ex-date close", () => {
    const b = bars([100, 100, 100, 110]);
    const r = periodReturn(b, [{ date: new Date(T0 + 2 * DAY).toISOString(), amount: 5 }], T0)!;
    expect(r.priceReturn).toBeCloseTo(0.1, 10);
    expect(r.totalReturn).toBeCloseTo(1.05 * 1.1 - 1, 10);
  });

  it("returns null when history does not reach the start", () => {
    expect(periodReturn(bars([100, 101]), [], T0 - 30 * DAY)).toBeNull();
  });

  it("annualizes periods of a year or more", () => {
    const b = bars(Array.from({ length: 800 }, (_, i) => 100 * Math.pow(1.0003, i)));
    const table = totalReturnTable(b, []);
    const oneYear = table.find((r) => r.label === "1Y")!;
    expect(oneYear.annualized).toBeCloseTo(Math.pow(1.0003, 365) - 1, 3);
    expect(table.find((r) => r.label === "5Y")!.totalReturn).toBeNull();
    expect(table.find((r) => r.label === "1M")!.annualized).toBeNull();
  });
});

describe("benchmarkFor", () => {
  it("picks the local index by exchange", () => {
    expect(benchmarkFor("AAPL US Equity")).toBe("SPX Index");
    expect(benchmarkFor("VOD LN Equity")).toBe("UKX Index");
    expect(benchmarkFor("7203 JT Equity")).toBe("NKY Index");
    expect(benchmarkFor("XYZ ZZ Equity")).toBe("SPX Index");
  });
});
