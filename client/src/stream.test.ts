import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionLabel, useConnection } from "./store/connection";
import { QuoteStream } from "./stream";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  push(quote: object) {
    this.onmessage?.({ data: JSON.stringify({ type: "quote", quote }) });
  }
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1];

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.useFakeTimers();
  useConnection.setState({ socket: "closed", rest: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("QuoteStream", () => {
  it("opens one socket and subscribes each security once", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe("SPX Index", a);
    s.subscribe("SPX Index", b);
    s.subscribe("AAPL US Equity", a);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(useConnection.getState().socket).toBe("connecting");
    last().open();
    expect(s.connected).toBe(true);
    expect(last().sent).toEqual([{ op: "sub", securities: ["SPX Index", "AAPL US Equity"] }]);

    last().push({ security: "SPX Index", last: 1 });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes only when the last listener leaves", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    const un1 = s.subscribe("SPX Index", vi.fn());
    const un2 = s.subscribe("SPX Index", vi.fn());
    last().open();
    un1();
    expect(last().sent).toHaveLength(1);
    un2();
    expect(last().sent[1]).toEqual({ op: "unsub", securities: ["SPX Index"] });
  });

  it("reconnects with backoff and resubscribes", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    s.subscribe("SPX Index", vi.fn());
    last().open();
    last().close();
    expect(useConnection.getState().socket).toBe("closed");
    vi.advanceTimersByTime(999);
    expect(FakeSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(2);
    last().close();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.instances).toHaveLength(3);
    last().open();
    expect(last().sent).toEqual([{ op: "sub", securities: ["SPX Index"] }]);
  });

  it("does not reconnect when nothing is subscribed", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    const un = s.subscribe("SPX Index", vi.fn());
    last().open();
    un();
    last().close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("shares a trade subscription until the final panel leaves, including after reconnect", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    const first = s.subscribeTrades("AAPL US Equity");
    const second = s.subscribeTrades("AAPL US Equity");
    last().open();
    expect(last().sent).toEqual([{ op: "trades.sub", security: "AAPL US Equity" }]);
    first();
    first(); // Cleanup is idempotent.
    expect(last().sent).toHaveLength(1);
    last().close();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(last().sent).toEqual([{ op: "trades.sub", security: "AAPL US Equity" }]);
    second();
    expect(last().sent[1]).toEqual({ op: "trades.unsub", security: "AAPL US Equity" });
    last().close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("replays the shared trade snapshot and recent fills to a newly opened panel", () => {
    const s = new QuoteStream(() => "ws://x/ws");
    const stop = s.subscribeTrades("AAPL US Equity");
    last().open();
    last().onmessage?.({ data: JSON.stringify({ type: "trades", security: "AAPL US Equity", available: true, trades: [] }) });
    last().onmessage?.({ data: JSON.stringify({ type: "trade", security: "AAPL US Equity", trade: { price: 200 } }) });
    const panel = vi.fn();
    const off = s.on("trades", panel);
    expect(panel).toHaveBeenCalledExactlyOnceWith({ type: "trades", security: "AAPL US Equity", available: true, trades: [{ price: 200 }] });
    off();
    stop();
    last().onmessage?.({ data: JSON.stringify({ type: "trades", security: "AAPL US Equity", available: true, trades: [{ price: 199 }] }) });
    s.on("trades", panel);
    expect(panel).toHaveBeenCalledTimes(1);
  });
});

describe("connectionLabel", () => {
  it("is LIVE with an open socket, else POLL or OFFLINE by REST health", () => {
    expect(connectionLabel({ socket: "open", rest: false })).toBe("LIVE");
    expect(connectionLabel({ socket: "closed", rest: true })).toBe("POLL");
    expect(connectionLabel({ socket: "connecting", rest: false })).toBe("OFFLINE");
  });
});

const config = (socket: FakeSocket, directKraken: unknown) => socket.onmessage?.({ data: JSON.stringify({ type: "stream.config", directKraken }) });
const cryptoTick = (socket: FakeSocket, time = "2026-10-26T14:30:00.123456789Z", last = 80001) => socket.onmessage?.({ data: JSON.stringify({
  channel: "ticker", type: "update", data: [{ symbol: "BTC/USD", timestamp: time, last, bid: 80000, ask: 80002 }],
}) });

describe("QuoteStream direct routing", () => {
  it("keeps the relay until the first direct tick, then removes only that relay subscription", () => {
    const stream = new QuoteStream(() => "ws://x/ws"); const crypto = vi.fn(); const equity = vi.fn();
    const offCrypto = stream.subscribe("XBTUSD Curncy", crypto);
    const offEquity = stream.subscribe("AAPL US Equity", equity);
    const server = FakeSocket.instances[0]; server.open(); config(server, true);
    const direct = FakeSocket.instances[1];
    expect(direct.url).toBe("wss://ws.kraken.com/v2");
    expect(server.sent).toEqual([{ op: "sub", securities: ["XBTUSD Curncy", "AAPL US Equity"] }]);
    expect(stream.routeFor("XBTUSD Curncy")).toBe("relay");
    direct.open(); cryptoTick(direct);
    expect(crypto).toHaveBeenCalledOnce();
    expect(stream.routeFor("XBTUSD Curncy")).toBe("direct");
    expect(server.sent.at(-1)).toEqual({ op: "unsub", securities: ["XBTUSD Curncy"] });
    server.push({ security: "XBTUSD Curncy", last: 1, time: "2026-10-26T14:30:01Z" });
    server.push({ security: "AAPL US Equity", last: 100 });
    expect(crypto).toHaveBeenCalledOnce();
    expect(equity).toHaveBeenCalledOnce();
    offCrypto(); offEquity();
    expect(direct.readyState).toBe(3);
  });

  it("does not activate a cached direct quote older than the latest relay quote", () => {
    const stream = new QuoteStream(() => "ws://x/ws"); const listener = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener);
    const server = FakeSocket.instances[0]; server.open();
    server.push({ security: "XBTUSD Curncy", last: 80002, time: "2026-10-26T14:30:01Z" });
    config(server, true);
    const direct = FakeSocket.instances[1]; direct.open(); cryptoTick(direct);
    expect(stream.routeFor("XBTUSD Curncy")).toBe("relay");
    expect(server.sent).toHaveLength(1);
    expect(listener).toHaveBeenCalledOnce();
    cryptoTick(direct, "2026-10-26T14:30:02Z", 80003);
    expect(stream.routeFor("XBTUSD Curncy")).toBe("direct");
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it("restores relay after public failure and revokes direct routing when server policy changes", () => {
    const stream = new QuoteStream(() => "ws://x/ws"); const listener = vi.fn();
    const off = stream.subscribe("XBTUSD Curncy", listener);
    const server = FakeSocket.instances[0]; server.open(); config(server, true);
    const direct = FakeSocket.instances[1]; direct.open(); cryptoTick(direct); direct.close();
    expect(stream.routeFor("XBTUSD Curncy")).toBe("relay");
    expect(server.sent.at(-1)).toEqual({ op: "sub", securities: ["XBTUSD Curncy"] });
    server.push({ security: "XBTUSD Curncy", last: 80002, time: "2026-10-26T14:30:01Z" });
    expect(listener.mock.calls.at(-1)![0].last).toBe(80002);
    config(server, false);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    off();
  });

  it("honors explicit policy and leaves unsupported stock quotes on the server", () => {
    const stream = new QuoteStream(() => "ws://x/ws");
    const offStock = stream.subscribe("AAPL US Equity", vi.fn());
    const server = FakeSocket.instances[0]; server.open(); config(server, true);
    expect(FakeSocket.instances).toHaveLength(1);
    config(server, "true");
    const offCrypto = stream.subscribe("XBTUSD Curncy", vi.fn());
    expect(FakeSocket.instances).toHaveLength(1);
    expect(stream.routeFor("XBTUSD Curncy")).toBe("relay");
    offStock(); offCrypto();
  });

  it("keeps direct crypto on server reconnect and resubscribes it if the new server disables direct mode", () => {
    const stream = new QuoteStream(() => "ws://x/ws");
    const off = stream.subscribe("XBTUSD Curncy", vi.fn());
    const server = FakeSocket.instances[0]; server.open(); config(server, true);
    const direct = FakeSocket.instances[1]; direct.open(); cryptoTick(direct);
    server.close();
    expect(stream.connected).toBe(false); // A public crypto connection cannot mark stock delivery connected.
    vi.advanceTimersByTime(1000);
    const nextServer = FakeSocket.instances[2]; nextServer.open();
    expect(nextServer.sent).toEqual([]);
    config(nextServer, false);
    expect(nextServer.sent).toEqual([{ op: "sub", securities: ["XBTUSD Curncy"] }]);
    expect(direct.readyState).toBe(3);
    expect(stream.routeFor("XBTUSD Curncy")).toBe("relay");
    off();
  });
});
