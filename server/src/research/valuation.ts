import type express from "express";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity, sectorOf } from "../symbology.js";

interface ValuationCommon {
  security: string;
  /** All monetary inputs use these same units, including the quoted price. */
  currency: string;
  currentPrice: number | null;
  growthPct: number;
  years: number;
}

export type ValuationInput = ValuationCommon & (
  | { method: "earnings"; eps: number; requiredReturnPct: number; terminalPE: number; payoutPct: number }
  | { method: "dcf"; freeCashFlow: number; discountRatePct: number; terminalGrowthPct: number; netDebt: number; sharesOutstanding: number }
);

export interface ValuationContext {
  security: string;
  currency: string | null;
  price: number | null;
  priceAsOf: string | null;
  source: string | null;
  trailingPE: number | null;
  inferredEps: number | null;
  sharesOutstanding: number | null;
  warnings: string[];
}

export interface ValuationResult {
  security: string;
  method: ValuationInput["method"];
  currency: string;
  calculatedAt: string;
  assumptions: ValuationInput;
  valuePerShare: number;
  currentPrice: number | null;
  upsidePct: number | null;
  forecast: { year: number; earningsPerShare: number | null; cashFlow: number; discountFactor: number; presentValue: number }[];
  terminalValue: number;
  terminalPresentValue: number;
  enterpriseValue: number | null;
  equityValue: number | null;
  sensitivity: { rowLabel: string; columnLabel: string; rows: number[]; columns: number[]; values: (number | null)[][] };
  methodology: string;
  warnings: string[];
}

export class ValuationError extends Error {}

function number(raw: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = raw[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ValuationError(`${key} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

export function validateValuation(value: unknown, pathSecurity?: string): ValuationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValuationError("valuation assumptions are required");
  const raw = value as Record<string, unknown>;
  const security = normalizeSecurity(pathSecurity ?? (typeof raw.security === "string" ? raw.security : ""));
  if (!security || sectorOf(security) !== "Equity") throw new ValuationError("An equity security is required, e.g. AAPL US Equity");
  const currency = typeof raw.currency === "string" ? raw.currency.trim() : "";
  if (!/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(currency)) throw new ValuationError("currency must identify the monetary units used by every model input");
  const common: ValuationCommon = {
    security,
    currency,
    currentPrice: raw.currentPrice === null || raw.currentPrice === undefined ? null : number(raw, "currentPrice", 0.000001, 1e12),
    growthPct: number(raw, "growthPct", -99, 200),
    years: number(raw, "years", 1, 20),
  };
  if (!Number.isInteger(common.years)) throw new ValuationError("years must be a whole number from 1 to 20");
  if (raw.method === "earnings") {
    return {
      ...common,
      method: "earnings",
      eps: number(raw, "eps", 0, 1e9),
      requiredReturnPct: number(raw, "requiredReturnPct", 0, 100),
      terminalPE: number(raw, "terminalPE", 0.01, 200),
      payoutPct: number(raw, "payoutPct", 0, 100),
    };
  }
  if (raw.method !== "dcf") throw new ValuationError("method must be earnings or dcf");
  const discountRatePct = number(raw, "discountRatePct", 0.01, 100);
  const terminalGrowthPct = number(raw, "terminalGrowthPct", -10, 20);
  if (discountRatePct <= terminalGrowthPct) throw new ValuationError("discountRatePct must exceed terminalGrowthPct");
  return {
    ...common,
    method: "dcf",
    freeCashFlow: number(raw, "freeCashFlow", -1e15, 1e15),
    discountRatePct,
    terminalGrowthPct,
    netDebt: number(raw, "netDebt", -1e15, 1e15),
    sharesOutstanding: number(raw, "sharesOutstanding", 1, 1e15),
  };
}

/** Year-end discounting; calculations never fetch or invent model assumptions. */
function model(input: ValuationInput) {
  const rate = (input.method === "earnings" ? input.requiredReturnPct : input.discountRatePct) / 100;
  const forecast: ValuationResult["forecast"] = [];
  let amount = input.method === "earnings" ? input.eps : input.freeCashFlow;
  for (let year = 1; year <= input.years; year++) {
    amount *= 1 + input.growthPct / 100;
    const discountFactor = (1 + rate) ** -year;
    const cashFlow = input.method === "earnings" ? amount * input.payoutPct / 100 : amount;
    forecast.push({ year, earningsPerShare: input.method === "earnings" ? amount : null, cashFlow, discountFactor, presentValue: cashFlow * discountFactor });
  }
  const terminalValue = input.method === "earnings"
    ? amount * input.terminalPE
    : amount * (1 + input.terminalGrowthPct / 100) / (rate - input.terminalGrowthPct / 100);
  const terminalPresentValue = terminalValue * (1 + rate) ** -input.years;
  const presentValue = forecast.reduce((sum, row) => sum + row.presentValue, terminalPresentValue);
  const enterpriseValue = input.method === "dcf" ? presentValue : null;
  const equityValue = input.method === "dcf" ? presentValue - input.netDebt : null;
  const valuePerShare = input.method === "dcf" ? equityValue! / input.sharesOutstanding : presentValue;
  return { forecast, terminalValue, terminalPresentValue, enterpriseValue, equityValue, valuePerShare };
}

const axis = (center: number, step: number, min: number, max: number): number[] =>
  [...new Set([-2, -1, 0, 1, 2].map((i) => i === 0 ? center : Number(Math.min(max, Math.max(min, center + i * step)).toFixed(6))))];

export function calculateValuation(raw: ValuationInput, now: () => number = Date.now): ValuationResult {
  const input = validateValuation(raw);
  const result = model(input);
  if (!Number.isFinite(result.valuePerShare) || !Number.isFinite(result.terminalValue)) throw new ValuationError("These assumptions exceed the model's numeric range");
  const rows = input.method === "earnings" ? axis(input.growthPct, 5, -99, 200) : axis(input.discountRatePct, 1, 0.01, 100);
  const columns = input.method === "earnings" ? axis(input.terminalPE, Math.max(1, input.terminalPE * 0.1), 0.01, 200) : axis(input.terminalGrowthPct, 0.5, -10, 20);
  const values = rows.map((row) => columns.map((col): number | null => {
    if (input.method === "dcf" && row <= col) return null;
    const cell = model(input.method === "earnings"
      ? { ...input, growthPct: row, terminalPE: col }
      : { ...input, discountRatePct: row, terminalGrowthPct: col }).valuePerShare;
    return Number.isFinite(cell) ? cell : null;
  }));
  const warnings = ["Model outputs depend on your assumptions; they are not forecasts or recommendations."];
  if (input.growthPct > 25) warnings.push("High growth sustained for the full horizon can dominate the result.");
  if (input.method === "dcf") {
    warnings.push("Enter unlevered free cash flow to the firm (FCFF). Reported operating cash flow minus capex is not automatically FCFF.");
    warnings.push("FCFF, net debt, and the quoted price must use the same currency; shares must correspond to that listing. No FX or depositary-ratio adjustment is inferred.");
    if (input.freeCashFlow <= 0) warnings.push("Constant growth does not turn negative or zero FCFF into positive FCFF; this model does not forecast a turnaround.");
    if (input.discountRatePct - input.terminalGrowthPct < 2) warnings.push("The discount rate is close to terminal growth, making the terminal value particularly sensitive.");
    if (result.enterpriseValue! > 0 && result.terminalPresentValue / result.enterpriseValue! > 0.75) warnings.push("More than 75% of enterprise value comes from the terminal assumption.");
    if (result.valuePerShare < 0) warnings.push("Net debt or negative cash flows imply a negative residual equity value in this model; equity prices do not become a liability to shareholders.");
  } else {
    warnings.push("The terminal P/E is a user assumption. This constant-growth model does not model buybacks, dilution, or changes in payout policy.");
    if (input.eps === 0) warnings.push("A zero starting EPS produces zero earnings and dividends throughout this model.");
  }
  return {
    ...result,
    security: input.security,
    method: input.method,
    currency: input.currency,
    calculatedAt: new Date(now()).toISOString(),
    assumptions: input,
    currentPrice: input.currentPrice,
    upsidePct: input.currentPrice !== null ? (result.valuePerShare / input.currentPrice - 1) * 100 : null,
    sensitivity: { rowLabel: input.method === "earnings" ? "Earnings growth (%)" : "Discount rate / WACC (%)", columnLabel: input.method === "earnings" ? "Terminal P/E (x)" : "Terminal growth (%)", rows, columns, values },
    methodology: input.method === "earnings"
      ? "Projected annual EPS grows at the assumed rate. Annual dividends equal EPS times payout ratio. Discount dividends and the horizon-end EPS times terminal P/E at the required equity return. All values are per share."
      : "Project annual unlevered FCFF, discount at WACC, and add the discounted Gordon terminal value using the following year's FCFF. Subtract net debt (debt less cash) and divide by diluted shares. Cash flows occur at year end. Other non-operating assets, minority interests, and options are not modeled.",
    warnings,
  };
}

export async function valuationContext(router: ProviderRouter, security: string): Promise<ValuationContext> {
  const [quote, profile] = await Promise.all([
    router.quote(security).catch(() => null),
    router.first("profile", security, (p) => p.profile!(security)).catch(() => null),
  ]);
  const price = quote?.last !== null && quote?.last !== undefined && Number.isFinite(quote.last) && quote.last > 0 ? quote.last : null;
  const candidate = profile?.pe;
  const trailingPE = typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
  const shares = profile?.sharesOutstanding;
  const warnings = ["Reference observations are separate from editable valuation assumptions."];
  if (price === null) warnings.push("No current quote is available; enter your own reference price or leave it blank.");
  if (price === null || trailingPE === null) warnings.push("Quote-consistent EPS could not be inferred from a positive price and trailing P/E; enter an EPS assumption manually.");
  else warnings.push("Inferred EPS equals the reference price divided by trailing P/E. It is not a directly reported earnings figure.");
  return {
    security,
    currency: quote?.currency ?? null,
    price,
    priceAsOf: quote?.time ?? null,
    source: [...new Set([quote?.source, profile?.source].filter(Boolean))].join("; ") || null,
    trailingPE,
    inferredEps: price !== null && trailingPE !== null ? price / trailingPE : null,
    sharesOutstanding: typeof shares === "number" && Number.isFinite(shares) && shares > 0 ? shares : null,
    warnings,
  };
}

export function registerValuationRoutes(app: express.Express, router: ProviderRouter): void {
  const securityOf = (value: unknown): string => {
    const security = normalizeSecurity(typeof value === "string" ? value : "");
    if (!security || sectorOf(security) !== "Equity") throw new ValuationError("An equity security is required");
    return security;
  };
  app.get("/api/research/valuation/:security", async (req, res) => {
    try {
      res.json(await valuationContext(router, securityOf(req.params.security)));
    } catch (err) {
      res.status(err instanceof ValuationError ? 400 : 502).json({ error: err instanceof Error ? err.message : "VALUATION REFERENCE UNAVAILABLE" });
    }
  });
  app.post("/api/research/valuation/:security", (req, res) => {
    try {
      res.json(calculateValuation(validateValuation(req.body, securityOf(req.params.security))));
    } catch (err) {
      res.status(err instanceof ValuationError ? 400 : 500).json({ error: err instanceof Error ? err.message : "VALUATION UNAVAILABLE" });
    }
  });
}
