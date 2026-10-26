import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import type { Quote } from "../types.js";
import { createYahooQuoteStream, decodeYahooPricingMessage } from "./yahooStream.js";

const T = Date.parse("2026-10-26T22:00:00Z");
const closers: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const stop of closers.splice(0).reverse()) await stop(); vi.restoreAllMocks(); });
function varint(input: bigint | number): Buffer {
  let value = BigInt(input); const out: number[] = [];
  do { const b = Number(value & 127n); value >>= 7n; out.push(b | (value ? 128 : 0)); } while (value);
  return Buffer.from(out);
}
function string(field: number, value: string): Buffer { const bytes = Buffer.from(value); return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes]); }
function float(field: number, value: number): Buffer { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return Buffer.concat([varint(field * 8 + 5), bytes]); }
function integer(field: number, value: number, signed = true): Buffer {
  const number = BigInt(value); return Buffer.concat([varint(field * 8), varint(signed ? (number << 1n) ^ (number >> 63n) : number)]);
}
function pricing(id = "AAPL", price = 101, at = T, hours = 2, extra: Buffer[] = []): string {
  return Buffer.concat([string(1, id), float(2, price), integer(3, at), integer(7, hours, false), ...extra]).toString("base64");
}
async function feed() {
  const server = new WebSocketServer({ port: 0 }); const connections: WebSocket[] = []; const messages: unknown[] = [];
  server.on("connection", (ws) => { connections.push(ws); ws.on("message", (raw) => messages.push(JSON.parse(raw.toString()))); });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  closers.push(async () => { for (const ws of connections) ws.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { server, connections, messages, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    send(encoded: string) { connections.at(-1)!.send(JSON.stringify({ message: encoded })); } };
}
function seed(time = T - 1000, last = 99): Quote {
  return { security: "AAPL US Equity", name: "Apple Inc.", last, time: new Date(time).toISOString(), change: last - 98,
    changePct: (last - 98) / 98 * 100, prevClose: 98, regularClose: 100, priceSession: "post", marketState: "POST",
    bid: 98, ask: 100, bidSize: 1, askSize: 2, open: 98, high: 103, low: 97, volume: 1000,
    currency: "USD", exchange: "Nasdaq", source: "Yahoo Finance", delayMinutes: 0 };
}

describe("Yahoo pricing wire decoder", () => {
  it("decodes signed time and negative moves while retaining explicit zero values", () => {
    const parsed = decodeYahooPricingMessage(pricing("EURUSD=X", 1.12, T, 1, [float(12, -0.0005), float(8, 0), integer(9, 0)]));
    expect(parsed).toMatchObject({ id: "EURUSD=X", time: new Date(T).toISOString(), marketHours: 1, changePct: 0, volume: 0 });
    expect(parsed!.change).toBeCloseTo(-0.0005);
    expect(parsed!.last).toBeCloseTo(1.12);
    expect(decodeYahooPricingMessage(pricing("AAPL", 101, -1))).toBeNull();
  });

  it("rejects malformed payloads without unbounded reads or invalid prices", () => {
    for (const frame of ["%bad", "A".repeat(30_000), Buffer.from([0x0a, 0xff, 0xff]).toString("base64"), Buffer.from([0x18, ...Array(11).fill(0x80)]).toString("base64"), pricing("AAPL", NaN), pricing("AAPL", 0)]) {
      expect(decodeYahooPricingMessage(frame)).toBeNull();
    }
    expect(decodeYahooPricingMessage(pricing("AAPL", 101, T, 1, [string(99, "unknown field")]))?.last).toBe(101);
    expect(decodeYahooPricingMessage(Buffer.concat([string(1, "AAPL"), float(2, 101), integer(3, T)]).toString("base64"))?.marketHours).toBe(0);
  });
});

describe("Yahoo public quote stream", () => {
  it("shares one socket and delivers actual FX ticks without any REST seed", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url });
    const quotes: Quote[] = []; const second: Quote[] = [];
    const offA = stream.subscribe(["EURUSD Curncy"], (q) => quotes.push(q)); closers.push(offA);
    const offB = stream.subscribe(["EURUSD Curncy"], (q) => second.push(q)); closers.push(offB);
    await vi.waitFor(() => expect(upstream.messages).toContainEqual({ subscribe: ["EURUSD=X"] }));
    expect(upstream.connections).toHaveLength(1);
    upstream.send(pricing("EURUSD=X", 1.12, T, 1, [float(12, -0.0005)]));
    upstream.send(pricing("EURUSD=X", 1.13, T + 1000, 1, [float(12, 0)]));
    await vi.waitFor(() => expect(quotes).toHaveLength(2));
    expect(quotes[1]).toMatchObject({ security: "EURUSD Curncy", time: new Date(T + 1000).toISOString(), priceSession: "regular", change: 0, source: "Yahoo Finance", delayMinutes: null });
    expect(quotes[1].last).toBeCloseTo(1.13);
    expect(second).toHaveLength(2);
    offA();
    expect(upstream.messages.filter((m: any) => m.unsubscribe)).toHaveLength(0);
    offB(); offB();
    await vi.waitFor(() => expect(upstream.server.clients.size).toBe(0));
  });

  it("keeps a trusted post-market day reference when the wire move is relative to regular close", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url });
    stream.seed([seed()]); const quotes: Quote[] = [];
    closers.push(stream.subscribe(["AAPL US Equity"], (q) => quotes.push(q)));
    await vi.waitFor(() => expect(upstream.messages.length).toBeGreaterThan(0));
    upstream.send(pricing("AAPL", 101, T, 2, [float(12, 1)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(101));
    expect(quotes.at(-1)).toMatchObject({ prevClose: 98, regularClose: 100, change: 3, priceSession: "post", marketState: "POST" });
    upstream.send(pricing("AAPL", 102, T + 1000, 2, [float(12, 3), float(16, 100), float(10, 999), float(11, 1), float(15, 500), integer(9, 9999)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(102));
    expect(quotes.at(-1)).toMatchObject({ prevClose: 98, regularClose: 100, change: 4, open: 98, high: 103, low: 97, volume: 1000 });
  });

  it("enriches an earlier native tick safely and does not let older or tied REST prices rewind it", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url }); const quotes: Quote[] = [];
    closers.push(stream.subscribe(["AAPL US Equity"], (q) => quotes.push(q)));
    await vi.waitFor(() => expect(upstream.messages.length).toBeGreaterThan(0));
    upstream.send(pricing("AAPL", 101, T, 2, [float(12, 1)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(101));
    expect(quotes.at(-1)?.prevClose).toBeNull();
    expect(quotes.at(-1)?.regularClose).toBeNull();
    stream.seed([{ ...seed(), priceSession: "regular", marketState: "REGULAR" }]);
    expect(quotes.at(-1)?.regularClose).toBeNull();
    stream.seed([seed()]);
    expect(quotes.at(-1)).toMatchObject({ last: 101, time: new Date(T).toISOString(), name: "Apple Inc.", regularClose: 100, prevClose: 98, change: 3 });
    stream.seed([seed(T, 99)]);
    expect(quotes.at(-1)?.last).toBe(101);
    upstream.connections[0].send("{"); upstream.send("malformed");
    upstream.send(pricing("AAPL", 90, T - 1000, 1, [float(12, -8)]));
    upstream.send(pricing("AAPL", 102, T + 1000, 2, [float(12, 2)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(102));
    expect(quotes.at(-1)?.change).toBe(4);
  });

  it("keeps the same New York post session across UTC midnight and clears an unknown next-day reference", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url }); const quotes: Quote[] = [];
    stream.seed([seed(Date.parse("2026-10-26T23:59:59Z"))]);
    closers.push(stream.subscribe(["AAPL US Equity"], (q) => quotes.push(q)));
    await vi.waitFor(() => expect(upstream.messages.length).toBeGreaterThan(0));
    upstream.send(pricing("AAPL", 101, Date.parse("2026-10-27T00:00:01Z"), 2, [float(12, 1)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(101));
    expect(quotes.at(-1)).toMatchObject({ prevClose: 98, regularClose: 100, change: 3 });
    upstream.send(pricing("AAPL", 102, Date.parse("2026-10-27T13:30:01Z"), 3));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(102));
    expect(quotes.at(-1)).toMatchObject({ prevClose: null, regularClose: null, change: null });
    expect(quotes.at(-1)?.priceSession).toBeUndefined();
  });

  it("clears an unavailable reference across session changes and explicit zero book prices", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url }); const quotes: Quote[] = [];
    stream.seed([{ ...seed(T - 1000), priceSession: "pre", marketState: "PRE", prevClose: 100 }]);
    closers.push(stream.subscribe(["AAPL US Equity"], (q) => quotes.push(q)));
    await vi.waitFor(() => expect(upstream.messages.length).toBeGreaterThan(0));
    upstream.send(pricing("AAPL", 101, T, 1, [float(23, 0), float(25, 0)]));
    await vi.waitFor(() => expect(quotes.at(-1)?.last).toBe(101));
    expect(quotes.at(-1)).toMatchObject({ priceSession: "regular", prevClose: null, change: null, bid: null, ask: null });
  });

  it("reconnects after a transport closure and stops when the last watcher leaves", async () => {
    const upstream = await feed(); const stream = createYahooQuoteStream({ wsUrl: upstream.url });
    const off = stream.subscribe(["EURUSD Curncy"], () => {}); closers.push(off);
    await vi.waitFor(() => expect(upstream.messages.length).toBeGreaterThan(0));
    upstream.connections[0].close();
    await vi.waitFor(() => expect(upstream.connections).toHaveLength(2), { timeout: 2500 });
    await vi.waitFor(() => expect(upstream.messages.filter((m: any) => m.subscribe)).toHaveLength(2));
    upstream.connections[1].close();
    await vi.waitFor(() => expect(upstream.server.clients.size).toBe(0));
    off(); off();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(upstream.connections).toHaveLength(2);
  });
});
