import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import type { HistoryCache } from "../history/cache.js";
import type { ProviderRouter } from "../providers/router.js";
import { RuleError, parseRule, ruleSignal } from "../research/rules.js";
import { normalizeSecurity } from "../symbology.js";
import type { Quote } from "../types.js";

export const ALERT_KINDS = ["above", "below", "pct_up", "pct_down", "volume_above", "rule"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export interface Alert {
  id: number;
  user: string;
  security: string;
  kind: AlertKind;
  value: number | null;
  expr: string | null;
  note: string | null;
  active: boolean;
  created: number;
  triggeredAt: number | null;
  triggerValue: number | null;
}

export class AlertValidationError extends Error {}

const DAY = 86_400_000;
export const RULE_INTERVAL_MS = 5 * 60_000;
const MAX_ACTIVE_PER_USER = 200;

interface Row {
  id: number;
  user: string;
  security: string;
  kind: AlertKind;
  value: number | null;
  expr: string | null;
  note: string | null;
  active: number;
  created: number;
  triggered_at: number | null;
  trigger_value: number | null;
}

const fromRow = (r: Row): Alert => ({
  id: r.id,
  user: r.user,
  security: r.security,
  kind: r.kind,
  value: r.value,
  expr: r.expr,
  note: r.note,
  active: r.active === 1,
  created: r.created,
  triggeredAt: r.triggered_at,
  triggerValue: r.trigger_value,
});

export function describeAlert(a: Pick<Alert, "security" | "kind" | "value" | "expr">): string {
  switch (a.kind) {
    case "above":
      return `${a.security} price at or above ${a.value}`;
    case "below":
      return `${a.security} price at or below ${a.value}`;
    case "pct_up":
      return `${a.security} up ${a.value}% or more today`;
    case "pct_down":
      return `${a.security} down ${a.value}% or more today`;
    case "volume_above":
      return `${a.security} volume at or above ${a.value}`;
    default:
      return `${a.security} rule: ${a.expr}`;
  }
}

export type AlertInput = Pick<Alert, "security" | "kind" | "value" | "expr" | "note">;

/** Check and normalize a new alert's fields, throwing AlertValidationError with a message for the user. */
export function validateAlert(raw: unknown): AlertInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const security = typeof r.security === "string" ? normalizeSecurity(r.security) : null;
  if (!security) throw new AlertValidationError("security must be like AAPL US Equity");
  const kind = r.kind as AlertKind;
  if (!ALERT_KINDS.includes(kind)) throw new AlertValidationError(`kind must be one of ${ALERT_KINDS.join(", ")}`);
  let value: number | null = null;
  let expr: string | null = null;
  if (kind === "rule") {
    expr = typeof r.expr === "string" ? r.expr.trim() : "";
    try {
      parseRule(expr);
    } catch (e) {
      throw new AlertValidationError(e instanceof RuleError ? `Rule: ${e.message} (at character ${e.position + 1})` : "Invalid rule");
    }
  } else {
    value = typeof r.value === "number" ? r.value : Number(r.value);
    if (!Number.isFinite(value) || (kind !== "above" && kind !== "below" && value <= 0)) {
      throw new AlertValidationError(kind === "above" || kind === "below" ? "value must be a number" : "value must be a positive number");
    }
  }
  const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 200) : null;
  return { security, kind, value, expr, note };
}

/** The daily-bar rule that matches an alert, for checking how often it would have triggered. */
export function alertRule(a: Pick<Alert, "kind" | "value" | "expr">): string {
  switch (a.kind) {
    case "above":
      return `close >= ${a.value}`;
    case "below":
      return `close <= ${a.value}`;
    case "pct_up":
      return `change(close, 1) >= ${a.value}`;
    case "pct_down":
      return `change(close, 1) <= -${a.value}`;
    case "volume_above":
      return `volume >= ${a.value}`;
    default:
      return a.expr ?? "";
  }
}

/** The value that triggers an alert from a quote, or null if not triggered. */
export function quoteTrigger(a: Pick<Alert, "kind" | "value">, q: Quote): number | null {
  const v = a.value!;
  switch (a.kind) {
    case "above":
      return q.last !== null && q.last >= v ? q.last : null;
    case "below":
      return q.last !== null && q.last <= v ? q.last : null;
    case "pct_up":
      return q.changePct !== null && q.changePct >= v ? q.changePct : null;
    case "pct_down":
      return q.changePct !== null && q.changePct <= -v ? q.changePct : null;
    case "volume_above":
      return q.volume !== null && q.volume >= v ? q.volume : null;
    default:
      return null;
  }
}

export class AlertService {
  private db: DatabaseSync;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRuleCheck = new Map<number, number>();
  private running = false;

  constructor(
    file: string,
    private router: ProviderRouter,
    private history: HistoryCache,
    private notify: (user: string, payload: unknown) => void,
    private now: () => number = Date.now,
    private log: (msg: string) => void = console.error,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        security TEXT NOT NULL,
        kind TEXT NOT NULL,
        value REAL,
        expr TEXT,
        note TEXT,
        active INTEGER NOT NULL,
        created INTEGER NOT NULL,
        triggered_at INTEGER,
        trigger_value REAL
      );
      CREATE INDEX IF NOT EXISTS alerts_active ON alerts (active);
    `);
  }

  close(): void {
    this.stop();
    this.db.close();
  }

  list(user: string): { active: Alert[]; triggered: Alert[] } {
    const rows = (sql: string) => (this.db.prepare(sql).all(user) as unknown as Row[]).map(fromRow);
    return {
      active: rows("SELECT * FROM alerts WHERE user = ? AND active = 1 ORDER BY created DESC"),
      triggered: rows("SELECT * FROM alerts WHERE user = ? AND active = 0 ORDER BY triggered_at DESC LIMIT 50"),
    };
  }

  create(user: string, raw: unknown): Alert {
    const { security, kind, value, expr, note } = validateAlert(raw);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE user = ? AND active = 1").get(user) as { n: number }).n;
    if (count >= MAX_ACTIVE_PER_USER) throw new AlertValidationError(`At most ${MAX_ACTIVE_PER_USER} active alerts`);
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO alerts (user, security, kind, value, expr, note, active, created) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(user, security, kind, value, expr, note, this.now());
    return this.get(user, Number(lastInsertRowid))!;
  }

  get(user: string, id: number): Alert | null {
    const row = this.db.prepare("SELECT * FROM alerts WHERE id = ? AND user = ?").get(id, user) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  remove(user: string, id: number): boolean {
    this.lastRuleCheck.delete(id);
    return Number(this.db.prepare("DELETE FROM alerts WHERE id = ? AND user = ?").run(id, user).changes) > 0;
  }

  rearm(user: string, id: number): Alert | null {
    this.db.prepare("UPDATE alerts SET active = 1, triggered_at = NULL, trigger_value = NULL WHERE id = ? AND user = ?").run(id, user);
    this.lastRuleCheck.delete(id);
    return this.get(user, id);
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.evaluate(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Check all active alerts once. Returns the alerts that fired. */
  async evaluate(): Promise<Alert[]> {
    if (this.running) return [];
    this.running = true;
    const fired: Alert[] = [];
    try {
      const active = (this.db.prepare("SELECT * FROM alerts WHERE active = 1").all() as unknown as Row[]).map(fromRow);
      const quoteAlerts = active.filter((a) => a.kind !== "rule");
      if (quoteAlerts.length) {
        const quotes = await this.router.quotes([...new Set(quoteAlerts.map((a) => a.security))]).catch((err) => {
          this.log(`alert quotes failed: ${(err as Error).message}`);
          return [] as Quote[];
        });
        const bySec = new Map(quotes.map((q) => [q.security, q]));
        for (const a of quoteAlerts) {
          const q = bySec.get(a.security);
          const v = q ? quoteTrigger(a, q) : null;
          if (v !== null) fired.push(this.fire(a, v, q!));
        }
      }
      const now = this.now();
      for (const a of active.filter((x) => x.kind === "rule")) {
        if (now - (this.lastRuleCheck.get(a.id) ?? 0) < RULE_INTERVAL_MS) continue;
        this.lastRuleCheck.set(a.id, now);
        try {
          const bars = await this.history.get(a.security, "1d", now - 400 * DAY, now);
          const signal = ruleSignal(a.expr!, bars);
          if (signal.length && signal[signal.length - 1]) fired.push(this.fire(a, bars[bars.length - 1].c, null));
        } catch (err) {
          this.log(`alert rule ${a.id} failed: ${(err as Error).message}`);
        }
      }
    } finally {
      this.running = false;
    }
    return fired;
  }

  private fire(a: Alert, value: number, q: Quote | null): Alert {
    const t = this.now();
    this.db.prepare("UPDATE alerts SET active = 0, triggered_at = ?, trigger_value = ? WHERE id = ?").run(t, value, a.id);
    const alert = { ...a, active: false, triggeredAt: t, triggerValue: value };
    const detail =
      a.kind === "pct_up" || a.kind === "pct_down"
        ? `${value.toFixed(2)}% today`
        : a.kind === "volume_above"
          ? `volume ${Math.round(value).toLocaleString("en-US")}`
          : `last ${value}`;
    this.notify(a.user, {
      type: "alert",
      alert,
      message: `${describeAlert(a)}: ${detail}${a.note ? ` (${a.note})` : ""}`,
      quote: q,
    });
    return alert;
  }
}

export function registerAlertRoutes(app: express.Express, alerts: AlertService): void {
  const user = (req: express.Request, res: express.Response) => {
    const u = normalizeUser((req.body as { user?: unknown } | undefined)?.user ?? req.query.user);
    if (!u) res.status(400).json({ error: "user is required" });
    return u;
  };

  app.get("/api/alerts", (req, res) => {
    const u = user(req, res);
    if (u) res.json(alerts.list(u));
  });

  app.post("/api/alerts", (req, res) => {
    const u = user(req, res);
    if (!u) return;
    try {
      res.status(201).json(alerts.create(u, req.body));
    } catch (err) {
      if (err instanceof AlertValidationError) res.status(400).json({ error: err.message });
      else throw err;
    }
  });

  app.delete("/api/alerts/:id", (req, res) => {
    const u = user(req, res);
    if (!u) return;
    if (alerts.remove(u, Number(req.params.id))) res.status(204).end();
    else res.status(404).json({ error: "ALERT NOT FOUND" });
  });

  app.post("/api/alerts/:id/rearm", (req, res) => {
    const u = user(req, res);
    if (!u) return;
    const a = alerts.rearm(u, Number(req.params.id));
    if (a) res.json(a);
    else res.status(404).json({ error: "ALERT NOT FOUND" });
  });
}
