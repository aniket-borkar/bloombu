import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService, registerAuth } from "../auth/auth.js";
import { analyzePortfolio } from "../portfolio/analytics.js";
import { analyzeScenario, validateScenario } from "../portfolio/scenario.js";
import type { Quote } from "../types.js";
import { NotebookConflictError, NotebookStore, NotebookValidationError, registerNotebookRoutes, validateNotebook, type NotebookInput } from "./notebooks.js";

const draft = (overrides: Partial<NotebookInput> = {}): NotebookInput => ({
  title: "Apple thesis",
  security: "AAPL US Equity",
  thesis: "Services growth can offset slower hardware sales.",
  bearCase: "Hardware weakness could outweigh services growth.",
  catalysts: "Next quarterly report",
  reviewDate: "2026-11-01",
  evidence: [{
    id: "snapshot-1",
    kind: "valuation",
    title: "Observed valuation assumptions",
    security: "AAPL US Equity",
    source: "Mock",
    url: "https://example.com/research?security=AAPL",
    asOf: "2026-10-26",
    capturedAt: "2026-10-26T12:00:00.000Z",
    data: { price: 200, assumptions: { growthPct: 8, years: 5 }, rows: [["base", 230], ["bear", null]], confirmed: false },
  }],
  ...overrides,
});

describe("NotebookStore", () => {
  it("retains a full 500-lot scenario snapshot within the total notebook limit", () => {
    const security = "AAPL US Equity";
    const analytics = analyzePortfolio({
      name: "500 lots", kind: "positions", baseCurrency: "USD", notional: null,
      holdings: Array.from({ length: 500 }, (_, i) => ({ security, quantity: i + 1, weight: null, cost: null, acquired: null })),
      quotes: new Map([[security, { security, name: "Apple", last: 200, prevClose: 195, currency: "USD" } as Quote]]),
      bars: new Map(), usdPer: new Map(), sectors: new Map([[security, "Technology"]]),
      benchmark: { security: "SPX Index", bars: [] }, riskFreePct: null, range: "1y", now: Date.UTC(2026, 9, 26),
    });
    const result = analyzeScenario(analytics, validateScenario({ name: "Downturn", marketPct: -20 }));
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(64 * 1024);
    const store = new NotebookStore(":memory:");
    try {
      const notebook = store.create("ALICE", draft({ evidence: [{ ...draft().evidence[0], kind: "scenario", data: result }] }));
      expect(store.get("ALICE", notebook.id)?.evidence[0].data).toEqual(JSON.parse(JSON.stringify(result)));
    } finally {
      store.close();
    }
  });

  it("preserves captured evidence across reopen and isolates stale writers on separate connections", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "blmbu-notebooks-"));
    const file = path.join(dir, "fresh", "research.db");
    let store: NotebookStore | undefined;
    let other: NotebookStore | undefined;
    try {
      store = new NotebookStore(file, () => Date.UTC(2026, 9, 26, 12));
      const input = draft();
      const notebook = store.create("ALICE", input);
      expect(notebook).toMatchObject({ id: 1, user: "ALICE", revision: 1, createdAt: "2026-10-26T12:00:00.000Z" });
      (input.evidence[0].data as { price: number }).price = 999;
      expect(store.get("ALICE", notebook.id)?.evidence).toEqual(draft().evidence);
      expect(store.get("BOB", notebook.id)).toBeNull();
      expect(store.list("BOB")).toEqual([]);
      store.close();
      store = new NotebookStore(file);
      expect(store.get("ALICE", notebook.id)).toEqual(notebook);

      other = new NotebookStore(file);
      const changed = other.update("ALICE", notebook.id, 1, draft({ thesis: "An updated thesis" }))!;
      expect(changed.revision).toBe(2);
      expect(changed.createdAt).toBe(notebook.createdAt);
      expect(() => store!.update("ALICE", notebook.id, 1, draft({ thesis: "Stale draft" }))).toThrow(NotebookConflictError);
      expect(() => store!.remove("ALICE", notebook.id, 1)).toThrow(NotebookConflictError);
      expect(store.get("ALICE", notebook.id)?.thesis).toBe("An updated thesis");
      expect(store.list("ALICE")).toEqual([{ id: notebook.id, title: changed.title, security: changed.security, revision: 2, updatedAt: changed.updatedAt }]);
      expect(store.remove("BOB", notebook.id, 2)).toBe(false);
      expect(store.remove("ALICE", notebook.id, 2)).toBe(true);
      expect(store.get("ALICE", notebook.id)).toBeNull();
    } finally {
      other?.close();
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("notebook validation", () => {
  it("allows a blank general-research notebook and preserves source metadata exactly", () => {
    expect(validateNotebook({ title: "  General research  " })).toEqual({
      title: "General research", security: null, thesis: "", bearCase: "", catalysts: "", reviewDate: null, evidence: [],
    });
    const input = draft();
    expect(validateNotebook(input)).toEqual(input);
    expect(validateNotebook(draft({ security: "aapl us equity", reviewDate: "2028-02-29" })).security).toBe("AAPL US Equity");
  });

  it("rejects executable URLs, invalid dates, duplicate evidence and malformed securities", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://example.com/report", "not a url", "https://example.com/\nreport"]) {
      const input = draft();
      input.evidence[0].url = url;
      expect(() => validateNotebook(input)).toThrow(/URLs must use http/);
    }
    expect(() => validateNotebook(draft({ reviewDate: "2026-02-30" }))).toThrow(/reviewDate/);
    expect(() => validateNotebook(draft({ security: "not a security" }))).toThrow(/security/);
    const invalidDate = draft();
    invalidDate.evidence[0].capturedAt = "2026-02-30T12:00:00Z";
    expect(() => validateNotebook(invalidDate)).toThrow(/capturedAt/);
    invalidDate.evidence[0].capturedAt = "2026-10-26T12:00:00";
    expect(() => validateNotebook(invalidDate)).toThrow(/timezone/);
    const duplicate = draft();
    duplicate.evidence.push({ ...duplicate.evidence[0] });
    expect(() => validateNotebook(duplicate)).toThrow(/unique/);
  });

  it("bounds text, evidence counts, JSON snapshots and total UTF-8 payload size", () => {
    expect(() => validateNotebook(draft({ title: " " }))).toThrow(NotebookValidationError);
    expect(() => validateNotebook(draft({ thesis: "x".repeat(20_001) }))).toThrow(/thesis/);
    expect(() => validateNotebook(draft({ evidence: Array.from({ length: 101 }, (_, i) => ({ ...draft().evidence[0], id: String(i) })) }))).toThrow(/100/);
    const huge = draft();
    huge.evidence[0].data = "€".repeat(200_000);
    expect(() => validateNotebook(huge)).toThrow(/512 KB/);
    const aggregate = draft({ evidence: Array.from({ length: 9 }, (_, i) => ({ ...draft().evidence[0], id: String(i), data: "x".repeat(60_000) })) });
    expect(() => validateNotebook(aggregate)).toThrow(/512 KB/);
    for (const data of [Infinity, { missing: undefined }, new Date(), () => {}]) {
      const input = draft();
      input.evidence[0].data = data;
      expect(() => validateNotebook(input)).toThrow(/JSON values/);
    }
    const deep = draft();
    let data: unknown = 1;
    for (let i = 0; i < 32; i++) data = { data };
    deep.evidence[0].data = data;
    expect(() => validateNotebook(deep)).toThrow(/nested too deeply/);
  });
});

describe("notebook API", () => {
  let server: Server | undefined;
  let store: NotebookStore | undefined;
  let base = "";
  const start = async (auth: AuthService | null = null) => {
    store = new NotebookStore(":memory:");
    const app = express();
    app.use(express.json({ limit: "1mb" }));
    registerAuth(app, auth);
    registerNotebookRoutes(app, store);
    server = app.listen(0);
    await new Promise((resolve) => server!.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const call = async (method: string, endpoint: string, body?: unknown, cookie?: string) => {
    const response = await fetch(base + endpoint, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: response.status === 204 ? null : await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  afterEach(async () => {
    if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    server = undefined;
    store?.close();
    store = undefined;
  });

  it("creates, lists, reads, updates and deletes with revision conflict protection", async () => {
    await start();
    const created = await call("POST", "/api/notebooks", { user: "alice", ...draft() });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ user: "ALICE", revision: 1 });
    const id = created.body.id;
    expect((await call("GET", "/api/notebooks?user=alice")).body).toEqual([{ id, title: "Apple thesis", security: "AAPL US Equity", revision: 1, updatedAt: created.body.updatedAt }]);
    expect((await call("GET", `/api/notebooks/${id}?user=ALICE`)).body.evidence).toEqual(draft().evidence);
    expect((await call("GET", `/api/notebooks/${id}?user=BOB`)).status).toBe(404);
    expect((await call("PUT", `/api/notebooks/${id}`, { user: "ALICE", ...draft() })).status).toBe(400);
    const changed = await call("PUT", `/api/notebooks/${id}`, { user: "ALICE", revision: 1, ...draft({ title: "Revised thesis" }) });
    expect(changed.status).toBe(200);
    expect(changed.body.revision).toBe(2);
    const stale = await call("PUT", `/api/notebooks/${id}`, { user: "ALICE", revision: 1, ...draft({ title: "Stale write" }) });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ revision: 2 });
    expect((await call("DELETE", `/api/notebooks/${id}?user=ALICE`)).status).toBe(400);
    expect((await call("DELETE", `/api/notebooks/${id}?user=ALICE&revision=1`)).status).toBe(409);
    expect((await call("DELETE", `/api/notebooks/${id}?user=ALICE&revision=2`)).status).toBe(204);
    expect((await call("GET", `/api/notebooks/${id}?user=ALICE`)).status).toBe(404);
  });

  it("pins notebook ownership to authenticated users for every operation", async () => {
    await start(new AuthService(":memory:"));
    expect((await call("GET", "/api/notebooks?user=ALICE")).status).toBe(401);
    const alice = (await call("POST", "/api/auth/register", { name: "alice", password: "alice-password" })).cookie!;
    const bob = (await call("POST", "/api/auth/register", { name: "bob", password: "bob-password" })).cookie!;
    const created = await call("POST", "/api/notebooks", { user: "BOB", ...draft() }, alice);
    expect(created.body.user).toBe("ALICE");
    const id = created.body.id;
    expect((await call("GET", "/api/notebooks?user=ALICE", undefined, bob)).body).toEqual([]);
    expect((await call("GET", `/api/notebooks/${id}?user=ALICE`, undefined, bob)).status).toBe(404);
    expect((await call("PUT", `/api/notebooks/${id}`, { user: "ALICE", revision: 1, ...draft() }, bob)).status).toBe(404);
    expect((await call("DELETE", `/api/notebooks/${id}?user=ALICE&revision=1`, undefined, bob)).status).toBe(404);
    expect((await call("GET", `/api/notebooks/${id}?user=BOB`, undefined, alice)).body.user).toBe("ALICE");
  });

  it("returns validation errors without saving bad notebooks or fetching their sources", async () => {
    await start();
    const input = draft();
    input.evidence[0].url = "javascript:alert(1)";
    expect((await call("POST", "/api/notebooks", { user: "ALICE", ...input })).status).toBe(400);
    expect((await call("POST", "/api/notebooks", { user: "bad user", ...draft() })).status).toBe(400);
    expect((await call("GET", "/api/notebooks/bad?user=ALICE")).status).toBe(404);
    expect((await call("GET", "/api/notebooks?user=ALICE")).body).toEqual([]);
  });
});
