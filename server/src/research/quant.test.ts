import { describe, expect, it } from "vitest";
import { blackScholes, bondAnalytics, normCdf } from "./quant.js";

describe("normCdf", () => {
  it("matches reference values", () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 7);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021, 6);
    expect(normCdf(-1)).toBeCloseTo(0.1586553, 6);
  });
});

describe("blackScholes", () => {
  const base = { spot: 100, strike: 100, t: 1, vol: 0.2, rate: 0.05, carry: 0 };

  it("prices the textbook at-the-money option (Hull)", () => {
    expect(blackScholes("call", base).price).toBeCloseTo(10.4506, 3);
    expect(blackScholes("put", base).price).toBeCloseTo(5.5735, 3);
  });

  it("satisfies put-call parity with a dividend yield", () => {
    const o = { ...base, strike: 95, carry: 0.02, t: 0.5 };
    const c = blackScholes("call", o).price;
    const p = blackScholes("put", o).price;
    expect(c - p).toBeCloseTo(o.spot * Math.exp(-o.carry * o.t) - o.strike * Math.exp(-o.rate * o.t), 6);
  });

  it("returns standard greeks", () => {
    const c = blackScholes("call", base);
    expect(c.delta).toBeCloseTo(0.6368, 3);
    expect(c.gamma).toBeCloseTo(0.01876, 4);
    expect(c.vega).toBeCloseTo(0.3752, 3);
    expect(c.theta).toBeCloseTo(-6.414 / 365, 4);
    expect(c.rho).toBeCloseTo(0.5323, 3);
    expect(blackScholes("put", base).delta).toBeCloseTo(c.delta - 1, 6);
  });

  it("falls back to intrinsic value at expiry", () => {
    expect(blackScholes("call", { ...base, spot: 110, t: 0 }).price).toBe(10);
    expect(blackScholes("put", { ...base, spot: 110, t: 0 }).price).toBe(0);
  });
});

describe("bondAnalytics", () => {
  it("prices a par bond at 100", () => {
    const b = bondAnalytics({ coupon: 0.05, years: 10, ytm: 0.05, frequency: 2 });
    expect(b.price).toBeCloseTo(100, 8);
    expect(b.macaulayDuration).toBeCloseTo(7.9894, 3);
    expect(b.modifiedDuration).toBeCloseTo(7.7946, 3);
    expect(b.dv01).toBeCloseTo(0.077946, 5);
  });

  it("prices a zero-coupon bond by discounting", () => {
    const b = bondAnalytics({ coupon: 0, years: 5, ytm: 0.04, frequency: 2 });
    expect(b.price).toBeCloseTo(100 / Math.pow(1.02, 10), 8);
    expect(b.macaulayDuration).toBeCloseTo(5, 8);
  });

  it("uses convexity consistent with a finite-difference estimate", () => {
    const at = (y: number) => bondAnalytics({ coupon: 0.04, years: 30, ytm: y, frequency: 2 }).price;
    const h = 0.0001;
    const numeric = (at(0.05 + h) + at(0.05 - h) - 2 * at(0.05)) / (at(0.05) * h * h);
    expect(bondAnalytics({ coupon: 0.04, years: 30, ytm: 0.05, frequency: 2 }).convexity).toBeCloseTo(numeric, 0);
  });
});
