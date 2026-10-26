import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import type { Quote, Trade } from "../types.js";
import { createFinnhubProvider } from "./finnhub.js";

const cleanup: (() => void | Promise<void>)[] = [];
const TIME = Date.parse("2026-10-26T16:00:20Z");
const snapshot = (time = TIME - 10_000) => ({ c: 100, d: 2, dp: 2.04, h: 101, l: 99, o: 100, pc: 98, t: time / 1000 });
const tradeFrame = (price = 102, time = TIME) => JSON.stringify({ type: "trade", data: [{ s: "AAPL", p: price, t: time, v: 0.5 }] });

afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function liveFixture() {
  const wss = new WebSocketServer({ port: 0 });
  const sockets: ServerSocket[] = [];
  const received: unknown[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => received.push(JSON.parse(data.toString())));
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const provider = createFinnhubProvider("local-test", {
    wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    reconnectMs: 30,
  });
  return {
    provider, sockets, received,
    watchQuotes: (listener: (q: Quote) => void) => {
      const off = provider.subscribe!(["AAPL US Equity"], listener);
      cleanup.push(off);
      return off;
    },
    watchTrades: (listener: (t: Trade) => void) => {
      const off = provider.subscribeTrades!("AAPL US Equity", listener);
      cleanup.push(off);
      return off;
    },
  };
}

describe("Finnhub native feed", () => {
  it("ignores malformed frames and delivers truthful live quotes before a snapshot is available", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await liveFixture();
    const quotes: Quote[] = [];
    const trades: Trade[] = [];
    const offQuotes = f.watchQuotes((q) => quotes.push(q));
    const offTrades = f.watchTrades((t) => trades.push(t));
    await vi.waitFor(() => expect(f.received).toContainEqual({ type: "subscribe", symbol: "AAPL" }));
    const socket = f.sockets[0];
    for (const malformed of ["{", "null", "42", JSON.stringify({ type: "trade", data: {} }), JSON.stringify({ type: "trade", data: [
      null, {}, { s: "AAPL", p: -1, t: TIME }, { s: "AAPL", p: 1, t: "bad" },
      { s: "AAPL", p: 0, t: TIME }, { s: "AAPL", p: 1, t: 1e100 },
    ] })]) socket.send(malformed);
    socket.send(tradeFrame());
    await vi.waitFor(() => expect(quotes).toHaveLength(1));
    expect(quotes[0]).toMatchObject({ security: "AAPL US Equity", source: "Finnhub", last: 102, time: new Date(TIME).toISOString(),
      open: null, high: null, low: null, prevClose: null, change: null, changePct: null, volume: null, bid: null, ask: null });
    expect(trades).toEqual([{ time: new Date(TIME).toISOString(), price: 102, size: 0.5, side: null, venue: null }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(f.sockets).toHaveLength(1);

    offQuotes();
    socket.send(tradeFrame(103, TIME + 1000));
    await vi.waitFor(() => expect(trades).toHaveLength(2));
    expect(quotes).toHaveLength(1);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    offTrades();
    await closed;
  });

  it("enriches a live trade with a late snapshot without replacing its newer price or timestamp", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const f = await liveFixture();
    const quotes: Quote[] = [];
    f.watchQuotes((q) => quotes.push(q));
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.sockets[0].send(tradeFrame());
    await vi.waitFor(() => expect(quotes).toHaveLength(1));
    resolve(Response.json(snapshot()));
    await vi.waitFor(() => expect(quotes).toHaveLength(2));
    expect(quotes.at(-1)).toMatchObject({ last: 102, time: new Date(TIME).toISOString(), prevClose: 98, change: 4, open: 100, high: 102, low: 99, volume: null });
    f.sockets[0].send(tradeFrame(99, TIME - 1000));
    f.sockets[0].send(tradeFrame(103, TIME + 1000));
    await vi.waitFor(() => expect(quotes).toHaveLength(3));
    expect(quotes.at(-1)).toMatchObject({ last: 103, high: 103, low: 99 });
  });

  it("does not use a previous trading day's snapshot to invent today's session fields", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const f = await liveFixture();
    const quotes: Quote[] = [];
    f.watchQuotes((q) => quotes.push(q));
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.sockets[0].send(tradeFrame());
    await vi.waitFor(() => expect(quotes).toHaveLength(1));
    resolve(Response.json(snapshot(TIME - 3 * 86_400_000)));
    await vi.waitFor(() => expect(quotes).toHaveLength(2));
    expect(quotes.at(-1)).toMatchObject({ last: 102, time: new Date(TIME).toISOString(), prevClose: null, change: null, open: null, high: null, low: null });
  });

  it("cancels pending reconnects when idle and opens a fresh socket for a later subscription", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot())));
    const f = await liveFixture();
    const off = f.watchQuotes(() => {});
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    const closed = new Promise<void>((resolve) => f.sockets[0].once("close", () => resolve()));
    f.sockets[0].close();
    await closed;
    off();
    off();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.sockets).toHaveLength(1);
    f.watchQuotes(() => {});
    await vi.waitFor(() => expect(f.sockets).toHaveLength(2));
    await vi.waitFor(() => expect(f.received.filter((v) => (v as { type: string }).type === "subscribe")).toHaveLength(2));
  });

  it("refreshes session fields once when a live subscription crosses to the next trading day", async () => {
    const tomorrow = TIME + 86_400_000;
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(snapshot(TIME)))
      .mockResolvedValueOnce(Response.json({ ...snapshot(tomorrow - 10_000), pc: 100, h: 104, l: 101, o: 101 }));
    vi.stubGlobal("fetch", fetch);
    const f = await liveFixture();
    const quotes: Quote[] = [];
    f.watchQuotes((q) => quotes.push(q));
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    await vi.waitFor(() => expect(quotes).toHaveLength(1));
    f.sockets[0].send(tradeFrame(105, tomorrow));
    await vi.waitFor(() => expect(quotes).toHaveLength(3));
    expect(quotes[1]).toMatchObject({ last: 105, prevClose: null, high: null, low: null });
    expect(quotes[2]).toMatchObject({ last: 105, prevClose: 100, change: 5, open: 101, high: 105, low: 101 });
    f.sockets[0].send(tradeFrame(106, tomorrow + 1000));
    await vi.waitFor(() => expect(quotes).toHaveLength(4));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts pending snapshots and ignores their results after unsubscribe", async () => {
    let resolve!: (response: Response) => void;
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url: URL, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((done) => { resolve = done; });
    }));
    const f = await liveFixture();
    const quotes = vi.fn();
    const off = f.watchQuotes(quotes);
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    off();
    expect(signal.aborted).toBe(true);
    resolve(Response.json(snapshot()));
    await new Promise((done) => setImmediate(done));
    expect(quotes).not.toHaveBeenCalled();
    await new Promise((done) => setTimeout(done, 60));
    expect(f.sockets).toHaveLength(1);
  });
});
