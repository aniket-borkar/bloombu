import type { PortfolioHolding, PortfolioKind, Resolution } from "../api";
import { mapHeader, parseNumber } from "./table";

/** Editable grid columns for each portfolio kind, in order. */
export const EDIT_FIELDS: Record<PortfolioKind, ("security" | "quantity" | "cost" | "acquired" | "weight")[]> = {
  positions: ["security", "quantity", "cost", "acquired"],
  model: ["security", "weight"],
};

export const HEADER_ALIASES = {
  security: ["security", "ticker", "bloomberg ticker", "symbol", "ric", "identifier", "id", "isin", "instrument", "stock", "name"],
  quantity: ["shares", "qty", "quantity", "position", "units", "amount", "holding", "holdings", "pos"],
  cost: ["cost", "cost/share", "cost per share", "avg cost", "average cost", "unit cost", "price paid", "purchase price", "basis", "cost basis", "price"],
  acquired: ["acquired", "date", "trade date", "purchase date", "acquisition date", "open date"],
  weight: ["weight", "weight %", "weight%", "wt", "wgt", "%", "allocation", "target", "target weight", "pct", "percent"],
};

export interface PasteResult {
  /** Rows in the editable column order of `kind`. */
  rows: string[][];
  /** Kind implied by the header (weights without shares suggests a model portfolio). */
  suggestedKind: PortfolioKind | null;
  headerMapped: boolean;
}

/** Map a pasted table onto the editor's columns using its header row, if it has one. */
export function mapPastedTable(table: string[][], kind: PortfolioKind): PasteResult | null {
  if (!table.length) return null;
  const mapping = mapHeader(table[0], HEADER_ALIASES);
  if (!mapping || mapping.security === undefined) return null;
  const hasWeight = mapping.weight !== undefined;
  const hasShares = mapping.quantity !== undefined;
  const suggestedKind: PortfolioKind | null = hasWeight && !hasShares ? "model" : hasShares && !hasWeight ? "positions" : null;
  const target = suggestedKind ?? kind;
  const fields = EDIT_FIELDS[target];
  const rows = table
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => fields.map((f) => (mapping[f] !== undefined ? (r[mapping[f]!] ?? "").trim() : "")));
  return { rows, suggestedKind, headerMapped: true };
}

/** Accepts YYYY-MM-DD, MM/DD/YYYY and M/D/YY; returns YYYY-MM-DD or null if unparseable. */
export function normalizeDate(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  let y: number, m: number, d: number;
  const iso = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3].length === 2 ? `20${us[3]}` : us[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export interface BuildResult {
  holdings: PortfolioHolding[];
  errors: string[];
}

/** Convert editor rows to holdings, using resolved securities for the identifier column. */
export function holdingsFromRows(rows: string[][], kind: PortfolioKind, resolutions: Map<string, Resolution>): BuildResult {
  const fields = EDIT_FIELDS[kind];
  const col = (f: (typeof fields)[number]) => fields.indexOf(f);
  const holdings: PortfolioHolding[] = [];
  const errors: string[] = [];
  rows.forEach((r, i) => {
    if (!r.some((c) => c?.trim())) return;
    const where = `Row ${i + 1}`;
    const text = (r[col("security")] ?? "").trim();
    const res = resolutions.get(text);
    if (!text) {
      errors.push(`${where}: security is empty`);
      return;
    }
    if (!res) {
      errors.push(`${where}: still identifying "${text}"`);
      return;
    }
    if (!res.security) {
      errors.push(`${where}: could not identify "${text}"`);
      return;
    }
    if (kind === "positions") {
      const quantity = parseNumber(r[col("quantity")] ?? "");
      const costText = (r[col("cost")] ?? "").trim();
      const cost = costText ? parseNumber(costText) : null;
      const acquiredText = (r[col("acquired")] ?? "").trim();
      const acquired = acquiredText ? normalizeDate(acquiredText) : null;
      if (quantity === null || quantity === 0) errors.push(`${where}: shares must be a non-zero number`);
      else if (costText && cost === null) errors.push(`${where}: cost "${costText}" is not a number`);
      else if (acquiredText && !acquired) errors.push(`${where}: date "${acquiredText}" is not a date`);
      else holdings.push({ security: res.security, quantity, weight: null, cost, acquired });
    } else {
      const weight = parseNumber(r[col("weight")] ?? "");
      if (weight === null || weight <= 0) errors.push(`${where}: weight must be a positive number`);
      else holdings.push({ security: res.security, quantity: null, weight, cost: null, acquired: null });
    }
  });
  return { holdings, errors };
}

/** Editor rows for saved holdings. */
export function rowsFromHoldings(holdings: PortfolioHolding[], kind: PortfolioKind): string[][] {
  return holdings.map((h) =>
    kind === "positions"
      ? [h.security, h.quantity !== null ? String(h.quantity) : "", h.cost !== null ? String(h.cost) : "", h.acquired ?? ""]
      : [h.security, h.weight !== null ? String(h.weight) : ""],
  );
}
