import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { HistoryCache } from "../history/cache.js";
import { registerPortfolioRoutes } from "../portfolio/routes.js";
import { PortfolioService } from "../portfolio/service.js";
import { PortfolioStore } from "../portfolio/store.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { StreamHub } from "../stream/hub.js";
import { attachWebSocket } from "../stream/ws.js";
import { AuthError, AuthService, parseCookies } from "./auth.js";

describe("AuthService", () => {
  it("registers, logs in, expires sessions and limits guessing", () => {
    let t = 1_000;
    const auth = new AuthService(":memory:", false, () => t);
    const token = auth.register("alice", "correct horse");
    expect(auth.userForToken(token)).toBe("ALICE");
    expect(() => auth.register("bob", "another pass")).toThrow(/closed/);
    expect(() => auth.register("x", "short")).toThrow(AuthError);
    expect(auth.userForToken(auth.login("ALICE", "correct horse"))).toBe("ALICE");
    for (let i = 0; i < 10; i++) expect(() => auth.login("alice", "wrong password", "1.2.3.4")).toThrow(/Wrong login/);
    expect(() => auth.login("alice", "correct horse", "1.2.3.4")).toThrow(/Too many attempts/);
    expect(auth.userForToken(auth.login("alice", "correct horse", "5.6.7.8"))).toBe("ALICE");
    auth.logout(token);
    expect(auth.userForToken(token)).toBeNull();
    const later = auth.login("alice", "correct horse", "9.9.9.9");
    t += 31 * 86_400_000;
    expect(auth.userForToken(later)).toBeNull();
    expect(parseCookies("a=1; blmbu_session=abc%3D")).toEqual({ a: "1", blmbu_session: "abc=" });
  });

  it("reads AUTH settings", () => {
    expect(loadConfig({}).auth).toBeNull();
    expect(loadConfig({ AUTH: "password", AUTH_SIGNUP: "closed" })).toMatchObject({ auth: "password", authSignupOpen: false });
    expect(() => loadConfig({ AUTH: "oauth" })).toThrow(/Unknown AUTH/);
  });
});

describe("sign-in gate", () => {
  const router = new ProviderRouter([createMockProvider()], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t));
  const store = new PortfolioStore(":memory:");
  const auth = new AuthService(":memory:");
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ router, history, auth, routes: [(a) => registerPortfolioRoutes(a, store, new PortfolioService(router, history))] }).listen(0);
    attachWebSocket(server, new StreamHub(router, 60_000, () => {}), { authenticate: (req) => auth.userForRequest(req) });
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const call = async (method: string, path: string, body?: unknown, cookie?: string) => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), setCookie: res.headers.get("set-cookie") };
  };
  const cookieFrom = (setCookie: string | null) => setCookie!.split(";")[0];

  it("requires sign-in and pins every request to the signed-in user", async () => {
    expect((await call("GET", "/api/auth/me")).body).toEqual({ authRequired: true, user: null, signup: true });
    expect((await call("GET", "/api/portfolios?user=ALICE")).status).toBe(401);
    expect((await call("GET", "/api/health")).status).toBe(200);

    const alice = await call("POST", "/api/auth/register", { name: "alice", password: "alice-pass-1" });
    expect(alice.setCookie).toMatch(/blmbu_session=.+; HttpOnly; SameSite=Lax/);
    const aliceCookie = cookieFrom(alice.setCookie);
    const bob = cookieFrom((await call("POST", "/api/auth/register", { name: "bob", password: "bob-pass-12" })).setCookie);
    expect((await call("GET", "/api/auth/me", undefined, aliceCookie)).body.user).toBe("ALICE");

    const created = await call("POST", "/api/portfolios", { user: "BOB", name: "Secret", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 1 }] }, aliceCookie);
    expect(created.body.user).toBe("ALICE");
    expect((await call("GET", "/api/portfolios?user=ALICE", undefined, bob)).body).toEqual([]);
    expect((await call("GET", `/api/portfolios/${created.body.id}?user=ALICE&user=ALICE`, undefined, bob)).status).toBe(404);
    expect((await call("GET", "/api/portfolios?user=BOB", undefined, aliceCookie)).body.map((p: { name: string }) => p.name)).toEqual(["Secret"]);

    expect((await call("POST", "/api/auth/login", { name: "alice", password: "nope-nope" })).status).toBe(401);
    await call("POST", "/api/auth/logout", {}, aliceCookie);
    expect((await call("GET", "/api/portfolios?user=ALICE", undefined, aliceCookie)).status).toBe(401);
  });

  it("refuses WebSocket connections without a session", async () => {
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const anon = new WebSocket(url);
    await expect(new Promise((resolve, reject) => (anon.once("open", resolve), anon.once("error", reject)))).rejects.toThrow(/401/);
    const cookie = cookieFrom((await call("POST", "/api/auth/login", { name: "bob", password: "bob-pass-12" })).setCookie);
    const ws = new WebSocket(url, { headers: { cookie } });
    await new Promise((r) => ws.once("open", r));
    ws.close();
  });
});
