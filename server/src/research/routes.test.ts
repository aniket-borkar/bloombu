import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { ChatService } from "../chat/chat.js";
import { HistoryCache } from "../history/cache.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { SCREENS } from "../types.js";

const T = Date.UTC(2026, 8, 25, 15, 30);
let server: Server;
let base: string;
let chat: ChatService;

beforeAll(async () => {
  const router = new ProviderRouter([createMockProvider(() => T)], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
  chat = new ChatService(":memory:");
  server = createApp({ router, history, chat, now: () => T }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  chat.close();
});

const get = async (path: string) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};

const AAPL = encodeURIComponent("AAPL US Equity");

describe("research API (mock provider)", () => {
  it.each([
    [`/api/profile/${AAPL}`, (b: any) => expect(b.officers.length).toBeGreaterThan(0)],
    [`/api/financials/${AAPL}?statement=income&period=annual`, (b: any) => expect(b.rows[0].label).toBe("Revenue")],
    [`/api/financials/${AAPL}?statement=balance&period=quarterly`, (b: any) => expect(b.columns).toHaveLength(5)],
    [`/api/financials/${AAPL}?statement=cashflow&period=annual`, (b: any) => expect(b.rows.map((r: any) => r.key)).toContain("freeCashFlow")],
    [`/api/earnings/${AAPL}`, (b: any) => expect(b.estimates).toHaveLength(4)],
    [`/api/analysts/${AAPL}`, (b: any) => expect(b.targetHigh).toBeGreaterThan(b.targetLow)],
    [`/api/holders/${AAPL}`, (b: any) => expect(b.institutions).toHaveLength(10)],
    [`/api/events/${AAPL}`, (b: any) => expect(Array.isArray(b.dividends)).toBe(true)],
    [`/api/options/${AAPL}`, (b: any) => expect(b.calls.length).toBe(b.puts.length)],
    [`/api/related/${AAPL}`, (b: any) => expect(b).not.toContain("AAPL US Equity")],
    [`/api/valuations?s=${AAPL},MSFT%20US%20Equity`, (b: any) => expect(b.map((v: any) => v.security)).toEqual(["AAPL US Equity", "MSFT US Equity"])],
    [`/api/quotes?s=SPX%20Index,EURUSD%20Curncy`, (b: any) => expect(b).toHaveLength(2)],
    [`/api/listings/${AAPL}`, (b: any) => expect(b[0].security).toBe("AAPL US Equity")],
    [`/api/futures/${encodeURIComponent("CL1 Comdty")}`, (b: any) => expect(b.contracts[0].security).toMatch(/^CL[FGHJKMNQUVXZ]\d Comdty$/)],
    [`/api/news/company/${AAPL}`, (b: any) => expect(b[0].title).toContain("Apple")],
    [`/api/news?q=energy`, (b: any) => expect(b.length).toBeGreaterThan(0)],
    [`/api/news/top`, (b: any) => expect(b.length).toBeGreaterThan(0)],
    [`/api/curve`, (b: any) => expect(b.points.find((p: any) => p.tenor === "10Y")).toBeTruthy()],
    [`/api/money-markets`, (b: any) => expect(b.rates.map((r: any) => r.name)).toContain("SOFR")],
    [`/api/econ/stats`, (b: any) => expect(b.countries.length).toBeGreaterThan(10)],
    [`/api/econ/calendar`, (b: any) => expect(b[0]).toHaveProperty("name")],
    [`/api/chat/rooms?user=alice`, (b: any) => expect(b.map((r: any) => r.room)).toContain("#general")],
  ])("GET %s", async (path, check) => {
    const { status, body } = await get(path);
    expect(status).toBe(200);
    check(body);
  });

  it("serves every predefined screen", async () => {
    for (const id of Object.keys(SCREENS)) {
      const { status, body } = await get(`/api/screens/${id}`);
      expect(status, id).toBe(200);
      expect(body.length, id).toBeGreaterThan(0);
    }
    expect((await get("/api/screens/nope")).status).toBe(404);
  });

  it("selects option expirations", async () => {
    const first = (await get(`/api/options/${AAPL}`)).body;
    const second = (await get(`/api/options/${AAPL}?expiration=${encodeURIComponent(first.expirations[1])}`)).body;
    expect(second.expiration).toBe(first.expirations[1]);
  });

  it("prices specific futures contracts from the chain", async () => {
    const chain = (await get(`/api/futures/${encodeURIComponent("GC1 Comdty")}`)).body;
    const q = await get(`/api/quote/${encodeURIComponent(chain.contracts[1].security)}`);
    expect(q.status).toBe(200);
    expect(q.body.name).toMatch(/Gold/);
  });

  it("returns 404 for non-equities on equity-only research and validates parameters", async () => {
    expect((await get(`/api/financials/${encodeURIComponent("SPX Index")}`)).status).toBe(404);
    expect((await get(`/api/financials/${AAPL}?statement=bogus`)).status).toBe(400);
    expect((await get(`/api/options/${AAPL}?expiration=notadate`)).status).toBe(400);
    expect((await get(`/api/quotes?s=`)).status).toBe(400);
    expect((await get(`/api/news`)).status).toBe(400);
    expect((await get(`/api/profile/garbage`)).status).toBe(404);
  });
});
