import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Open the shared SQLite file. Several stores (and, during development, a
 * restarting second server) use it at once, so wait up to 5 s for a lock
 * instead of failing with "database is locked".
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  return db;
}
