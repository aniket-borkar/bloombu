import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { HistoryCache } from "../history/cache.js";
import type { ProviderPlugin } from "../providers/DataProvider.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { StreamHub } from "../stream/hub.js";
import { Presence } from "../stream/presence.js";
import { attachWebSocket } from "../stream/ws.js";
import type { Quote } from "../types.js";
import { AlertService, AlertValidationError, RULE_INTERVAL_MS, alertRule, describeAlert, quoteTrigger, validateAlert } from "./alerts.js";

let state = { last: 100, changePct: 1, volume: 1000 };
const quote = (security: string): Quote => ({
  security,
  name: security,
  last: state.last,
  change: null,
  changePct: state.changePct,
  bid: null,
  ask: null,
  bidSize: null,
  askSize: null,
  open: null,
  high: null,
  low: null,
  prevClose: null,
  volume: state.volume,
  currency: "USD",
  exchange: null,
  marketState: null,
  time: null,
  delayMinutes: null,
  source: "fake",
});

function setup(now = () => Date.UTC(2026, 8, 25, 15)) {
  const mock = createMockProvider(now);
  const fake: ProviderPlugin = { ...mock, id: "fake", quotes: async (secs) => secs.map(quote) };
  const router = new ProviderRouter([fake], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), now);
  const pushed: { user: string; payload: any }[] = [];
  const svc = new AlertService(":memory:", router, history, (user, payload) => pushed.push({ user, payload }), now, () => {});
  return { svc, pushed, router, history };
}

describe("quoteTrigger", () => {
  const q = quote("X US Equity");
  it("checks each kind", () => {
    state = { last: 100, changePct: -3, volume: 5000 };
    const qq = quote("X US Equity");
    expect(quoteTrigger({ kind: "above", value: 99 }, qq)).toBe(100);
    expect(quoteTrigger({ kind: "above", value: 101 }, qq)).toBeNull();
    expect(quoteTrigger({ kind: "below", value: 100 }, qq)).toBe(100);
    expect(quoteTrigger({ kind: "pct_down", value: 2 }, qq)).toBe(-3);
    expect(quoteTrigger({ kind: "pct_up", value: 2 }, qq)).toBeNull();
    expect(quoteTrigger({ kind: "volume_above", value: 5000 }, qq)).toBe(5000);
    expect(q.security).toBe("X US Equity");
  });

  it("describes alerts", () => {
    expect(describeAlert({ security: "AAPL US Equity", kind: "pct_up", value: 3, expr: null })).toBe("AAPL US Equity up 3% or more today");
  });
});

describe("validateAlert", () => {
  it("normalizes new alerts and explains what is wrong", () => {
    expect(validateAlert({ security: "aapl us equity", kind: "above", value: "200", note: "  breakout  " })).toEqual({
      security: "AAPL US Equity",
      kind: "above",
      value: 200,
      expr: null,
      note: "breakout",
    });
    expect(validateAlert({ security: "SPY US Equity", kind: "rule", expr: " rsi(close) < 30 " })).toMatchObject({ kind: "rule", value: null, expr: "rsi(close) < 30" });
    expect(() => validateAlert({ security: "nope", kind: "above", value: 1 })).toThrow(AlertValidationError);
    expect(() => validateAlert({ security: "AAPL US Equity", kind: "sideways", value: 1 })).toThrow(/kind must be one of/);
    expect(() => validateAlert({ security: "AAPL US Equity", kind: "pct_up", value: -2 })).toThrow(/positive number/);
    expect(() => validateAlert({ security: "AAPL US Equity", kind: "rule", expr: "close >" })).toThrow(/^Rule: .*at character/);
  });

  it("maps every kind to the daily rule used for its history", () => {
    expect(alertRule({ kind: "above", value: 200, expr: null })).toBe("close >= 200");
    expect(alertRule({ kind: "below", value: 150.5, expr: null })).toBe("close <= 150.5");
    expect(alertRule({ kind: "pct_up", value: 3, expr: null })).toBe("change(close, 1) >= 3");
    expect(alertRule({ kind: "pct_down", value: 3, expr: null })).toBe("change(close, 1) <= -3");
    expect(alertRule({ kind: "volume_above", value: 1e6, expr: null })).toBe("volume >= 1000000");
    expect(alertRule({ kind: "rule", value: null, expr: "rsi(close) < 30" })).toBe("rsi(close) < 30");
  });
});

describe("AlertService", () => {
  it("fires once, notifies the owner, and can be re-armed", async () => {
    state = { last: 100, changePct: 1, volume: 1000 };
    const { svc, pushed } = setup();
    const a = svc.create("ALICE", { security: "aapl us equity", kind: "above", value: 105, note: "breakout" });
    expect(a).toMatchObject({ security: "AAPL US Equity", kind: "above", value: 105, active: true });
    expect(await svc.evaluate()).toEqual([]);
    state.last = 106;
    const fired = await svc.evaluate();
    expect(fired.map((f) => f.id)).toEqual([a.id]);
    expect(pushed).toHaveLength(1);
    expect(pushed[0].user).toBe("ALICE");
    expect(pushed[0].payload.message).toBe("AAPL US Equity price at or above 105: last 106 (breakout)");
    expect(await svc.evaluate()).toEqual([]);
    expect(svc.list("ALICE").triggered[0]).toMatchObject({ id: a.id, triggerValue: 106, active: false });
    svc.rearm("ALICE", a.id);
    expect(svc.list("ALICE").active).toHaveLength(1);
    expect(svc.remove("BOB", a.id)).toBe(false);
    expect(svc.remove("ALICE", a.id)).toBe(true);
    svc.close();
  });

  it("evaluates rule alerts on daily bars at most every few minutes", async () => {
    let now = Date.UTC(2026, 8, 25, 15);
    const { svc, pushed } = setup(() => now);
    svc.create("ALICE", { security: "SPX Index", kind: "rule", expr: "close > 0" });
    svc.create("ALICE", { security: "SPX Index", kind: "rule", expr: "close < 0" });
    expect(await svc.evaluate()).toHaveLength(1);
    expect(pushed[0].payload.message).toContain("rule: close > 0");
    expect(await svc.evaluate()).toHaveLength(0);
    now += RULE_INTERVAL_MS;
    expect(await svc.evaluate()).toHaveLength(0);
    svc.close();
  });

  it("validates input", () => {
    const { svc } = setup();
    expect(() => svc.create("ALICE", { security: "nope", kind: "above", value: 1 })).toThrow(/security/);
    expect(() => svc.create("ALICE", { security: "SPX Index", kind: "sideways", value: 1 })).toThrow(/kind/);
    expect(() => svc.create("ALICE", { security: "SPX Index", kind: "pct_up", value: -1 })).toThrow(/positive/);
    expect(() => svc.create("ALICE", { security: "SPX Index", kind: "rule", expr: "sma(close)" })).toThrow(/Rule: sma takes 2 arguments/);
    svc.close();
  });
});

describe("alert delivery over WebSocket", () => {
  it("pushes alerts only to sockets that said hello as the owner", async () => {
    const presence = new Presence();
    const { router } = setup();
    const server = createServer();
    const wss = attachWebSocket(server, new StreamHub(router, 60_000, () => {}), { presence });
    await new Promise<void>((r) => server.listen(0, r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
    const alice = new WebSocket(url);
    const bob = new WebSocket(url);
    await Promise.all([alice, bob].map((w) => new Promise((r) => w.once("open", r))));
    const got: Record<string, string[]> = { alice: [], bob: [] };
    alice.on("message", (d) => got.alice.push(d.toString()));
    bob.on("message", (d) => got.bob.push(d.toString()));
    alice.send(JSON.stringify({ op: "hello", user: "alice" }));
    bob.send(JSON.stringify({ op: "hello", user: "bob" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(presence.sendTo("ALICE", { type: "alert", message: "hi" })).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(got.alice.map((m) => JSON.parse(m).message)).toEqual(["hi"]);
    expect(got.bob).toEqual([]);
    alice.close();
    bob.close();
    wss.close();
    server.close();
  });
});
