import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { AuthService, SESSION_COOKIE } from "./auth/auth.js";
import { HistoryCache } from "./history/cache.js";
import type { ProviderPlugin } from "./providers/DataProvider.js";
import { ProviderRouter } from "./providers/router.js";

const resources: { server: Server; history: HistoryCache }[] = [];
afterEach(async () => {
  for (const { server, history } of resources.splice(0)) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    history.close();
  }
});

function plugin(id: string, options: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return {
    id,
    sectors: ["Equity", "Curncy", "Index", "Comdty", "Govt"],
    quotes: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    ...options,
  };
}

async function serve(plugins: ProviderPlugin[], auth: AuthService | null = null) {
  const router = new ProviderRouter(plugins, () => {});
  const history = new HistoryCache(":memory:", (s, i, from, to) => router.history(s, i, from, to));
  const server = createApp({ router, history, auth }).listen(0);
  resources.push({ server, history });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/stream/routes`;
  return async (query = "", cookie?: string) => {
    const response = await fetch(base + query, cookie ? { headers: { cookie } } : undefined);
    return { status: response.status, body: await response.json() };
  };
}

const query = (...securities: string[]) => `?s=${encodeURIComponent(securities.join(","))}`;

describe("direct quote stream route policy", () => {
  it("normalizes and deduplicates securities while selecting the first configured quote provider", async () => {
    const kraken = plugin("kraken", { covers: (security) => security === "XBTUSD Curncy" });
    const yahoo = plugin("yahoo");
    const get = await serve([kraken, yahoo]);
    expect(await get(query(" aapl us <equity> ", "AAPL US Equity", "xbtusd curncy", "EURUSD Curncy"))).toEqual({
      status: 200,
      body: { routes: [
        { security: "AAPL US Equity", provider: "yahoo" },
        { security: "XBTUSD Curncy", provider: "kraken" },
        { security: "EURUSD Curncy", provider: "yahoo" },
      ] },
    });
    expect(kraken.quotes).not.toHaveBeenCalled();
    expect(kraken.subscribe).not.toHaveBeenCalled();
    expect(yahoo.quotes).not.toHaveBeenCalled();
    expect(yahoo.subscribe).not.toHaveBeenCalled();
  });

  it("does not bypass a mock or nonstreaming provider earlier in quote priority", async () => {
    const get = await serve([plugin("mock", { subscribe: undefined }), plugin("yahoo")]);
    expect((await get(query("AAPL US Equity", "EURUSD Curncy"))).body).toEqual({ routes: [
      { security: "AAPL US Equity", provider: null },
      { security: "EURUSD Curncy", provider: null },
    ] });
  });

  it("returns null for custom streaming providers and uncovered securities", async () => {
    const get = await serve([plugin("private-feed", { requiresKey: "PRIVATE_KEY", sectors: ["Equity"] })]);
    expect((await get(query("AAPL US Equity", "EURUSD Curncy"))).body).toEqual({ routes: [
      { security: "AAPL US Equity", provider: null },
      { security: "EURUSD Curncy", provider: null },
    ] });
  });

  it.each(["", "?s=", "?s=garbage", query("AAPL US Equity", "garbage"), query("AAPL US Equity", ""), "?s=AAPL%20US%20Equity&s=EURUSD%20Curncy", "?s[]=AAPL%20US%20Equity"])("rejects malformed queries: %s", async (input) => {
    const get = await serve([plugin("yahoo")]);
    expect((await get(input)).status).toBe(400);
  });

  it("accepts 200 securities and rejects longer input before deduplication", async () => {
    const get = await serve([plugin("yahoo")]);
    const securities = Array.from({ length: 200 }, (_, i) => `TEST${i} US Equity`);
    expect((await get(query(...securities))).body.routes).toHaveLength(200);
    expect((await get(query(...securities, securities[0]))).status).toBe(400);
  });

  it("uses the existing API authentication gate", async () => {
    const auth = new AuthService(":memory:");
    const token = auth.register("researcher", "example-password");
    const get = await serve([plugin("yahoo")], auth);
    expect((await get(query("AAPL US Equity"))).status).toBe(401);
    expect(await get(query("AAPL US Equity"), `${SESSION_COOKIE}=${token}`)).toEqual({
      status: 200,
      body: { routes: [{ security: "AAPL US Equity", provider: "yahoo" }] },
    });
  });
});
