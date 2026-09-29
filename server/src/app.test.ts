import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { HistoryCache } from "./history/cache.js";
import { createMockProvider } from "./providers/mock.js";
import { ProviderRouter } from "./providers/router.js";

const T = Date.UTC(2026, 8, 25, 15, 30);
let server: Server;
let base: string;

beforeAll(async () => {
  const router = new ProviderRouter([createMockProvider(() => T)], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
  server = createApp({ router, history, now: () => T }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

describe("API", () => {
  it("lists providers", async () => {
    const { body } = await get("/api/providers");
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("mock");
    expect(body[0].capabilities).toEqual(expect.arrayContaining(["quotes", "search", "history", "profile", "options", "yieldCurve", "econCalendar"]));
    expect(body[0].capabilities).not.toContain("subscribe");
  });

  it("returns quotes and 404s unknown or unparseable securities", async () => {
    expect((await get("/api/quote/aapl%20us%20equity")).body.security).toBe("AAPL US Equity");
    expect((await get("/api/quote/ZZZZQX%20US%20Equity")).status).toBe(404);
    expect((await get("/api/quote/garbage")).status).toBe(404);
  });

  it("returns history bars within the range", async () => {
    const { status, body } = await get("/api/history/SPX%20Index?interval=1d&range=1mo");
    expect(status).toBe(200);
    expect(body).toMatchObject({ security: "SPX Index", interval: "1d", range: "1mo" });
    expect(body.bars.length).toBeGreaterThan(25);
    expect(body.bars[0]).toEqual({ t: expect.any(Number), o: expect.any(Number), h: expect.any(Number), l: expect.any(Number), c: expect.any(Number), v: expect.any(Number) });
    expect(body.bars[0].t).toBeGreaterThanOrEqual(T - 31 * 86_400_000);
  });

  it("validates history parameters", async () => {
    expect((await get("/api/history/SPX%20Index?interval=1m&range=1y")).status).toBe(400);
    expect((await get("/api/history/SPX%20Index?interval=3m")).status).toBe(400);
    expect((await get("/api/history/ZZZZQX%20US%20Equity")).status).toBe(404);
  });

  it("returns the ticker tape", async () => {
    const { body } = await get("/api/indices");
    expect(body.map((q: { security: string }) => q.security)).toContain("SPX Index");
    expect(body.length).toBe(20);
  });

  it("falls back to the latest session when the window has no bars", async () => {
    const closedSince = T - 2 * 86_400_000;
    const mock = createMockProvider(() => T);
    const router = new ProviderRouter(
      [
        {
          ...mock,
          history: async (s, i, from, to) =>
            (await mock.history!(s, i, from, new Date(Math.min(to.getTime(), closedSince)))),
        },
      ],
      () => {},
    );
    const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
    const srv = createApp({ router, history, now: () => T }).listen(0);
    await new Promise((r) => srv.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/history/SPX%20Index?interval=5m&range=1d`);
    const body = await res.json();
    srv.close();
    expect(res.status).toBe(200);
    const ts = body.bars.map((b: { t: number }) => b.t);
    expect(Math.max(...ts)).toBeLessThanOrEqual(closedSince);
    expect(Math.max(...ts) - Math.min(...ts)).toBeLessThan(86_400_000);
    expect(ts.length).toBeGreaterThan(250);
  });

  it("serves the built client with an SPA fallback, but not for /api", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "blmbu-static-"));
    const dir = path.join(parent, ".hidden-parent", "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.html"), "<html>terminal</html>");
    writeFileSync(path.join(dir, "app.js"), "console.log(1)");
    const router = new ProviderRouter([createMockProvider(() => T)], () => {});
    const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
    const srv = createApp({ router, history, staticDir: dir }).listen(0);
    await new Promise((r) => srv.once("listening", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${url}/`)).text()).toBe("<html>terminal</html>");
      expect(await (await fetch(`${url}/some/deep/link`)).text()).toBe("<html>terminal</html>");
      expect(await (await fetch(`${url}/app.js`)).text()).toBe("console.log(1)");
      const api = await fetch(`${url}/api/nope`);
      expect(api.status).toBe(404);
      expect(await api.json()).toEqual({ error: "NOT FOUND" });
    } finally {
      srv.close();
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("searches", async () => {
    expect((await get("/api/search?q=microsoft")).body[0].security).toBe("MSFT US Equity");
    expect((await get("/api/search?q=")).body).toEqual([]);
  });
});
