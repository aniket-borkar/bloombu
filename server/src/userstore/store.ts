import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import type express from "express";
import { normalizeUser } from "../chat/chat.js";

export const DOC_KINDS = ["sheet", "workspace", "strategy", "query"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

const MAX_DOC_BYTES = 512 * 1024;

export interface DocSummary {
  name: string;
  updated: number;
}

/** Small JSON documents per user and kind (sheets, workspaces, strategies, saved queries). */
export class UserStore {
  private db: DatabaseSync;

  constructor(
    file: string,
    private now: () => number = Date.now,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_docs (
        user TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        json TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (user, kind, name)
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  list(user: string, kind: DocKind): DocSummary[] {
    return (
      this.db.prepare("SELECT name, updated FROM user_docs WHERE user = ? AND kind = ? ORDER BY name COLLATE NOCASE").all(user, kind) as unknown as DocSummary[]
    ).map((r) => ({ ...r }));
  }

  get(user: string, kind: DocKind, name: string): unknown | null {
    const row = this.db.prepare("SELECT json FROM user_docs WHERE user = ? AND kind = ? AND name = ?").get(user, kind, name) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : null;
  }

  put(user: string, kind: DocKind, name: string, data: unknown): void {
    const json = JSON.stringify(data);
    if (json.length > MAX_DOC_BYTES) throw new Error(`Document larger than ${MAX_DOC_BYTES / 1024} KB`);
    this.db
      .prepare(
        `INSERT INTO user_docs (user, kind, name, json, updated) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user, kind, name) DO UPDATE SET json = excluded.json, updated = excluded.updated`,
      )
      .run(user, kind, name, json, this.now());
  }

  remove(user: string, kind: DocKind, name: string): boolean {
    return Number(this.db.prepare("DELETE FROM user_docs WHERE user = ? AND kind = ? AND name = ?").run(user, kind, name).changes) > 0;
  }
}

export function registerDocRoutes(app: express.Express, store: UserStore): void {
  const params = (req: express.Request, res: express.Response, needName: boolean) => {
    const user = normalizeUser((req.body as { user?: unknown } | undefined)?.user ?? req.query.user);
    const kind = req.params.kind as DocKind;
    const name = typeof req.params.name === "string" ? req.params.name.trim() : "";
    if (!user) {
      res.status(400).json({ error: "user is required" });
      return null;
    }
    if (!DOC_KINDS.includes(kind)) {
      res.status(404).json({ error: "UNKNOWN DOCUMENT KIND" });
      return null;
    }
    if (needName && (!name || name.length > 60)) {
      res.status(400).json({ error: "name must be 1-60 characters" });
      return null;
    }
    return { user, kind, name };
  };

  app.get("/api/docs/:kind", (req, res) => {
    const p = params(req, res, false);
    if (p) res.json(store.list(p.user, p.kind));
  });

  app.get("/api/docs/:kind/:name", (req, res) => {
    const p = params(req, res, true);
    if (!p) return;
    const doc = store.get(p.user, p.kind, p.name);
    if (doc === null) res.status(404).json({ error: "NOT FOUND" });
    else res.json(doc);
  });

  app.put("/api/docs/:kind/:name", (req, res) => {
    const p = params(req, res, true);
    if (!p) return;
    const data = (req.body as { data?: unknown })?.data;
    if (data === undefined) {
      res.status(400).json({ error: "data is required" });
      return;
    }
    try {
      store.put(p.user, p.kind, p.name, data);
      res.status(204).end();
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete("/api/docs/:kind/:name", (req, res) => {
    const p = params(req, res, true);
    if (!p) return;
    if (store.remove(p.user, p.kind, p.name)) res.status(204).end();
    else res.status(404).json({ error: "NOT FOUND" });
  });
}
