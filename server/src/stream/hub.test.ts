import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ProviderPlugin } from "../providers/DataProvider.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import type { Quote } from "../types.js";
import { StreamHub, type QuoteSource, type StreamClient } from "./hub.js";
import { attachWebSocket } from "./ws.js";

let price = 100;
const quote = (security: string, last = price): Quote => ({
  security,
  name: security,
  last,
  change: 0,
  changePct: 0,
  bid: null,
  ask: null,
  bidSize: null,
  askSize: null,
  open: null,
  high: null,
  low: null,
  prevClose: null,
  volume: null,
  currency: null,
  exchange: null,
  marketState: null,
  time: null,
  delayMinutes: null,
  source: "fake",
});

function fakeSource(pusher: ProviderPlugin | null = null) {
  const calls: string[][] = [];
  const source: QuoteSource = {
    quotes: async (secs) => {
      calls.push(secs);
      return secs.map((s) => quote(s));
    },
    streamingPlugin: (s) => (pusher && s.endsWith("Equity") ? pusher : null),
  };
  return { source, calls };
}

function fakeClient() {
  const received: { type: string; quote?: Quote }[] = [];
  const client: StreamClient = { send: (d) => received.push(JSON.parse(d)) };
  return { client, received };
}

const sub = (securities: string[]) => JSON.stringify({ op: "sub", securities });
const unsub = (securities: string[]) => JSON.stringify({ op: "unsub", securities });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  price = 100;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamHub", () => {
  it("replays a synchronous native snapshot once and removes departing recipients", () => {
    let push!: (q: Quote) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"], subscribe: (_securities, onQuote) => {
        push = onQuote;
        onQuote(quote("AAPL US Equity", 100));
        return () => {};
      },
    });
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    const b = fakeClient();
    const idle = fakeClient();
    for (const c of [a, b, idle]) hub.connect(c.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    expect(a.received.map((m) => m.quote?.last)).toEqual([100]);
    hub.handleMessage(b.client, sub(["AAPL US Equity"]));
    expect(b.received.map((m) => m.quote?.last)).toEqual([100]);
    push(quote("AAPL US Equity", 101));
    expect(a.received.map((m) => m.quote?.last)).toEqual([100, 101]);
    expect(b.received.map((m) => m.quote?.last)).toEqual([100, 101]);
    hub.handleMessage(a.client, unsub(["AAPL US Equity"]));
    push(quote("AAPL US Equity", 102));
    expect(a.received).toHaveLength(2);
    expect(b.received.at(-1)?.quote?.last).toBe(102);
    expect(idle.received).toHaveLength(0);
    hub.disconnect(b.client);
    push(quote("AAPL US Equity", 103));
    expect(b.received).toHaveLength(3);
    hub.close();
  });

  it("reference-counts subscriptions across clients", () => {
    const { source } = fakeSource();
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    const b = fakeClient();
    hub.connect(a.client);
    hub.connect(b.client);
    hub.handleMessage(a.client, sub(["SPX Index", "AAPL US Equity"]));
    hub.handleMessage(b.client, sub(["spx index"]));
    expect(hub.subscriberCount("SPX Index")).toBe(2);
    expect(hub.subscriberCount("AAPL US Equity")).toBe(1);

    hub.handleMessage(a.client, sub(["SPX Index"]));
    expect(hub.subscriberCount("SPX Index")).toBe(2);

    hub.handleMessage(a.client, unsub(["SPX Index"]));
    expect(hub.subscriberCount("SPX Index")).toBe(1);
    hub.disconnect(b.client);
    expect(hub.subscriberCount("SPX Index")).toBe(0);
    hub.disconnect(a.client);
    expect(hub.stats()).toEqual({ clients: 0, securities: 0 });
    hub.close();
  });

  it("fetches each distinct security once per tick and sends only changes", async () => {
    const { source, calls } = fakeSource();
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    const b = fakeClient();
    hub.connect(a.client);
    hub.connect(b.client);
    hub.handleMessage(a.client, sub(["SPX Index"]));
    await flush();
    hub.handleMessage(b.client, sub(["SPX Index"]));
    expect(b.received).toHaveLength(1);
    expect(calls).toEqual([["SPX Index"]]);

    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(2);
    expect(a.received).toHaveLength(1);

    price = 101;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(a.received.map((m) => m.quote?.last)).toEqual([100, 101]);
    expect(b.received.map((m) => m.quote?.last)).toEqual([100, 101]);
    hub.close();
  });

  it("stops polling when the last subscriber leaves", async () => {
    const { source, calls } = fakeSource();
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["SPX Index"]));
    await flush();
    hub.disconnect(a.client);
    vi.advanceTimersByTime(5000);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("uses native push instead of polling when available", async () => {
    let push: ((q: Quote) => void) | null = null;
    const unsubscribe = vi.fn();
    const pusher: ProviderPlugin = {
      id: "push",
      sectors: ["Equity"],
      subscribe: (_secs, on) => {
        push = on;
        return unsubscribe;
      },
    };
    const { source, calls } = fakeSource(pusher);
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    vi.advanceTimersByTime(3000);
    await flush();
    expect(calls).toEqual([]);
    push!(quote("AAPL US Equity", 250));
    expect(a.received[0].quote?.last).toBe(250);
    hub.disconnect(a.client);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("polls silent native feeds and stops the fallback when native updates resume", async () => {
    let now = 0;
    let push!: (q: Quote) => void;
    const unsubscribe = vi.fn();
    const { source, calls } = fakeSource({
      id: "push", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { push = onQuote; return unsubscribe; },
    });
    const hub = new StreamHub(source, 1000, () => {}, { now: () => now });
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    now = 14_999;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(0);
    now = 15_000;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toEqual([["AAPL US Equity"]]);
    expect(a.received.at(-1)?.quote?.last).toBe(100);

    now = 16_000;
    price = 101;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(2);
    push(quote("AAPL US Equity", 102));
    now = 30_999;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(2);
    now = 31_000;
    vi.advanceTimersByTime(1000);
    await flush();
    expect(calls).toHaveLength(3);
    hub.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("falls back to polling after synchronous native subscription errors", async () => {
    let leakedPush!: (q: Quote) => void;
    const { source, calls } = fakeSource({
      id: "broken", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { leakedPush = onQuote; throw new Error("subscription refused"); },
    });
    const log = vi.fn();
    const hub = new StreamHub(source, 1000, log);
    const a = fakeClient();
    hub.connect(a.client);
    expect(() => hub.handleMessage(a.client, sub(["AAPL US Equity"]))).not.toThrow();
    await flush();
    expect(calls).toEqual([["AAPL US Equity"]]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("subscription refused"));
    expect(a.received.at(-1)?.quote?.last).toBe(100);
    leakedPush(quote("AAPL US Equity", 999));
    expect(a.received.at(-1)?.quote?.last).toBe(100);
    hub.close();
  });

  it("keeps newer native quotes when a slow fallback resolves and avoids overlapping requests", async () => {
    let now = 0;
    let push!: (q: Quote) => void;
    let resolve!: (quotes: Quote[]) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
    });
    const fetch = vi.fn(() => new Promise<Quote[]>((done) => { resolve = done; }));
    source.quotes = fetch;
    const hub = new StreamHub(source, 1000, () => {}, { now: () => now });
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    push({ ...quote("AAPL US Equity", 100), time: "2026-10-26T12:00:00Z" });
    now = 15_000;
    const pending = hub.poll();
    await hub.poll();
    expect(fetch).toHaveBeenCalledTimes(1);
    push({ ...quote("AAPL US Equity", 102), time: "2026-10-26T12:00:02Z" });
    resolve([{ ...quote("AAPL US Equity", 101), time: "2026-10-26T12:00:01Z" }]);
    await pending;
    expect(a.received.map((m) => m.quote?.last)).toEqual([100, 102]);

    now = 30_000;
    const later = hub.poll();
    resolve([{ ...quote("AAPL US Equity", 103), time: "2026-10-26T12:00:03Z" }]);
    await later;
    expect(a.received.at(-1)?.quote?.last).toBe(103);
    hub.close();
  });

  it("preserves native updates over in-flight snapshots without comparable timestamps", async () => {
    let now = 0;
    let push!: (q: Quote) => void;
    let resolve!: (quotes: Quote[]) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
    });
    source.quotes = () => new Promise<Quote[]>((done) => { resolve = done; });
    const hub = new StreamHub(source, 1000, () => {}, { now: () => now });
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    now = 15_000;
    const pending = hub.poll();
    push(quote("AAPL US Equity", 102));
    resolve([quote("AAPL US Equity", 101)]);
    await pending;
    expect(a.received.map((m) => m.quote?.last)).toEqual([102]);
    hub.close();
  });

  it("publishes provider and delay changes even when the market timestamp and price match", () => {
    let push!: (q: Quote) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
    });
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    const snapshot = { ...quote("AAPL US Equity"), time: "2026-10-26T12:00:00Z" };
    push({ ...snapshot, source: "Direct venue", delayMinutes: 0 });
    push({ ...snapshot, source: "Backup", delayMinutes: 0 });
    push({ ...snapshot, source: "Backup", delayMinutes: 15 });
    expect(a.received.map((m) => [m.quote?.source, m.quote?.delayMinutes])).toEqual([
      ["Direct venue", 0], ["Backup", 0], ["Backup", 15],
    ]);
    // An older market event must not rewind the screen even when it arrives on push.
    push({ ...snapshot, last: 99, time: "2026-10-26T11:59:59Z" });
    push({ ...snapshot, last: 98, time: null });
    expect(a.received).toHaveLength(3);
    hub.close();
  });

  it("orders distinct exchange events within the same millisecond", () => {
    let push!: (q: Quote) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"], subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
    });
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    push({ ...quote("AAPL US Equity", 102), time: "2026-10-26T12:00:00.123999999Z" });
    push({ ...quote("AAPL US Equity", 100), time: "2026-10-26T12:00:00.123000001Z" });
    expect(a.received.map((m) => m.quote?.last)).toEqual([102]);
    hub.close();
  });

  it("publishes session/reference updates without requiring a price change", () => {
    let push!: (q: Quote) => void;
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"], subscribe: (_securities, onQuote) => { push = onQuote; return () => {}; },
    });
    const hub = new StreamHub(source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    const base = { ...quote("AAPL US Equity", 100), time: "2026-10-26T12:00:00Z" };
    push(base);
    push({ ...base, priceSession: "pre", regularClose: 99 });
    expect(a.received).toHaveLength(2);
    expect(a.received[1].quote).toMatchObject({ last: 100, priceSession: "pre", regularClose: 99 });
    hub.close();
  });

  it("discards old subscription results and callbacks after unsubscribe or shutdown", async () => {
    let now = 0;
    const callbacks: ((q: Quote) => void)[] = [];
    let resolve!: (quotes: Quote[]) => void;
    const unsubscribe = vi.fn();
    const { source } = fakeSource({
      id: "push", sectors: ["Equity"],
      subscribe: (_securities, onQuote) => { callbacks.push(onQuote); return unsubscribe; },
    });
    const fetch = vi.fn(() => new Promise<Quote[]>((done) => { resolve = done; }));
    source.quotes = fetch;
    const hub = new StreamHub(source, 1000, () => {}, { now: () => now });
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    now = 15_000;
    const first = hub.poll();
    hub.handleMessage(a.client, unsub(["AAPL US Equity"]));
    hub.handleMessage(a.client, sub(["AAPL US Equity"]));
    callbacks[0](quote("AAPL US Equity", 999));
    resolve([quote("AAPL US Equity", 999)]);
    await first;
    expect(a.received).toHaveLength(0);
    callbacks[1](quote("AAPL US Equity", 101));
    expect(a.received.at(-1)?.quote?.last).toBe(101);

    now = 30_000;
    const second = hub.poll();
    hub.close();
    resolve([quote("AAPL US Equity", 999)]);
    await second;
    callbacks[1](quote("AAPL US Equity", 999));
    expect(a.received).toHaveLength(1);
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await hub.poll();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed messages", () => {
    const hub = new StreamHub(fakeSource().source, 1000, () => {});
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, "not json");
    hub.handleMessage(a.client, JSON.stringify({ op: "sub", securities: "SPX Index" }));
    hub.handleMessage(a.client, JSON.stringify({ op: "delete", securities: [] }));
    expect(a.received.map((m) => m.type)).toEqual(["error", "error", "error"]);
    expect(hub.stats().securities).toBe(0);
  });

  it("keeps running when a poll fails", async () => {
    const log = vi.fn();
    const hub = new StreamHub(
      { quotes: () => Promise.reject(new Error("down")), streamingPlugin: () => null },
      1000,
      log,
    );
    const a = fakeClient();
    hub.connect(a.client);
    hub.handleMessage(a.client, sub(["SPX Index"]));
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("down"));
    hub.close();
  });
});

describe("WebSocket transport", () => {
  it("advertises only the supported public direct-feed capability", async () => {
    vi.useRealTimers();
    const hub = new StreamHub(fakeSource().source, 500, () => {});
    const server = createServer();
    const wss = attachWebSocket(server, hub, { directKraken: true });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    try {
      const first = await new Promise<unknown>((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
      expect(first).toEqual({ type: "stream.config", directKraken: true });
      expect(hub.stats()).toEqual({ clients: 1, securities: 0 });
    } finally {
      ws.close();
      await new Promise((resolve) => ws.once("close", resolve));
      wss.close();
      hub.close();
      server.close();
    }
  });

  it("streams quotes over /ws", async () => {
    vi.useRealTimers();
    const router = new ProviderRouter([createMockProvider()], () => {});
    const hub = new StreamHub(router, 500, () => {});
    const server = createServer();
    const wss = attachWebSocket(server, hub);
    await new Promise<void>((r) => server.listen(0, r));
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`);
    const messages: { type: string; quote?: Quote }[] = [];
    ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
    await new Promise((r) => ws.once("open", r));
    ws.send(sub(["SPX Index"]));
    await vi.waitFor(() => expect(messages.some((m) => m.quote!.last !== messages[0].quote!.last)).toBe(true), { timeout: 6000, interval: 50 });
    expect(messages[0]).toMatchObject({ type: "quote", quote: { security: "SPX Index", source: "Mock" } });
    ws.close();
    await vi.waitFor(() => expect(hub.stats().clients).toBe(0));
    wss.close();
    hub.close();
    server.close();
  });
});
