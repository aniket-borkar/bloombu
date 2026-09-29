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
});

describe("connectionLabel", () => {
  it("is LIVE with an open socket, else POLL or OFFLINE by REST health", () => {
    expect(connectionLabel({ socket: "open", rest: false })).toBe("LIVE");
    expect(connectionLabel({ socket: "closed", rest: true })).toBe("POLL");
    expect(connectionLabel({ socket: "connecting", rest: false })).toBe("OFFLINE");
  });
});
