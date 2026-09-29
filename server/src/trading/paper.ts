import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import { normalizeCurrency } from "../portfolio/analytics.js";
import type { PortfolioStore } from "../portfolio/store.js";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity } from "../symbology.js";
import type { OrderSide, OrderStatus, OrderType, PaperAccount, PaperOrder, PaperPosition, Quote } from "../types.js";

export const ORDER_TYPES = ["market", "limit", "stop"] as const satisfies readonly OrderType[];

export const PAPER_PORTFOLIO = "Paper";
const DEFAULT_CASH = 1_000_000;
const MAX_QUANTITY = 1e9;

export class PaperError extends Error {}

interface OrderRow {
  id: number;
  user: string;
  security: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  limit_price: number | null;
  stop_price: number | null;
  status: OrderStatus;
  created: number;
  filled_at: number | null;
  fill_price: number | null;
  currency: string | null;
  reason: string | null;
}

const toOrder = (r: OrderRow): PaperOrder => ({
  id: r.id,
  user: r.user,
  security: r.security,
  side: r.side,
  quantity: r.quantity,
  type: r.type,
  limitPrice: r.limit_price,
  stopPrice: r.stop_price,
  status: r.status,
  created: r.created,
  filledAt: r.filled_at,
  fillPrice: r.fill_price,
  currency: r.currency,
  reason: r.reason,
});

/**
 * Price at which an order fills now, or null if it should keep waiting.
 * Market orders take the ask (buys) or bid (sells), falling back to the last
 * price; limits fill at the limit or better; stops trigger on the last price.
 */
export function fillPrice(order: Pick<PaperOrder, "side" | "type" | "limitPrice" | "stopPrice">, q: Quote): number | null {
  const buy = order.side === "buy";
  const touch = (buy ? q.ask : q.bid) ?? q.last;
  if (touch === null || !(touch > 0)) return null;
  if (order.type === "market") return touch;
  if (order.type === "limit") {
    const limit = order.limitPrice!;
    return buy ? (touch <= limit ? touch : null) : touch >= limit ? touch : null;
  }
  const last = q.last ?? touch;
  const triggered = buy ? last >= order.stopPrice! : last <= order.stopPrice!;
  return triggered ? touch : null;
}

/** Simulated brokerage: per-user cash by currency, orders filled against live quotes. */
export class PaperBroker {
  private db: DatabaseSync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    file: string,
    private router: Pick<ProviderRouter, "quotes">,
    private portfolios: PortfolioStore | null,
    private notify: (user: string, payload: object) => void = () => {},
    private now: () => number = Date.now,
  ) {
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_accounts (user TEXT PRIMARY KEY, starting_cash REAL NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS paper_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, security TEXT NOT NULL, side TEXT NOT NULL,
        quantity REAL NOT NULL, type TEXT NOT NULL, limit_price REAL, stop_price REAL, status TEXT NOT NULL,
        created INTEGER NOT NULL, filled_at INTEGER, fill_price REAL, currency TEXT, scale REAL, reason TEXT
      );
      CREATE INDEX IF NOT EXISTS paper_orders_user ON paper_orders (user, status);
    `);
  }

  private ensureAccount(user: string): number {
    const row = this.db.prepare("SELECT starting_cash FROM paper_accounts WHERE user = ?").get(user) as { starting_cash: number } | undefined;
    if (row) return row.starting_cash;
    this.db.prepare("INSERT INTO paper_accounts (user, starting_cash, created) VALUES (?, ?, ?)").run(user, DEFAULT_CASH, this.now());
    return DEFAULT_CASH;
  }

  account(user: string): PaperAccount {
    const startingCash = this.ensureAccount(user);
    const orders = (this.db.prepare("SELECT * FROM paper_orders WHERE user = ? ORDER BY id DESC LIMIT 200").all(user) as unknown as OrderRow[]).map(toOrder);
    const rows = this.db.prepare("SELECT * FROM paper_orders WHERE user = ? AND status = 'filled' ORDER BY filled_at, id").all(user) as unknown as (OrderRow & { scale: number | null })[];
    const cash: Record<string, number> = { USD: startingCash };
    const book = new Map<string, PaperPosition>();
    for (const row of rows) {
      const f = toOrder(row);
      const ccy = f.currency ?? "USD";
      const scale = row.scale ?? 1;
      const signed = f.side === "buy" ? f.quantity : -f.quantity;
      cash[ccy] = (cash[ccy] ?? 0) - signed * f.fillPrice! * scale;
      const p = book.get(f.security) ?? { security: f.security, quantity: 0, avgCost: 0, currency: ccy };
      const next = p.quantity + signed;
      if (p.quantity === 0 || Math.sign(signed) === Math.sign(p.quantity)) {
        p.avgCost = (p.avgCost * Math.abs(p.quantity) + f.fillPrice! * Math.abs(signed)) / Math.abs(next);
      } else if (Math.sign(next) !== Math.sign(p.quantity) && next !== 0) {
        p.avgCost = f.fillPrice!;
      }
      p.quantity = next;
      book.set(f.security, p);
    }
    const positions = [...book.values()].filter((p) => Math.abs(p.quantity) > 1e-9);
    return { user, startingCash, cash, positions, orders };
  }

  place(user: string, raw: Record<string, unknown>): Promise<PaperOrder> {
    const security = typeof raw.security === "string" ? normalizeSecurity(raw.security) : null;
    if (!security) throw new PaperError('security must look like "AAPL US Equity"');
    const side = raw.side === "buy" || raw.side === "sell" ? raw.side : null;
    if (!side) throw new PaperError("side must be buy or sell");
    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > MAX_QUANTITY) throw new PaperError("quantity must be a positive number");
    const type = (ORDER_TYPES as readonly unknown[]).includes(raw.type ?? "market") ? ((raw.type ?? "market") as OrderType) : null;
    if (!type) throw new PaperError(`type must be one of ${ORDER_TYPES.join(", ")}`);
    const price = (v: unknown, name: string) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new PaperError(`${name} must be a positive price`);
      return n;
    };
    const limitPrice = type === "limit" ? price(raw.limitPrice, "limitPrice") : null;
    const stopPrice = type === "stop" ? price(raw.stopPrice, "stopPrice") : null;
    this.ensureAccount(user);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO paper_orders (user, security, side, quantity, type, limit_price, stop_price, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
      .run(user, security, side, quantity, type, limitPrice, stopPrice, this.now());
    const id = Number(lastInsertRowid);
    return this.evaluate([id]).then(() => this.order(user, id)!);
  }

  order(user: string, id: number): PaperOrder | null {
    const row = this.db.prepare("SELECT * FROM paper_orders WHERE id = ? AND user = ?").get(id, user) as OrderRow | undefined;
    return row ? toOrder(row) : null;
  }

  cancel(user: string, id: number): PaperOrder | null {
    const changed = Number(this.db.prepare("UPDATE paper_orders SET status = 'cancelled', reason = 'Cancelled by user' WHERE id = ? AND user = ? AND status = 'open'").run(id, user).changes);
    return changed ? this.order(user, id) : null;
  }

  reset(user: string, startingCash = DEFAULT_CASH): PaperAccount {
    if (!Number.isFinite(startingCash) || startingCash <= 0 || startingCash > 1e12) throw new PaperError("starting cash must be a positive amount");
    this.db.prepare("DELETE FROM paper_orders WHERE user = ?").run(user);
    this.db.prepare("INSERT INTO paper_accounts (user, starting_cash, created) VALUES (?, ?, ?) ON CONFLICT(user) DO UPDATE SET starting_cash = excluded.starting_cash, created = excluded.created").run(user, startingCash, this.now());
    this.syncPortfolio(user);
    return this.account(user);
  }

  /** Try to fill open orders (all of them, or just `ids`) against current quotes. */
  async evaluate(ids?: number[]): Promise<void> {
    const open = (
      ids?.length
        ? (this.db.prepare(`SELECT * FROM paper_orders WHERE status = 'open' AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) as unknown as OrderRow[])
        : (this.db.prepare("SELECT * FROM paper_orders WHERE status = 'open'").all() as unknown as OrderRow[])
    ).map(toOrder);
    if (!open.length) return;
    const quotes = new Map((await this.router.quotes([...new Set(open.map((o) => o.security))]).catch(() => [] as Quote[])).map((q) => [q.security, q]));
    const touched = new Set<string>();
    for (const o of open) {
      const q = quotes.get(o.security);
      if (!q) {
        if (o.type === "market") {
          this.db.prepare("UPDATE paper_orders SET status = 'rejected', reason = ? WHERE id = ?").run("No quote available to fill against", o.id);
          this.notify(o.user, { type: "paper.fill", order: this.order(o.user, o.id), message: `Rejected: ${o.side.toUpperCase()} ${o.quantity} ${o.security} (no quote)` });
        }
        continue;
      }
      const px = fillPrice(o, q);
      if (px === null) continue;
      const { currency, scale } = normalizeCurrency(q.currency, "USD");
      this.db
        .prepare("UPDATE paper_orders SET status = 'filled', filled_at = ?, fill_price = ?, currency = ?, scale = ? WHERE id = ? AND status = 'open'")
        .run(this.now(), px, currency, scale, o.id);
      touched.add(o.user);
      this.notify(o.user, { type: "paper.fill", order: this.order(o.user, o.id), message: `Filled: ${o.side.toUpperCase()} ${o.quantity} ${o.security} @ ${px}` });
    }
    for (const user of touched) this.syncPortfolio(user);
  }

  /** Mirror paper positions into a "Paper" portfolio so PORT analyzes the paper account. */
  private syncPortfolio(user: string): void {
    if (!this.portfolios) return;
    const { positions } = this.account(user);
    const existing = this.portfolios.findByName(user, PAPER_PORTFOLIO);
    const holdings = positions.map((p) => ({ security: p.security, quantity: p.quantity, weight: null, cost: p.avgCost, acquired: null }));
    if (!holdings.length) {
      if (existing) this.portfolios.remove(user, existing.id);
      return;
    }
    const input = { name: PAPER_PORTFOLIO, kind: "positions" as const, baseCurrency: "USD", notional: null, holdings };
    if (existing) this.portfolios.update(user, existing.id, input);
    else this.portfolios.create(user, input);
  }

  start(intervalMs: number): void {
    this.timer ??= setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.evaluate().finally(() => (this.running = false));
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function registerPaperRoutes(app: express.Express, broker: PaperBroker): void {
  const userOf = (req: express.Request, res: express.Response) => {
    const user = normalizeUser((req.body as { user?: unknown } | undefined)?.user ?? req.query.user);
    if (!user) res.status(400).json({ error: "user is required (your login name)" });
    return user;
  };
  app.get("/api/paper", (req, res) => {
    const user = userOf(req, res);
    if (user) res.json(broker.account(user));
  });
  app.post("/api/paper/orders", async (req, res) => {
    const user = userOf(req, res);
    if (!user) return;
    try {
      res.status(201).json(await broker.place(user, (req.body ?? {}) as Record<string, unknown>));
    } catch (err) {
      if (err instanceof PaperError) res.status(400).json({ error: err.message });
      else throw err;
    }
  });
  app.delete("/api/paper/orders/:id", (req, res) => {
    const user = userOf(req, res);
    if (!user) return;
    const order = broker.cancel(user, Number(req.params.id));
    if (order) res.json(order);
    else res.status(404).json({ error: "NO OPEN ORDER WITH THAT ID" });
  });
  app.post("/api/paper/reset", (req, res) => {
    const user = userOf(req, res);
    if (!user) return;
    try {
      const cash = (req.body as { startingCash?: unknown })?.startingCash;
      res.json(broker.reset(user, cash === undefined ? undefined : Number(cash)));
    } catch (err) {
      if (err instanceof PaperError) res.status(400).json({ error: err.message });
      else throw err;
    }
  });
}
