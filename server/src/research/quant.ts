// Pure pricing math shared by the server (mock option chains) and the client
// calculators (OVML, YAS). No Node or DOM dependencies.

/** Standard normal CDF (Zelen & Severo 26.2.17, |error| < 7.5e-8). */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export function normPdf(x: number): number {
  return 0.3989422804014327 * Math.exp((-x * x) / 2);
}

export interface OptionInputs {
  spot: number;
  strike: number;
  /** Years to expiry. */
  t: number;
  /** Annualized volatility as a fraction. */
  vol: number;
  /** Continuously compounded risk-free rate as a fraction. */
  rate: number;
  /** Continuous dividend yield (or foreign rate for FX) as a fraction. */
  carry: number;
}

export interface OptionValue {
  price: number;
  delta: number;
  gamma: number;
  /** Price change per 1 vol point (0.01). */
  vega: number;
  /** Price change per calendar day. */
  theta: number;
  /** Price change per 1% (0.01) rate move. */
  rho: number;
}

/** Black-Scholes-Merton (Garman-Kohlhagen for FX when `carry` is the foreign rate). */
export function blackScholes(kind: "call" | "put", o: OptionInputs): OptionValue {
  const { spot: S, strike: K, t, vol: v, rate: r, carry: q } = o;
  if (!(S > 0 && K > 0 && t > 0 && v > 0)) {
    const intrinsic = Math.max(kind === "call" ? S - K : K - S, 0);
    return { price: intrinsic, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0 };
  }
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(S / K) + (r - q + (v * v) / 2) * t) / (v * sqrtT);
  const d2 = d1 - v * sqrtT;
  const dfr = Math.exp(-r * t);
  const dfq = Math.exp(-q * t);
  const gamma = (dfq * normPdf(d1)) / (S * v * sqrtT);
  const vega = (S * dfq * normPdf(d1) * sqrtT) / 100;
  if (kind === "call") {
    const price = S * dfq * normCdf(d1) - K * dfr * normCdf(d2);
    const theta = (-(S * dfq * normPdf(d1) * v) / (2 * sqrtT) - r * K * dfr * normCdf(d2) + q * S * dfq * normCdf(d1)) / 365;
    return { price, delta: dfq * normCdf(d1), gamma, vega, theta, rho: (K * t * dfr * normCdf(d2)) / 100 };
  }
  const price = K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
  const theta = (-(S * dfq * normPdf(d1) * v) / (2 * sqrtT) + r * K * dfr * normCdf(-d2) - q * S * dfq * normCdf(-d1)) / 365;
  return { price, delta: -dfq * normCdf(-d1), gamma, vega, theta, rho: (-K * t * dfr * normCdf(-d2)) / 100 };
}

export interface BondInputs {
  /** Annual coupon rate as a fraction. */
  coupon: number;
  /** Years to maturity, a whole number of coupon periods from settlement. */
  years: number;
  /** Yield to maturity as a fraction, compounded at the coupon frequency. */
  ytm: number;
  /** Coupons per year. */
  frequency: number;
}

export interface BondValue {
  /** Price per 100 face. Settlement is assumed to fall on a coupon date (no accrued interest). */
  price: number;
  macaulayDuration: number;
  modifiedDuration: number;
  convexity: number;
  /** Price change per 100 face for a 1bp yield decrease. */
  dv01: number;
}

export function bondAnalytics({ coupon, years, ytm, frequency: f }: BondInputs): BondValue {
  const n = Math.max(1, Math.round(years * f));
  const c = (coupon * 100) / f;
  const y = ytm / f;
  let price = 0;
  let weighted = 0;
  let convex = 0;
  for (let k = 1; k <= n; k++) {
    const cf = c + (k === n ? 100 : 0);
    const df = Math.pow(1 + y, -k);
    price += cf * df;
    weighted += k * cf * df;
    convex += k * (k + 1) * cf * df;
  }
  const macaulayDuration = weighted / price / f;
  const modifiedDuration = macaulayDuration / (1 + y);
  const convexity = convex / (price * Math.pow(1 + y, 2) * f * f);
  return { price, macaulayDuration, modifiedDuration, convexity, dv01: (modifiedDuration * price) / 10_000 };
}
