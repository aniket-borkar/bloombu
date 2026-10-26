import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DIRECT_IDLE_MS, PUBLIC_KRAKEN_URL, PublicCryptoStream, publicCryptoQuote, publicCryptoSymbol } from "./publicCrypto";

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
  push(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) }); }
}
const T = "2026-10-26T14:30:00.123456789Z";
const tick = (at = T, last = 80001) => ({ symbol: "BTC/USD", last, bid: 80000, ask: 80002, bid_qty: 1, ask_qty: 2,
  change: 100, change_pct: 0.125, high: 81000, low: 79000, volume: 123, timestamp: at });
const push = (socket: Socket, at = T, last = 80001) => socket.push({ channel: "ticker", type: "update", data: [tick(at, last)] });

beforeEach(() => {
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("public crypto wire data", () => {
  it("accepts only configured public crypto pairs and keeps source timestamps", () => {
    expect(publicCryptoSymbol("XBTUSD Curncy")).toBe("BTC/USD");
    expect(publicCryptoSymbol("XETEUR Curncy")).toBe("ETH/EUR");
    expect(publicCryptoSymbol("EURUSD Curncy")).toBeNull();
    expect(publicCryptoSymbol("AAPL US Equity")).toBeNull();
    expect(publicCryptoQuote(tick(), "XBTUSD Curncy")).toMatchObject({ source: "Kraken", time: T, last: 80001,
      prevClose: 79901, exchange: "Kraken", currency: "USD", bidSize: 1, askSize: 2, open: null });
    expect(publicCryptoQuote({ ...tick(), timestamp: "not-a-date" }, "XBTUSD Curncy")).toBeNull();
    expect(publicCryptoQuote({ ...tick(), last: NaN }, "XBTUSD Curncy")).toBeNull();
    expect(publicCryptoQuote(tick(), "XETUSD Curncy")).toBeNull();
  });
});

describe("PublicCryptoStream", () => {
  it("shares the public socket, sends no authentication, and dispatches immediately", () => {
    const stream = new PublicCryptoStream();
    const a = vi.fn(); const b = vi.fn();
    const offA = stream.subscribe("XBTUSD Curncy", a, vi.fn());
    const offB = stream.subscribe("XETUSD Curncy", b, vi.fn());
    expect(Socket.instances).toHaveLength(1);
    const socket = Socket.instances[0];
    expect(socket.url).toBe(PUBLIC_KRAKEN_URL);
    socket.open();
    expect(socket.sent).toEqual([{ method: "subscribe", params: { channel: "ticker", symbol: ["BTC/USD", "ETH/USD"], event_trigger: "trades", snapshot: true } }]);
    push(socket);
    expect(a).toHaveBeenCalledOnce(); // No timer, paint callback, or relay trip is needed.
    expect(b).not.toHaveBeenCalled();
    offA();
    expect(socket.readyState).toBe(1);
    offB();
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed and older sub-millisecond observations", () => {
    const stream = new PublicCryptoStream(); const listener = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener, vi.fn());
    const socket = Socket.instances[0]; socket.open();
    socket.onmessage?.({ data: "{" });
    socket.push({ channel: "ticker", data: [null, { ...tick(), timestamp: "yesterday" }] });
    push(socket, "2026-10-26T14:30:00.123999999Z", 80002);
    push(socket, "2026-10-26T14:30:00.123000001Z", 79999);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0].last).toBe(80002);
    off();
  });

  it("falls back after silence and recovers on the next actual update", () => {
    const stream = new PublicCryptoStream(); const unavailable = vi.fn(); const listener = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener, unavailable);
    const socket = Socket.instances[0]; socket.open(); push(socket);
    vi.advanceTimersByTime(DIRECT_IDLE_MS - 1);
    expect(unavailable).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(unavailable).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(5000);
    expect(unavailable).toHaveBeenCalledOnce();
    push(socket, "2026-10-26T14:30:01Z", 80003);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(DIRECT_IDLE_MS);
    expect(unavailable).toHaveBeenCalledTimes(2);
    off();
  });

  it("restores relay on close and cancels reconnect after final unsubscribe", () => {
    const stream = new PublicCryptoStream(); const unavailable = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", vi.fn(), unavailable);
    const socket = Socket.instances[0]; socket.open(); push(socket); socket.close();
    expect(unavailable).toHaveBeenCalledOnce();
    off(); off();
    vi.advanceTimersByTime(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reconnects one socket and resubscribes after a public connection failure", () => {
    const stream = new PublicCryptoStream(); const listener = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener, vi.fn());
    Socket.instances[0].open(); Socket.instances[0].close();
    vi.advanceTimersByTime(1000);
    expect(Socket.instances).toHaveLength(2);
    Socket.instances[1].open(); push(Socket.instances[1]);
    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it("makes subscription rejection fall back without inventing a quote", () => {
    const stream = new PublicCryptoStream(); const listener = vi.fn(); const unavailable = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener, unavailable);
    const socket = Socket.instances[0]; socket.open(); push(socket);
    socket.push({ method: "subscribe", success: false, result: { symbol: "BTC/USD" }, error: "unavailable" });
    expect(unavailable).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    stream.close(); off();
    expect(vi.getTimerCount()).toBe(0);
  });
});
