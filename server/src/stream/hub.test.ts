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
