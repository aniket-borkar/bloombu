import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { Quote, Trade } from "../types.js";
import { createKrakenProvider } from "./kraken.js";
import { UsageMeter } from "./usage.js";

const T = "2026-10-23T18:00:00.000Z";
const T1 = "2026-10-23T18:00:01.000Z";
const restTicker = { error: [], result: { "BTC/USD": { a: ["101", "1", "0.25"], b: ["99", "1", "0.5"], c: ["100", "1"], h: ["103", "105"], l: ["97", "95"], v: ["10", "20"], o: "98" } } };
const recentTrade = { error: [], result: { "BTC/USD": [["100", "0.1", Date.parse(T) / 1000, "b", "m", "", 1]], last: "cursor-not-a-time" } };
const ticker = (at = T1, last = 102) => ({ channel: "ticker", type: "update", data: [{ symbol: "BTC/USD", timestamp: at, last, bid: last - 1, ask: last + 1, bid_qty: 0.5, ask_qty: 0.25, change: 2, change_pct: 2, high: 105, low: 95, volume: 25 }] });
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});
function mockRest() {
  const fetcher = vi.fn(async (input: URL) => Response.json(input.pathname.endsWith("/Trades") ? recentTrade : restTicker));
  vi.stubGlobal("fetch", fetcher); return fetcher;
}
async function feed() {
  const server = new WebSocketServer({ port: 0 });
  const connections: WebSocket[] = []; const messages: unknown[] = [];
  server.on("connection", (ws) => { connections.push(ws); ws.on("message", (data) => messages.push(JSON.parse(data.toString()))); });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closers.push(async () => { for (const ws of connections) ws.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { server, connections, messages, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, send(data: unknown) { connections.at(-1)!.send(typeof data === "string" ? data : JSON.stringify(data)); } };
}

describe("Kraken public market data", () => {
  it("needs no credentials, meters both public calls, and uses the actual recent trade timestamp", async () => {
    const fetcher = mockRest();
    const provider = createKrakenProvider(); const meter = new UsageMeter(); provider.setUsageMeter!(meter);
    const [q] = await provider.quotes!(["XBTUSD Curncy"]);
    expect(q).toMatchObject({ security: "XBTUSD Curncy", last: 100, time: T, high: 105, low: 95, volume: 20, bid: 99, ask: 101, bidSize: 0.5, askSize: 0.25, change: null, prevClose: null, open: null, currency: "USD", exchange: "Kraken", source: "Kraken", delayMinutes: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const urls = fetcher.mock.calls.map(([url]) => url);
    expect(urls.every((url) => url.pathname.startsWith("/0/public/") && !url.search.includes("token"))).toBe(true);
    expect(urls.every((url) => url.searchParams.get("pair") === "XBTUSD")).toBe(true);
    expect(urls.find((url) => url.pathname.endsWith("Trades"))!.searchParams.get("count")).toBe("1");
    expect(provider.requiresKey).toBeUndefined();
    expect(meter.usage("kraken").lastMinute).toBe(2);
  });

  it("only covers supported crypto pairs and shares in-flight and cached REST snapshots", async () => {
    const fetcher = mockRest(); const provider = createKrakenProvider();
    const [a, b] = await Promise.all([provider.quotes!(["XBTUSD Curncy"]), provider.quotes!(["XBTUSD Curncy"])]);
    expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(2);
    await provider.quotes!(["XBTUSD Curncy"]); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(provider.covers!("AAPL US Equity")).toBe(false);
    expect(provider.covers!("EURUSD Curncy")).toBe(false);
    expect(provider.covers!("XBTJPY Curncy")).toBe(false);
    expect(provider.covers!("XETEUR Curncy")).toBe(true);
    expect(provider.covers!("XSOGBP Curncy")).toBe(true);
    expect(await provider.quotes!(["AAPL US Equity", "EURUSD Curncy"])).toEqual([]);
  });

  it("never substitutes its local clock or a REST cursor for a missing source timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => Response.json(url.pathname.endsWith("Trades") ? { error: [], result: { "BTC/USD": [], last: "9999999999999999" } } : restTicker)));
    expect(await createKrakenProvider().quotes!(["XBTUSD Curncy"])).toEqual([]);
  });

  it("enforces the HTTP request budget and backs off after an upstream rate rejection", async () => {
    const fetcher = mockRest(); const meter = new UsageMeter(); const provider = createKrakenProvider(); provider.setUsageMeter!(meter);
    for (let i = 0; i < 50; i++) meter.record("kraken", true, 0);
    await expect(provider.quotes!(["XBTUSD Curncy"])).rejects.toThrow(/request limit/);
    expect(fetcher).not.toHaveBeenCalled();
    const limited = vi.fn(async () => new Response("", { status: 429 })); vi.stubGlobal("fetch", limited);
    const backoff = createKrakenProvider();
    await expect(backoff.quotes!(["XBTUSD Curncy"])).rejects.toThrow(/429/);
    const count = limited.mock.calls.length;
    await expect(backoff.quotes!(["XBTUSD Curncy"])).rejects.toThrow(/paused/);
    expect(limited).toHaveBeenCalledTimes(count);
  });

  it("shares a keyless socket for ticker and trades and releases each channel when idle", async () => {
    mockRest(); const upstream = await feed(); const provider = createKrakenProvider({ wsUrl: upstream.url });
    const quotes: Quote[] = []; const trades: Trade[] = [];
    const offQuotes = provider.subscribe!(["XBTUSD Curncy"], (q) => quotes.push(q));
    const offTrades = provider.subscribeTrades!("XBTUSD Curncy", (t) => trades.push(t)); closers.push(offQuotes, offTrades);
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(2));
    expect(upstream.connections).toHaveLength(1);
    expect(upstream.messages).toContainEqual({ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD"], snapshot: true, event_trigger: "trades" } });
    expect(upstream.messages).toContainEqual({ method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false } });
    upstream.send(ticker());
    upstream.send({ channel: "trade", type: "update", data: [{ symbol: "BTC/USD", price: 102, qty: 0.1, side: "buy", timestamp: T1, trade_id: 2 }] });
    await vi.waitFor(() => expect(trades).toHaveLength(1));
    expect(quotes.at(-1)).toMatchObject({ last: 102, prevClose: 100, change: 2, changePct: 2, volume: 25, time: T1 });
    expect(trades[0]).toEqual({ price: 102, time: T1, size: 0.1, side: "buy", venue: "Kraken" });
    offQuotes(); await vi.waitFor(() => expect(upstream.messages).toContainEqual({ method: "unsubscribe", params: { channel: "ticker", symbol: ["BTC/USD"] } }));
    offTrades(); await vi.waitFor(() => expect(upstream.server.clients.size).toBe(0));
  });

  it("rejects malformed ticks and preserves newer live nanoseconds over a late snapshot", async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (url: URL) => url.pathname.endsWith("Trades") ? Response.json(recentTrade) : new Promise<Response>((resolve) => { finish = resolve; })));
    const upstream = await feed(); const provider = createKrakenProvider({ wsUrl: upstream.url }); const quotes: Quote[] = [];
    closers.push(provider.subscribe!(["XBTUSD Curncy"], (q) => quotes.push(q)));
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1));
    upstream.send("not JSON"); upstream.send({ channel: "ticker", data: [null, { symbol: "BTC/USD", last: 0, timestamp: T1 }] });
    const newer = "2026-10-23T18:00:00.000900000Z";
    upstream.send(ticker(newer, 102));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(102));
    finish(Response.json(restTicker));
    await vi.waitFor(() => expect(quotes).toHaveLength(2));
    upstream.send(ticker("2026-10-23T18:00:00.000100000Z", 99));
    await new Promise((resolve) => setImmediate(resolve));
    expect(quotes.at(-1)).toMatchObject({ last: 102, time: newer });
  });

  it("restores public subscriptions after disconnect and cancels reconnection when no listeners remain", async () => {
    mockRest(); const upstream = await feed(); const provider = createKrakenProvider({ wsUrl: upstream.url });
    const off = provider.subscribe!(["XBTUSD Curncy"], () => {}); closers.push(off);
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(1));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    upstream.connections[0].close(); await vi.waitFor(() => expect(upstream.server.clients.size).toBe(0));
    await vi.advanceTimersByTimeAsync(5000); await vi.waitFor(() => expect(upstream.connections).toHaveLength(2));
    await vi.waitFor(() => expect(upstream.messages).toHaveLength(2));
    expect(upstream.messages[1]).toEqual(upstream.messages[0]);
    off(); await vi.waitFor(() => expect(upstream.server.clients.size).toBe(0));
    await vi.advanceTimersByTimeAsync(65_000); expect(upstream.connections).toHaveLength(2);
  });
});
