import { describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../providers/DataProvider.js";
import type { Trade } from "../types.js";
import { TradeHub } from "./trades.js";

function setup() {
  let emit: ((t: Trade) => void) | null = null;
  const unsubscribe = vi.fn();
  const plugin: ProviderPlugin = {
    id: "fake",
    sectors: ["Equity"],
    subscribeTrades: vi.fn((_s, onTrade) => {
      emit = onTrade;
      return unsubscribe;
    }),
  };
  const hub = new TradeHub({ tradesPlugin: (s) => (s.endsWith("Equity") ? plugin : null) }, 3);
  const client = () => {
    const got: { type: string; trades?: Trade[]; trade?: Trade; available?: boolean }[] = [];
    return { got, send: (d: string) => got.push(JSON.parse(d)) };
  };
  const trade = (price: number): Trade => ({ time: `t${price}`, price, size: 1, side: "buy", venue: null });
  return { hub, plugin, unsubscribe, client, trade, emit: (t: Trade) => emit!(t) };
}

describe("TradeHub", () => {
  it("shares one upstream feed, replays a bounded buffer and stops when the last client leaves", () => {
    const { hub, plugin, unsubscribe, client, trade, emit } = setup();
    const a = client();
    hub.handleMessage(a, { op: "trades.sub", security: "aapl us equity" });
    expect(a.got[0]).toEqual({ type: "trades", security: "AAPL US Equity", available: true, trades: [] });
    [1, 2, 3, 4].forEach((p) => emit(trade(p)));
    const b = client();
    hub.handleMessage(b, { op: "trades.sub", security: "AAPL US Equity" });
    expect(plugin.subscribeTrades).toHaveBeenCalledTimes(1);
    expect(b.got[0].trades!.map((t) => t.price)).toEqual([2, 3, 4]);
    emit(trade(5));
    expect(a.got.at(-1)).toMatchObject({ type: "trade", trade: { price: 5 } });
    expect(b.got.at(-1)).toMatchObject({ type: "trade", trade: { price: 5 } });
    hub.handleMessage(a, { op: "trades.unsub", security: "AAPL US Equity" });
    expect(unsubscribe).not.toHaveBeenCalled();
    hub.disconnect(b);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(hub.stats()).toEqual({ feeds: 0 });
  });

  it("says when no source streams trades for a security", () => {
    const { hub, client } = setup();
    const a = client();
    hub.handleMessage(a, { op: "trades.sub", security: "SPX Index" });
    expect(a.got[0]).toEqual({ type: "trades", security: "SPX Index", available: false, trades: [] });
    hub.handleMessage(a, { op: "trades.sub", security: "" });
    expect(a.got[1].type).toBe("error");
  });
});
