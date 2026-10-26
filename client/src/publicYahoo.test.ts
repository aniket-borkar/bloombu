import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "./api";
import { PUBLIC_YAHOO_URL, PublicYahooStream, publicYahooSymbol, YAHOO_DIRECT_IDLE_MS } from "./publicYahoo";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(public url: string) { Socket.instances.push(this); }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  push(message: string) { this.onmessage?.({ data: JSON.stringify({ message }) }); }
}
const T = Date.parse("2026-10-26T22:00:00Z");
function varint(input: bigint | number): number[] {
  let value = BigInt(input); const out: number[] = [];
  do { const b = Number(value & 127n); value >>= 7n; out.push(b | (value ? 128 : 0)); } while (value);
  return out;
}
function float(field: number, value: number): number[] {
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...varint(field * 8 + 5), ...bytes];
}
function pricing(id = "EURUSD=X", price = 1.12, time = T, hours = 1, extra: number[] = []): string {
  const symbol = new TextEncoder().encode(id);
  const bytes = [...varint(10), ...varint(symbol.length), ...symbol, ...float(2, price), ...varint(24), ...varint(BigInt(time) * 2n),
    ...varint(56), ...varint(hours), ...extra];
  return btoa(String.fromCharCode(...bytes));
}
function seed(time = T - 1000, last = 99): Quote {
  return { security: "AAPL US Equity", name: "Apple Inc.", last, time: new Date(time).toISOString(), change: last - 98,
    changePct: (last - 98) / 98 * 100, prevClose: 98, regularClose: 100, priceSession: "post", marketState: "POST",
    bid: 98, ask: 100, bidSize: 1, askSize: 2, open: 98, high: 103, low: 97, volume: 1000,
    currency: "USD", exchange: "Nasdaq", source: "Yahoo Finance", delayMinutes: 0 };
}
beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("PublicYahooStream", () => {
  it("shares one keyless public socket and dispatches genuine FX ticks immediately", () => {
    expect(publicYahooSymbol("EURUSD Curncy")).toBe("EURUSD=X");
    expect(publicYahooSymbol("AAPL US Equity")).toBe("AAPL");
    expect(publicYahooSymbol("not a security")).toBeNull();
    const stream = new PublicYahooStream(); const a = vi.fn(); const b = vi.fn();
    const offA = stream.subscribe("EURUSD Curncy", a, vi.fn());
    const offB = stream.subscribe("EURUSD Curncy", b, vi.fn());
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0]; expect(socket.url).toBe(PUBLIC_YAHOO_URL); socket.open();
    expect(socket.sent).toEqual([{ subscribe: ["EURUSD=X"] }]);
    socket.push(pricing());
    expect(a).toHaveBeenCalledOnce(); // No quote timer or animation frame.
    expect(b).toHaveBeenCalledOnce();
    expect(a.mock.calls[0][0]).toMatchObject({ security: "EURUSD Curncy", time: new Date(T).toISOString(), source: "Yahoo Finance" });
    socket.push(pricing("EURUSD=X", 1.13, T + 1000));
    expect(a.mock.calls[1][0].last).toBeCloseTo(1.13);
    offA(); expect(socket.sent).toHaveLength(1);
    offB(); offB();
    expect(socket.sent).toContainEqual({ unsubscribe: ["EURUSD=X"] });
    expect(socket.readyState).toBe(3); expect(vi.getTimerCount()).toBe(0);
  });

  it("enriches a native post-market quote without callbacks or price rewinds", () => {
    const stream = new PublicYahooStream(); const listener = vi.fn();
    const off = stream.subscribe("AAPL US Equity", listener, vi.fn());
    const socket = Socket.instances[0]; socket.open(); socket.push(pricing("AAPL", 101, T, 2, float(12, 1)));
    expect(listener.mock.calls[0][0]).toMatchObject({ last: 101, prevClose: null, regularClose: null });
    stream.seed(seed()); stream.seed(seed(T, 90));
    expect(listener).toHaveBeenCalledOnce();
    socket.push(pricing("AAPL", 102, T + 1000, 2, [...float(12, 2), ...float(16, 100)]));
    expect(listener.mock.calls[1][0]).toMatchObject({ last: 102, name: "Apple Inc.", prevClose: 98, regularClose: 100,
      change: 4, open: 98, high: 103, low: 97, volume: 1000, currency: "USD" });
    off();
  });

  it("uses a newer seed as a guard and rejects malformed, oversized, and old frames", () => {
    const stream = new PublicYahooStream(); const listener = vi.fn();
    stream.seed(seed()); const off = stream.subscribe("AAPL US Equity", listener, vi.fn());
    const socket = Socket.instances[0]; socket.open();
    socket.onmessage?.({ data: "{" }); socket.onmessage?.({ data: " ".repeat(30_000) });
    for (const message of ["malformed", pricing("AAPL", NaN), pricing("MSFT", 12), pricing("AAPL", 90, T - 2000)]) socket.push(message);
    expect(listener).not.toHaveBeenCalled();
    socket.push(pricing("AAPL", 101, T, 2));
    stream.seed(seed(T + 2000, 103));
    socket.push(pricing("AAPL", 102, T + 1000, 2));
    expect(listener).toHaveBeenCalledOnce();
    socket.push(pricing("AAPL", 104, T + 3000, 2));
    expect(listener.mock.calls[1][0].last).toBe(104);
    off();
  });

  it("falls back after eight seconds of accepted-tick silence and recovers on an actual tick", () => {
    const stream = new PublicYahooStream(); const unavailable = vi.fn(); const listener = vi.fn();
    const off = stream.subscribe("EURUSD Curncy", listener, unavailable);
    const socket = Socket.instances[0]; socket.open(); socket.push(pricing());
    vi.advanceTimersByTime(YAHOO_DIRECT_IDLE_MS - 1); expect(unavailable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(unavailable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000); expect(unavailable).toHaveBeenCalledOnce();
    socket.push(pricing("EURUSD=X", 1.13, T + 1000)); expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(YAHOO_DIRECT_IDLE_MS); expect(unavailable).toHaveBeenCalledTimes(2);
    off(); expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes subscriptions every fifteen seconds and reconnects on transport loss", () => {
    const stream = new PublicYahooStream(); const unavailable = vi.fn();
    const off = stream.subscribe("EURUSD Curncy", vi.fn(), unavailable);
    const socket = Socket.instances[0]; socket.open(); socket.push(pricing());
    vi.advanceTimersByTime(15_000);
    expect(socket.sent).toEqual([{ subscribe: ["EURUSD=X"] }, { subscribe: ["EURUSD=X"] }]);
    socket.close(); vi.advanceTimersByTime(1000); expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].open(); expect(Socket.instances[1].sent).toEqual([{ subscribe: ["EURUSD=X"] }]);
    off(); vi.advanceTimersByTime(60_000); expect(Socket.instances).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled handshake and ignores a closed connection's late events", () => {
    const stream = new PublicYahooStream(); const listener = vi.fn();
    const off = stream.subscribe("EURUSD Curncy", listener, vi.fn());
    const first = Socket.instances[0];
    vi.advanceTimersByTime(9000); expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].open(); first.push(pricing()); expect(listener).not.toHaveBeenCalled();
    stream.close(); off(); vi.advanceTimersByTime(60_000); expect(Socket.instances).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
});
