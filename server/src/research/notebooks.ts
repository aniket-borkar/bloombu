import type express from "express";
import type { DatabaseSync } from "node:sqlite";
import { normalizeUser } from "../chat/chat.js";
import { openDatabase } from "../db.js";
import { normalizeSecurity } from "../symbology.js";

export interface NotebookEvidence {
  id: string;
  kind: "source" | "valuation" | "scenario" | "note";
  title: string;
  security?: string;
  source?: string;
  url?: string;
  asOf?: string;
  capturedAt: string;
  /** Captured JSON values, retained independently of later market updates. */
  data?: unknown;
}

export interface NotebookInput {
  title: string;
  security: string | null;
  thesis: string;
  bearCase: string;
  catalysts: string;
  reviewDate: string | null;
  evidence: NotebookEvidence[];
}

export interface Notebook extends NotebookInput {
  id: number;
  user: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookSummary {
  id: number;
  title: string;
  security: string | null;
  revision: number;
  updatedAt: string;
}

export class NotebookValidationError extends Error {}
export class NotebookConflictError extends Error {
  constructor(readonly revision: number) {
    super("NOTEBOOK CHANGED; RELOAD THE LATEST VERSION");
  }
}

const MAX_TEXT = 20_000;
const MAX_EVIDENCE = 100;
const MAX_NOTEBOOK_BYTES = 512 * 1024;
const EVIDENCE_KINDS = new Set(["source", "valuation", "scenario", "note"]);

function object(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NotebookValidationError(`${label} must be an object`);
  return raw as Record<string, unknown>;
}

function text(raw: unknown, label: string, max: number, required = false): string {
  if (typeof raw !== "string" || raw.length > max || (required && !raw.trim())) {
    throw new NotebookValidationError(`${label} must be ${required ? "1" : "0"}-${max} characters`);
  }
  return raw;
}

function validDay(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

function isoDate(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !validDay(raw.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new NotebookValidationError(`${label} must be an ISO date or timestamp with a timezone`);
  }
  return raw;
}

function snapshot(raw: unknown, label: string): unknown {
  const check = (value: unknown, depth: number): void => {
    if (depth > 30) throw new NotebookValidationError(`${label} is nested too deeply`);
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) check(item, depth + 1);
      return;
    }
    if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      for (const item of Object.values(value)) check(item, depth + 1);
      return;
    }
    throw new NotebookValidationError(`${label} must contain only JSON values`);
  };
  check(raw, 0);
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json, "utf8") > MAX_NOTEBOOK_BYTES) throw new NotebookValidationError(`${label} exceeds 512 KB`);
  return JSON.parse(json) as unknown;
}

/** Validate an editable notebook and detach evidence snapshots from the caller. */
export function validateNotebook(raw: unknown): NotebookInput {
  const value = object(raw, "Notebook");
  const title = text(value.title, "title", 120, true).trim();
  const security = value.security === undefined || value.security === null || value.security === "" ? null : typeof value.security === "string" ? normalizeSecurity(value.security) : null;
  if (value.security !== undefined && value.security !== null && value.security !== "" && !security) throw new NotebookValidationError("security must look like AAPL US Equity");
  const thesis = text(value.thesis ?? "", "thesis", MAX_TEXT);
  const bearCase = text(value.bearCase ?? "", "bearCase", MAX_TEXT);
  const catalysts = text(value.catalysts ?? "", "catalysts", MAX_TEXT);
  const reviewDate = value.reviewDate === undefined || value.reviewDate === null || value.reviewDate === "" ? null : value.reviewDate;
  if (reviewDate !== null && (typeof reviewDate !== "string" || !validDay(reviewDate))) throw new NotebookValidationError("reviewDate must be YYYY-MM-DD");
  const evidenceInput = value.evidence ?? [];
  if (!Array.isArray(evidenceInput) || evidenceInput.length > MAX_EVIDENCE) throw new NotebookValidationError("evidence must be a list of at most 100 entries");
  const ids = new Set<string>();
  const evidence = evidenceInput.map((item: unknown, index: number): NotebookEvidence => {
    const e = object(item, `evidence[${index}]`);
    const id = text(e.id, `evidence[${index}].id`, 80, true);
    if (ids.has(id)) throw new NotebookValidationError("evidence ids must be unique");
    ids.add(id);
    if (typeof e.kind !== "string" || !EVIDENCE_KINDS.has(e.kind)) throw new NotebookValidationError("evidence kind must be source, valuation, scenario or note");
    const result: NotebookEvidence = {
      id,
      kind: e.kind as NotebookEvidence["kind"],
      title: text(e.title, `evidence[${index}].title`, 200, true),
      capturedAt: isoDate(e.capturedAt, `evidence[${index}].capturedAt`),
    };
    if (e.security !== undefined) {
      if (typeof e.security !== "string" || !normalizeSecurity(e.security)) throw new NotebookValidationError("evidence security must look like AAPL US Equity");
      result.security = e.security;
    }
    if (e.source !== undefined) result.source = text(e.source, `evidence[${index}].source`, 200);
    if (e.url !== undefined) {
      const url = text(e.url, `evidence[${index}].url`, 2048, true);
      try {
        const parsed = new URL(url);
        if (!/^https?:$/.test(parsed.protocol) || /[\u0000-\u0020\u007f]/.test(url)) throw new Error("Invalid source URL");
      } catch {
        throw new NotebookValidationError("evidence URLs must use http:// or https://");
      }
      result.url = url;
    }
    if (e.asOf !== undefined) result.asOf = isoDate(e.asOf, `evidence[${index}].asOf`);
    if (Object.prototype.hasOwnProperty.call(e, "data")) result.data = snapshot(e.data, `evidence[${index}].data`);
    return result;
  });
  const input = { title, security, thesis, bearCase, catalysts, reviewDate: reviewDate as string | null, evidence };
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_NOTEBOOK_BYTES) throw new NotebookValidationError("Notebook exceeds 512 KB");
  return input;
}

interface NotebookRow {
  id: number;
  user: string;
  title: string;
  security: string | null;
  json: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

const toNotebook = (row: NotebookRow): Notebook => ({
  ...(JSON.parse(row.json) as NotebookInput),
  id: row.id,
  user: row.user,
  revision: row.revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function revisionOf(raw: unknown): number {
  const value = typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new NotebookValidationError("revision must be a positive integer");
  return value;
}

/** Saved research notebooks with atomic revision checks and per-user ownership. */
export class NotebookStore {
  private db: DatabaseSync;

  constructor(file: string, private now: () => number = Date.now) {
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS research_notebooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        title TEXT NOT NULL,
        security TEXT,
        json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS research_notebooks_user ON research_notebooks (user, updated_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  list(user: string): NotebookSummary[] {
    return (this.db.prepare("SELECT id, title, security, revision, updated_at FROM research_notebooks WHERE user = ? ORDER BY updated_at DESC, id DESC").all(user) as unknown as NotebookRow[])
      .map((row) => ({ id: row.id, title: row.title, security: row.security, revision: row.revision, updatedAt: row.updated_at }));
  }

  get(user: string, id: number): Notebook | null {
    const row = this.db.prepare("SELECT * FROM research_notebooks WHERE id = ? AND user = ?").get(id, user) as NotebookRow | undefined;
    return row ? toNotebook(row) : null;
  }

  create(user: string, raw: unknown): Notebook {
    const input = validateNotebook(raw);
    const timestamp = new Date(this.now()).toISOString();
    const row = this.db.prepare("INSERT INTO research_notebooks (user, title, security, json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?) RETURNING *")
      .get(user, input.title, input.security, JSON.stringify(input), timestamp, timestamp) as unknown as NotebookRow;
    return toNotebook(row);
  }

  update(user: string, id: number, revision: unknown, raw: unknown): Notebook | null {
    if (!this.get(user, id)) return null;
    const expected = revisionOf(revision);
    const input = validateNotebook(raw);
    const row = this.db.prepare("UPDATE research_notebooks SET title = ?, security = ?, json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND user = ? AND revision = ? RETURNING *")
      .get(input.title, input.security, JSON.stringify(input), new Date(this.now()).toISOString(), id, user, expected) as NotebookRow | undefined;
    if (row) return toNotebook(row);
    const latest = this.get(user, id);
    if (latest) throw new NotebookConflictError(latest.revision);
    return null;
  }

  remove(user: string, id: number, revision: unknown): boolean {
    if (!this.get(user, id)) return false;
    const expected = revisionOf(revision);
    if (this.db.prepare("DELETE FROM research_notebooks WHERE id = ? AND user = ? AND revision = ?").run(id, user, expected).changes) return true;
    const latest = this.get(user, id);
    if (latest) throw new NotebookConflictError(latest.revision);
    return false;
  }
}

export function registerNotebookRoutes(app: express.Express, store: NotebookStore): void {
  const userOf = (req: express.Request, res: express.Response): string | null => {
    const user = normalizeUser((req.body as { user?: unknown } | undefined)?.user ?? req.query.user);
    if (!user) res.status(400).json({ error: "user is required (your login name)" });
    return user;
  };
  const idOf = (req: express.Request, res: express.Response): number | null => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      res.status(404).json({ error: "NOTEBOOK NOT FOUND" });
      return null;
    }
    return id;
  };
  const handle = (action: (req: express.Request, res: express.Response) => void) => (req: express.Request, res: express.Response) => {
    try {
      action(req, res);
    } catch (error) {
      if (error instanceof NotebookValidationError) res.status(400).json({ error: error.message });
      else if (error instanceof NotebookConflictError) res.status(409).json({ error: error.message, revision: error.revision });
      else throw error;
    }
  };
  app.get("/api/notebooks", handle((req, res) => {
    const user = userOf(req, res);
    if (user) res.json(store.list(user));
  }));
  app.post("/api/notebooks", handle((req, res) => {
    const user = userOf(req, res);
    if (user) res.status(201).json(store.create(user, req.body));
  }));
  app.get("/api/notebooks/:id", handle((req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    const notebook = store.get(user, id);
    if (notebook) res.json(notebook);
    else res.status(404).json({ error: "NOTEBOOK NOT FOUND" });
  }));
  app.put("/api/notebooks/:id", handle((req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    const notebook = store.update(user, id, (req.body as { revision?: unknown } | undefined)?.revision, req.body);
    if (notebook) res.json(notebook);
    else res.status(404).json({ error: "NOTEBOOK NOT FOUND" });
  }));
  app.delete("/api/notebooks/:id", handle((req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    const revision = (req.body as { revision?: unknown } | undefined)?.revision ?? req.query.revision;
    if (store.remove(user, id, revision)) res.status(204).end();
    else res.status(404).json({ error: "NOTEBOOK NOT FOUND" });
  }));
}
