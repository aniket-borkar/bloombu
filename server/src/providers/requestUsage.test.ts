import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoinbaseProvider } from "./coinbase.js";
import { createFinnhubProvider } from "./finnhub.js";
import { createMockProvider } from "./mock.js";
import { ProviderRouter } from "./router.js";
import { UsageMeter } from "./usage.js";
import type { Quote } from "../types.js";

// These tests exercise REST accounting on subscription snapshots; the socket
// transport is deliberately inert so no provider connection is opened.
vi.mock("ws", () => ({ default: class {
  static OPEN = 1;
  readyState = 0;
  on() { return this; }
  send() {}
  close() {}
} }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("outgoing provider request budgets", () => {
  it("limits Finnhub batch fanout and keeps successful symbols before falling back", async () => {
    const fetch = vi.fn(async () => Response.json({ c: 100, d: 0, dp: 0, h: 100, l: 100, o: 100, pc: 100, t: 1 }));
    vi.stubGlobal("fetch", fetch);
    const fallback = createMockProvider();
    fallback.quotes = async (securities) => securities.map((security) => ({ security, last: 100, source: "Mock" }) as Quote);
    const router = new ProviderRouter([createFinnhubProvider("test"), fallback], () => {});
    const securities = Array.from({ length: 60 }, (_, i) => `A${i} US Equity`);
    const quotes = await router.quotes(securities);
    expect(fetch).toHaveBeenCalledTimes(55);
    expect(quotes).toHaveLength(60);
    expect(quotes.slice(0, 55).every((q) => q.source === "Finnhub")).toBe(true);
    expect(quotes.slice(55).every((q) => q.source === "Mock")).toBe(true);
    expect(router.usage()[0]).toMatchObject({ lastMinute: 55, throttled: 5, errors24h: 0 });
  });

  it("shares Finnhub's budget between native snapshots and routed requests", async () => {
    const fetch = vi.fn(async () => Response.json({ c: 100, d: 0, dp: 0, h: 100, l: 100, o: 100, pc: 100, t: 1 }));
    vi.stubGlobal("fetch", fetch);
    const meter = new UsageMeter();
    for (let i = 0; i < 54; i++) meter.record("finnhub", true, 0);
    const provider = createFinnhubProvider("test");
    const router = new ProviderRouter([provider, createMockProvider()], () => {}, meter);
    const snapshot = vi.fn();
    const off = provider.subscribe!(["AAPL US Equity"], snapshot);
    try {
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
      expect((await router.quote("MSFT US Equity"))?.source).toBe("Mock");
      expect(fetch).toHaveBeenCalledOnce();
      expect(router.usage()[0]).toMatchObject({ lastMinute: 55, throttled: 1 });
    } finally { off(); }
  });

  it("recovers native Finnhub snapshots after the exhausted request budget replenishes", async () => {
    vi.useFakeTimers();
    let now = 0;
    const meter = new UsageMeter(() => now);
    for (let i = 0; i < 55; i++) meter.record("finnhub", true, 0);
    const fetch = vi.fn(async () => Response.json({ c: 100, d: 0, dp: 0, h: 100, l: 100, o: 100, pc: 100, t: 1 }));
    vi.stubGlobal("fetch", fetch);
    const provider = createFinnhubProvider("test");
    new ProviderRouter([provider], () => {}, meter);
    const snapshot = vi.fn();
    const off = provider.subscribe!(["AAPL US Equity"], snapshot);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetch).not.toHaveBeenCalled();
      now = 60_001;
      await vi.advanceTimersByTimeAsync(5000);
      expect(snapshot).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      expect(meter.usage("finnhub")).toMatchObject({ lastMinute: 1, throttled: 1 });
    } finally { off(); }
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels an exhausted Finnhub snapshot retry when its subscription closes", async () => {
    vi.useFakeTimers();
    let now = 0;
    const meter = new UsageMeter(() => now);
    for (let i = 0; i < 55; i++) meter.record("finnhub", true, 0);
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider = createFinnhubProvider("test");
    new ProviderRouter([provider], () => {}, meter);
    const off = provider.subscribe!(["AAPL US Equity"], () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    off();
    now = 60_001;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts both Coinbase quote requests, paged history, and subscription snapshots", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes("/candles?")) return Response.json([]);
      return Response.json(url.endsWith("/ticker")
        ? { price: "100", bid: "99", ask: "101", volume: "1" }
        : { open: "100", high: "101", low: "99" });
    });
    vi.stubGlobal("fetch", fetch);
    const provider = createCoinbaseProvider();
    const router = new ProviderRouter([provider], () => {});
    await router.quote("XBTUSD Curncy");
    await router.history("XBTUSD Curncy", "1d", new Date("2025-01-01"), new Date("2026-02-05"));
    const snapshot = vi.fn();
    const off = provider.subscribe!(["XBTUSD Curncy"], snapshot);
    try {
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledOnce());
      expect(fetch).toHaveBeenCalledTimes(6);
      expect(router.usage()[0]).toMatchObject({ lastMinute: 6, errors24h: 0 });
    } finally { off(); }
  });

  it("stops Coinbase snapshot fanout before dispatching over-budget HTTP requests", async () => {
    const fetch = vi.fn(async () => Response.json({ price: "100" }));
    vi.stubGlobal("fetch", fetch);
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const meter = new UsageMeter();
    for (let i = 0; i < 499; i++) meter.record("coinbase", true, 0);
    const provider = createCoinbaseProvider();
    const router = new ProviderRouter([provider], () => {}, meter);
    const off = provider.subscribe!(["XBTUSD Curncy"], () => {});
    try {
      await vi.waitFor(() => expect(warning).toHaveBeenCalled());
      expect(fetch).toHaveBeenCalledOnce();
      expect(router.usage()[0]).toMatchObject({ lastMinute: 500, throttled: 1, errors24h: 0 });
    } finally { off(); }
  });

  it("leaves international equity quotes and trades to an eligible provider", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const router = new ProviderRouter([createFinnhubProvider("test"), createMockProvider()], () => {});
    expect(router.streamingPlugin("VOD LN Equity")).toBeNull();
    expect(router.tradesPlugin("VOD LN Equity")?.id).toBe("mock");
    expect((await router.quote("VOD LN Equity"))?.source).toBe("Mock");
    expect(fetch).not.toHaveBeenCalled();
    expect(router.streamingPlugin("AAPL US Equity")?.id).toBe("finnhub");
  });
});
