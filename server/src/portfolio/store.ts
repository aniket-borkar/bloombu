import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { normalizeSecurity } from "../symbology.js";
import type { Portfolio, PortfolioHolding, PortfolioInput, PortfolioKind, PortfolioSummary } from "../types.js";

export class ValidationError extends Error {}

const MAX_HOLDINGS = 500;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s$%]/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

/** Validate and normalize client input; throws ValidationError with a user-facing message. */
export function validatePortfolio(raw: unknown): PortfolioInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  if (!name || name.length > 60) throw new ValidationError("Name must be 1-60 characters");
  const kind = r.kind as PortfolioKind;
  if (kind !== "positions" && kind !== "model") throw new ValidationError('kind must be "positions" or "model"');
  const baseCurrency = typeof r.baseCurrency === "string" && r.baseCurrency ? r.baseCurrency.trim().toUpperCase() : "USD";
  if (!/^[A-Z]{3}$/.test(baseCurrency)) throw new ValidationError("Base currency must be a 3-letter code");
  let notional = num(r.notional);
  if (kind === "model") {
    if (notional === null) notional = 1_000_000;
    if (!(notional! > 0)) throw new ValidationError("Notional must be a positive number");
  } else {
    notional = null;
  }
  if (!Array.isArray(r.holdings)) throw new ValidationError("holdings must be a list");
  if (r.holdings.length > MAX_HOLDINGS) throw new ValidationError(`At most ${MAX_HOLDINGS} holdings`);

  const holdings: PortfolioHolding[] = r.holdings.map((h: unknown, i: number) => {
    const row = (h ?? {}) as Record<string, unknown>;
    const where = `Row ${i + 1}`;
    const security = typeof row.security === "string" ? normalizeSecurity(row.security) : null;
    if (!security) throw new ValidationError(`${where}: "${String(row.security ?? "")}" is not a security (use e.g. AAPL US Equity)`);
    const quantity = num(row.quantity);
    const weight = num(row.weight);
    const cost = num(row.cost);
    const acquired = typeof row.acquired === "string" && row.acquired.trim() ? row.acquired.trim() : null;
    if (Number.isNaN(quantity) || Number.isNaN(weight) || Number.isNaN(cost)) throw new ValidationError(`${where}: numbers only in numeric columns`);
    if (kind === "positions" && (quantity === null || quantity === 0)) throw new ValidationError(`${where}: shares must be a non-zero number`);
    if (kind === "model" && !(weight !== null && weight > 0)) throw new ValidationError(`${where}: weight must be a positive percentage`);
    if (cost !== null && cost < 0) throw new ValidationError(`${where}: cost cannot be negative`);
    if (acquired && (!/^\d{4}-\d{2}-\d{2}$/.test(acquired) || Number.isNaN(Date.parse(acquired)))) {
      throw new ValidationError(`${where}: acquired date must be YYYY-MM-DD`);
    }
    return {
      security,
      quantity: kind === "positions" ? quantity : null,
      weight: kind === "model" ? weight : null,
      cost: kind === "positions" ? cost : null,
      acquired: kind === "positions" ? acquired : null,
    };
  });

  return { name, kind, baseCurrency, notional, holdings };
}

interface PortfolioRow {
  id: number;
  user: string;
  name: string;
  kind: PortfolioKind;
  base_currency: string;
  notional: number | null;
  created: number;
  updated: number;
}

/** Portfolios per login name (no authentication, like chat). */
export class PortfolioStore {
  private db: DatabaseSync;

  constructor(
    file: string,
    private now: () => number = Date.now,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS portfolios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_currency TEXT NOT NULL,
        notional REAL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        UNIQUE (user, name)
      );
      CREATE TABLE IF NOT EXISTS portfolio_holdings (
        portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        row INTEGER NOT NULL,
        security TEXT NOT NULL,
        quantity REAL,
        weight REAL,
        cost REAL,
        acquired TEXT,
        PRIMARY KEY (portfolio_id, row)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  list(user: string): PortfolioSummary[] {
    return (
      this.db
        .prepare(
          `SELECT p.id, p.name, p.kind, p.base_currency, p.updated, COUNT(h.row) AS count
           FROM portfolios p LEFT JOIN portfolio_holdings h ON h.portfolio_id = p.id
           WHERE p.user = ? GROUP BY p.id ORDER BY p.name COLLATE NOCASE`,
        )
        .all(user) as unknown as (Omit<PortfolioRow, "user" | "notional" | "created"> & { count: number })[]
    ).map((r) => ({ id: r.id, name: r.name, kind: r.kind, baseCurrency: r.base_currency, count: r.count, updated: r.updated }));
  }

  get(user: string, id: number): Portfolio | null {
    const p = this.db.prepare("SELECT * FROM portfolios WHERE id = ? AND user = ?").get(id, user) as PortfolioRow | undefined;
    if (!p) return null;
    const holdings = (
      this.db
        .prepare("SELECT security, quantity, weight, cost, acquired FROM portfolio_holdings WHERE portfolio_id = ? ORDER BY row")
        .all(id) as unknown as PortfolioHolding[]
    ).map((h) => ({ ...h }));
    return {
      id: p.id,
      user: p.user,
      name: p.name,
      kind: p.kind,
      baseCurrency: p.base_currency,
      notional: p.notional,
      holdings,
      created: p.created,
      updated: p.updated,
    };
  }

  findByName(user: string, name: string): Portfolio | null {
    const row = this.db.prepare("SELECT id FROM portfolios WHERE user = ? AND name = ? COLLATE NOCASE").get(user, name) as
      | { id: number }
      | undefined;
    return row ? this.get(user, row.id) : null;
  }

  create(user: string, input: PortfolioInput): Portfolio {
    const t = this.now();
    this.db.exec("BEGIN");
    try {
      const { lastInsertRowid } = this.db
        .prepare("INSERT INTO portfolios (user, name, kind, base_currency, notional, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(user, input.name, input.kind, input.baseCurrency, input.notional, t, t);
      const id = Number(lastInsertRowid);
      this.writeHoldings(id, input.holdings);
      this.db.exec("COMMIT");
      return this.get(user, id)!;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw this.friendly(err, input.name);
    }
  }

  update(user: string, id: number, input: PortfolioInput): Portfolio | null {
    if (!this.get(user, id)) return null;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare("UPDATE portfolios SET name = ?, kind = ?, base_currency = ?, notional = ?, updated = ? WHERE id = ? AND user = ?")
        .run(input.name, input.kind, input.baseCurrency, input.notional, this.now(), id, user);
      this.db.prepare("DELETE FROM portfolio_holdings WHERE portfolio_id = ?").run(id);
      this.writeHoldings(id, input.holdings);
      this.db.exec("COMMIT");
      return this.get(user, id);
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw this.friendly(err, input.name);
    }
  }

  remove(user: string, id: number): boolean {
    return Number(this.db.prepare("DELETE FROM portfolios WHERE id = ? AND user = ?").run(id, user).changes) > 0;
  }

  private writeHoldings(id: number, holdings: PortfolioHolding[]): void {
    const stmt = this.db.prepare(
      "INSERT INTO portfolio_holdings (portfolio_id, row, security, quantity, weight, cost, acquired) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    holdings.forEach((h, i) => stmt.run(id, i, h.security, h.quantity, h.weight, h.cost, h.acquired));
  }

  private friendly(err: unknown, name: string): Error {
    return /UNIQUE/i.test((err as Error).message) ? new ValidationError(`A portfolio named "${name}" already exists`) : (err as Error);
  }
}
