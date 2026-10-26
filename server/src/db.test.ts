import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KvCache } from "./cache/kv.js";
import { openDatabase } from "./db.js";

describe("openDatabase", () => {
  it("creates missing parent directories for the first service opened at startup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "blmbu-db-"));
    const file = path.join(dir, "fresh", "data", "cache.db");
    let cache: KvCache | undefined;
    try {
      cache = new KvCache(file);
      cache.set("startup", { ok: true }, 60_000);
      cache.close();
      cache = undefined;

      cache = new KvCache(file);
      expect(cache.get("startup")).toEqual({ ok: true });
    } finally {
      cache?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps in-memory databases independent", () => {
    const first = openDatabase(":memory:");
    const second = openDatabase(":memory:");
    try {
      first.exec("CREATE TABLE test (value INTEGER); INSERT INTO test VALUES (1)");
      expect(first.prepare("SELECT value FROM test").get()).toEqual({ value: 1 });
      expect(second.prepare("SELECT name FROM sqlite_master WHERE name = 'test'").get()).toBeUndefined();
    } finally {
      first.close();
      second.close();
    }
  });
});
