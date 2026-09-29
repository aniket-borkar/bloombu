import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { cryptoPair } from "../symbology.js";
import type { Quote, Trade } from "../types.js";
import { createCoinbaseProvider, matchToTrade } from "./coinbase.js";
import { createMockProvider } from "./mock.js";
import { ProviderRouter } from "./router.js";

afterEach(() => vi.unstubAllGlobals());

describe("cryptoPair", () => {
  it("maps Bloomberg crypto tickers to exchange products", () => {
    expect(cryptoPair("XBTUSD Curncy")).toBe("BTC-USD");
    expect(cryptoPair("XET Curncy")).toBe("ETH-USD");
    expect(cryptoPair("XBTEUR Curncy")).toBe("BTC-EUR");
    expect(cryptoPair("EURUSD Curncy")).toBeNull();
    expect(cryptoPair("AAPL US Equity")).toBeNull();
  });
});

describe("coinbase provider", () => {
  it("builds 24-hour quotes from the REST ticker and stats", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("/ticker")
          ? Response.json({ price: "84000", bid: "83999", ask: "84001", volume: "2500.5", time: "2026-09-27T18:00:00Z" })
          : Response.json({ open: "80000", high: "85000", low: "79000", last: "84000", volume: "2500.5" }),
      ),
    );
    const [q] = await createCoinbaseProvider().quotes!(["XBTUSD Curncy"]);
    expect(q).toMatchObject({ security: "XBTUSD Curncy", name: "Bitcoin USD", last: 84000, change: 4000, changePct: 5, prevClose: 80000, currency: "USD", delayMinutes: 0 });
  });

  it("pages candles and leaves weekly bars and over-long ranges to other providers", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        const start = Date.parse(new URL(url).searchParams.get("start")!) / 1000;
        return Response.json([
          [start + 86400, 1, 3, 2, 2.5, 10],
          [start, 1, 3, 2, 2.2, 9],
        ]);
      }),
    );
    const p = createCoinbaseProvider();
    const to = new Date("2026-09-27T00:00:00Z");
    const bars = await p.history!("XBTUSD Curncy", "1d", new Date(to.getTime() - 400 * 86_400_000), to);
    expect(calls).toHaveLength(2);
    expect(bars.map((b) => b.t)).toEqual([...bars.map((b) => b.t)].sort((a, b) => a - b));
    expect(bars[0]).toMatchObject({ o: 2, h: 3, l: 1, c: 2.2, v: 9 });
    expect(await p.history!("XBTUSD Curncy", "1wk", new Date(0), to)).toEqual([]);
    expect(await p.history!("XBTUSD Curncy", "1m", new Date(to.getTime() - 30 * 86_400_000), to)).toEqual([]);
  });

  it("streams quotes and trades over one socket and unsubscribes when idle", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const wss = new WebSocketServer({ port: 0 });
    const received: unknown[] = [];
    let server: ServerSocket | null = null;
    wss.on("connection", (ws) => {
      server = ws;
      ws.on("message", (d) => received.push(JSON.parse(d.toString())));
    });
    await new Promise((r) => wss.once("listening", r));
    const p = createCoinbaseProvider({ wsUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` });
    const quotes: Quote[] = [];
    const trades: Trade[] = [];
    const offQuotes = p.subscribe!(["XBTUSD Curncy"], (q) => quotes.push(q));
    const offTrades = p.subscribeTrades!("XBTUSD Curncy", (t) => trades.push(t));
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    expect(received[0]).toEqual({
      type: "subscribe",
      channels: [
        { name: "ticker", product_ids: ["BTC-USD"] },
        { name: "matches", product_ids: ["BTC-USD"] },
      ],
    });
    server!.send(
      JSON.stringify({
        type: "ticker",
        product_id: "BTC-USD",
        price: "84100",
        open_24h: "84000",
        volume_24h: "10",
        low_24h: "83000",
        high_24h: "85000",
        best_bid: "84099",
        best_bid_size: "0.5",
        best_ask: "84101",
        best_ask_size: "0.25",
        time: "2026-09-27T18:00:01Z",
      }),
    );
    server!.send(JSON.stringify({ type: "match", product_id: "BTC-USD", price: "84100", size: "0.01", side: "sell", time: "2026-09-27T18:00:01Z" }));
    await vi.waitFor(() => expect(trades).toHaveLength(1));
    expect(quotes.at(-1)).toMatchObject({ last: 84100, change: 100, bidSize: 0.5, askSize: 0.25 });
    expect(trades[0]).toEqual({ time: "2026-09-27T18:00:01Z", price: 84100, size: 0.01, side: "buy", venue: "Coinbase" });
    offTrades();
    await vi.waitFor(() => expect(received).toContainEqual({ type: "unsubscribe", channels: [{ name: "matches", product_ids: ["BTC-USD"] }] }));
    offQuotes();
    await new Promise((r) => wss.close(r));
  });

  it("only claims crypto, so fiat pairs still route to the next provider", async () => {
    const router = new ProviderRouter([createCoinbaseProvider(), createMockProvider()], () => {});
    expect(router.streamingPlugin("XBTUSD Curncy")?.id).toBe("coinbase");
    expect(router.streamingPlugin("EURUSD Curncy")).toBeNull();
    expect(router.tradesPlugin("EURUSD Curncy")?.id).toBe("mock");
    expect(matchToTrade({ type: "match", product_id: "BTC-USD", price: "1", size: "2", side: "buy", time: "t" }).side).toBe("sell");
  });
});
