import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import { normalizeSecurity } from "../symbology.js";
import type { PortfolioAnalytics } from "../types.js";
import type { PortfolioService } from "./service.js";
import { ValidationError, type PortfolioStore } from "./store.js";

export interface ScenarioInput {
  name: string;
  marketPct: number;
  sectors: Record<string, number>;
  securities: Record<string, number>;
  /** Percentage change in base-currency value per unit of foreign currency. */
  currencies: Record<string, number>;
}

export interface ScenarioPosition {
  /** Zero-based holding row; separate lots retain separate attribution. */
  row: number;
  security: string;
  name: string;
  sector: string;
  currency: string;
  quantity: number | null;
  currentValue: number | null;
  scenarioValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  priceEffect: number | null;
  fxEffect: number | null;
  interaction: number | null;
  priceShockPct: number;
  fxShockPct: number;
  error: string | null;
}

export interface ScenarioGroup {
  key: string;
  currentValue: number;
  scenarioValue: number;
  pnl: number;
}

export interface ScenarioResult {
  name: string;
  portfolio: string;
  baseCurrency: string;
  asOf: string;
  assumptions: ScenarioInput;
  currentValue: number;
  scenarioValue: number;
  pnl: number;
  pnlPct: number | null;
  grossCurrentValue: number;
  coverage: { valuedRows: number; totalRows: number };
  positions: ScenarioPosition[];
  bySector: ScenarioGroup[];
  byCurrency: ScenarioGroup[];
  warnings: string[];
}

const MAX_SHOCK_PCT = 500;
const clean = (text: string) => text.trim().replace(/\s+/g, " ");
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const percentage = (change: number, denominator: number): number | null => {
  const value = denominator > 0 ? (change / denominator) * 100 : NaN;
  return finite(value) ? value : null;
};

function shock(value: unknown, label: string, fx = false): number {
  if (!finite(value) || value > MAX_SHOCK_PCT || (fx ? value <= -100 : value < -100)) {
    throw new ValidationError(`${label} must be a finite percentage ${fx ? "greater than -100" : "at least -100"} and at most ${MAX_SHOCK_PCT}`);
  }
  return value;
}

function shockMap(raw: unknown, kind: "sectors" | "securities" | "currencies", max: number): Record<string, number> {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError(`${kind} must map names to percentages`);
  const entries = Object.entries(raw);
  if (entries.length > max) throw new ValidationError(`At most ${max} ${kind} shocks`);
  const seen = new Set<string>();
  const normalized = entries.map(([rawKey, value]): [string, number] => {
    let key = clean(rawKey);
    if (!key || key.length > 100) throw new ValidationError(`${kind} names must be 1-100 characters`);
    if (kind === "securities") {
      const security = normalizeSecurity(key);
      if (!security) throw new ValidationError(`Unknown security format "${key}"; use e.g. AAPL US Equity`);
      key = security;
    } else if (kind === "currencies") {
      key = key.toUpperCase();
      if (!/^[A-Z]{3}$/.test(key)) throw new ValidationError("Currency shocks need major 3-letter codes, e.g. GBP");
    }
    const identity = key.toUpperCase();
    if (seen.has(identity)) throw new ValidationError(`Duplicate ${kind} shock for ${key}`);
    seen.add(identity);
    return [key, shock(value, `${kind} ${key}`, kind === "currencies")];
  });
  return Object.fromEntries(normalized);
}

/** Validate untrusted input without fetching quotes or modifying the portfolio. */
export function validateScenario(raw: unknown): ScenarioInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("A scenario object is required");
  const value = raw as Record<string, unknown>;
  const name = typeof value.name === "string" ? clean(value.name) : "";
  if (!name || name.length > 60) throw new ValidationError("Scenario name must be 1-60 characters");
  return {
    name,
    marketPct: shock(value.marketPct === undefined ? 0 : value.marketPct, "Market shock"),
    sectors: shockMap(value.sectors, "sectors", 100),
    securities: shockMap(value.securities, "securities", 500),
    currencies: shockMap(value.currencies, "currencies", 100),
  };
}

function validateBaseCurrency(input: ScenarioInput, baseCurrency: string): void {
  if (Object.hasOwn(input.currencies, baseCurrency.toUpperCase())) {
    throw new ValidationError(`Cannot shock base currency ${baseCurrency}; FX shocks are measured relative to ${baseCurrency}`);
  }
}

function grouped(positions: ScenarioPosition[], field: "sector" | "currency"): ScenarioGroup[] {
  const groups = new Map<string, ScenarioGroup>();
  for (const position of positions) {
    if (position.error) continue;
    const key = position[field];
    const group = groups.get(key) ?? { key, currentValue: 0, scenarioValue: 0, pnl: 0 };
    group.currentValue += position.currentValue!;
    group.scenarioValue += position.scenarioValue!;
    group.pnl += position.pnl!;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.pnl - b.pnl || a.key.localeCompare(b.key));
}

/**
 * Instantaneous mark-to-market shocks on one immutable valuation snapshot.
 * Market, sector and security price factors compound; FX is then applied to
 * the normalized holding value, retaining both short signs and minor units.
 */
export function analyzeScenario(analytics: PortfolioAnalytics, raw: ScenarioInput): ScenarioResult {
  const input = validateScenario(raw);
  validateBaseCurrency(input, analytics.baseCurrency);
  const sectors = new Map(Object.entries(input.sectors).map(([key, value]) => [key.toUpperCase(), value]));
  const securities = new Map(Object.entries(input.securities));
  const currencies = new Map(Object.entries(input.currencies));
  const warnings = [
    "Hypothetical instantaneous price and FX changes; no probabilities or historical event replication are assumed.",
    "Current holding units are held constant. Derivatives are not repriced, and contract multipliers, trading costs and liquidity are not modeled.",
  ];
  const positions = analytics.holdings.map((holding, row): ScenarioPosition => {
    const security = normalizeSecurity(holding.security) ?? holding.security;
    const sectorPct = sectors.get(clean(holding.sector).toUpperCase()) ?? 0;
    const securityPct = securities.get(security) ?? 0;
    const priceFactor = (1 + input.marketPct / 100) * (1 + sectorPct / 100) * (1 + securityPct / 100);
    const priceShock = priceFactor - 1;
    const fxShockPct = currencies.get(holding.currency.toUpperCase()) ?? 0;
    const fxShock = fxShockPct / 100;
    const position: ScenarioPosition = {
      row, security, name: holding.name, sector: holding.sector, currency: holding.currency,
      quantity: holding.quantity, currentValue: null, scenarioValue: null, pnl: null, pnlPct: null,
      priceEffect: null, fxEffect: null, interaction: null,
      priceShockPct: priceShock * 100, fxShockPct,
      error: holding.error ?? (finite(holding.marketValue) ? null : "NO VALUATION"),
    };
    if (position.error) return position;
    const currentValue = holding.marketValue!;
    const scenarioValue = currentValue * priceFactor * (1 + fxShock);
    const priceEffect = currentValue * priceShock;
    const fxEffect = currentValue * fxShock;
    const interaction = currentValue * priceShock * fxShock;
    const pnl = scenarioValue - currentValue;
    if (![currentValue, scenarioValue, priceEffect, fxEffect, interaction, pnl].every(Number.isFinite)) {
      return { ...position, error: "SCENARIO VALUATION EXCEEDS NUMERIC RANGE" };
    }
    return {
      ...position, currentValue, scenarioValue, pnl, priceEffect, fxEffect, interaction,
      pnlPct: percentage(pnl, Math.abs(currentValue)),
    };
  });
  const valued = positions.filter((position) => !position.error);
  const currentValue = valued.reduce((total, position) => total + position.currentValue!, 0);
  const scenarioValue = valued.reduce((total, position) => total + position.scenarioValue!, 0);
  const grossCurrentValue = valued.reduce((total, position) => total + Math.abs(position.currentValue!), 0);
  const pnl = scenarioValue - currentValue;
  if (![currentValue, scenarioValue, grossCurrentValue, pnl].every(Number.isFinite)) {
    throw new ValidationError("Portfolio scenario totals exceed the supported numeric range");
  }
  if (valued.length < positions.length) {
    warnings.push(`Partial coverage: ${valued.length} of ${positions.length} holding rows valued; totals exclude unvalued positions.`);
    for (const position of positions.filter((row) => row.error)) warnings.push(`Row ${position.row + 1}, ${position.security}: ${position.error}`);
  }
  const heldSectors = new Set(positions.map((position) => clean(position.sector).toUpperCase()));
  const heldSecurities = new Set(positions.map((position) => position.security));
  const heldCurrencies = new Set(positions.map((position) => position.currency.toUpperCase()));
  for (const key of Object.keys(input.sectors)) if (!heldSectors.has(key.toUpperCase())) warnings.push(`Sector shock "${key}" matches no holding.`);
  for (const key of securities.keys()) if (!heldSecurities.has(key)) warnings.push(`Security shock "${key}" matches no holding.`);
  for (const key of currencies.keys()) if (!heldCurrencies.has(key)) warnings.push(`Currency shock "${key}" matches no holding.`);
  return {
    name: input.name, portfolio: analytics.name, baseCurrency: analytics.baseCurrency, asOf: analytics.asOf,
    assumptions: input, currentValue, scenarioValue, pnl, grossCurrentValue,
    pnlPct: percentage(pnl, currentValue),
    coverage: { valuedRows: valued.length, totalRows: positions.length },
    positions, bySector: grouped(positions, "sector"), byCurrency: grouped(positions, "currency"), warnings,
  };
}

export function registerScenarioRoutes(app: express.Express, store: PortfolioStore, service: PortfolioService): void {
  app.post("/api/portfolios/:id/scenario", async (req, res) => {
    try {
      const body = req.body as Record<string, unknown> | undefined;
      const user = normalizeUser(body?.user ?? req.query.user);
      if (!user) { res.status(400).json({ error: "user is required (your login name)" }); return; }
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) { res.status(404).json({ error: "PORTFOLIO NOT FOUND" }); return; }
      const input = validateScenario(body);
      const portfolio = store.get(user, id);
      if (!portfolio) { res.status(404).json({ error: "PORTFOLIO NOT FOUND" }); return; }
      validateBaseCurrency(input, portfolio.baseCurrency);
      const analytics = await service.analyze(portfolio, "1y", "SPX Index");
      res.json(analyzeScenario(analytics, input));
    } catch (err) {
      if (err instanceof ValidationError) { res.status(400).json({ error: err.message }); return; }
      console.error("portfolio scenario", err);
      res.status(502).json({ error: "PORTFOLIO SCENARIO UNAVAILABLE" });
    }
  });
}
