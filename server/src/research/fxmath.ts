import type { ForwardCurve, OvernightRate } from "../types.js";

/** Money-market day-count basis: ACT/365 for these currencies, ACT/360 for the rest. */
const ACT365 = new Set(["GBP", "CAD", "AUD", "NZD", "HKD", "SGD", "ZAR"]);

export const FORWARD_TENORS: [string, number][] = [
  ["1W", 7],
  ["2W", 14],
  ["1M", 30],
  ["2M", 61],
  ["3M", 91],
  ["6M", 182],
  ["9M", 273],
  ["1Y", 365],
];

export const dayBasis = (currency: string) => (ACT365.has(currency) ? 365 : 360);

/**
 * Theoretical outright forwards by covered interest parity:
 * F = S · (1 + r_quote · d/basis_quote) / (1 + r_base · d/basis_base), with each
 * currency's official overnight rate held flat across tenors.
 */
export function forwardCurve(security: string, spot: number, base: OvernightRate, quote: OvernightRate, tenors = FORWARD_TENORS): ForwardCurve {
  const pip = quote.currency === "JPY" ? 0.01 : 0.0001;
  const growth = (r: OvernightRate, days: number) => 1 + (r.ratePct / 100) * (days / dayBasis(r.currency));
  return {
    security,
    spot,
    base,
    quote,
    rows: tenors.map(([tenor, days]) => {
      const outright = (spot * growth(quote, days)) / growth(base, days);
      return { tenor, days, outright, points: (outright - spot) / pip };
    }),
    method:
      "Covered interest parity from each currency's official overnight rate, held flat. Dealer forward points also price expected rate changes and the cross-currency basis, so longer tenors can differ.",
  };
}
