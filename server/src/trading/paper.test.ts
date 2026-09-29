import { describe, expect, it, vi } from "vitest";
import { PortfolioStore } from "../portfolio/store.js";
import type { Quote } from "../types.js";
import { PaperBroker, PaperError, fillPrice } from "./paper.js";

const q = (security: string, last: number, bid: number | null, ask: number | null, currency = "USD"): Quote => ({ security, last, bid, ask, currency }) as Quote;

function setup(quotes: Quote[]) {
  const book = new Map(quotes.map((x) => [x.security, x]));
  const router = { quotes: vi.fn(async (secs: string[]) => secs.flatMap((s) => (book.has(s) ? [book.get(s)!] : []))) };
  const portfolios = new PortfolioStore(":memory:");
  const notify = vi.fn();
  const broker = new PaperBroker(":memory:", router, portfolios, notify, () => 1_000);
  return { broker, book, portfolios, notify };
}

describe("fillPrice", () => {
  const quote = q("A US Equity", 100, 99.9, 100.1);
  it("fills market orders at the touch and limits and stops only when reached", () => {
    expect(fillPrice({ side: "buy", type: "market", limitPrice: null, stopPrice: null }, quote)).toBe(100.1);
    expect(fillPrice({ side: "sell", type: "market", limitPrice: null, stopPrice: null }, quote)).toBe(99.9);
    expect(fillPrice({ side: "buy", type: "limit", limitPrice: 100, stopPrice: null }, quote)).toBeNull();
    expect(fillPrice({ side: "buy", type: "limit", limitPrice: 101, stopPrice: null }, quote)).toBe(100.1);
    expect(fillPrice({ side: "sell", type: "limit", limitPrice: 99.5, stopPrice: null }, quote)).toBe(99.9);
    expect(fillPrice({ side: "sell", type: "stop", limitPrice: null, stopPrice: 99 }, quote)).toBeNull();
    expect(fillPrice({ side: "sell", type: "stop", limitPrice: null, stopPrice: 100 }, quote)).toBe(99.9);
    expect(fillPrice({ side: "buy", type: "market", limitPrice: null, stopPrice: null }, q("B", 50, null, null))).toBe(50);
  });
});

describe("PaperBroker", () => {
  it("fills, tracks cash by currency and average cost, and mirrors positions into a Paper portfolio", async () => {
    const { broker, book, portfolios, notify } = setup([q("AAPL US Equity", 100, 99.9, 100.1), q("VOD LN Equity", 125, 124.9, 125.1, "GBp")]);
    await broker.place("ALICE", { security: "aapl us equity", side: "buy", quantity: 10 });
    await broker.place("ALICE", { security: "AAPL US Equity", side: "buy", quantity: 10, type: "limit", limitPrice: 101 });
    await broker.place("ALICE", { security: "VOD LN Equity", side: "buy", quantity: 1000 });
    const a = broker.account("ALICE");
    expect(a.cash.USD).toBeCloseTo(1_000_000 - 20 * 100.1, 6);
    expect(a.cash.GBP).toBeCloseTo(-1000 * 1.251, 6);
    expect(a.positions.find((p) => p.security === "AAPL US Equity")).toMatchObject({ quantity: 20, avgCost: 100.1, currency: "USD" });
    expect(notify).toHaveBeenCalledWith("ALICE", expect.objectContaining({ type: "paper.fill", message: expect.stringContaining("Filled: BUY 10 AAPL US Equity") }));
    expect(portfolios.findByName("ALICE", "Paper")!.holdings.map((h) => [h.security, h.quantity])).toEqual([
      ["AAPL US Equity", 20],
      ["VOD LN Equity", 1000],
    ]);

    const stop = await broker.place("ALICE", { security: "AAPL US Equity", side: "sell", quantity: 20, type: "stop", stopPrice: 95 });
    expect(stop.status).toBe("open");
    book.set("AAPL US Equity", q("AAPL US Equity", 94, 93.9, 94.1));
    await broker.evaluate();
    expect(broker.order("ALICE", stop.id)).toMatchObject({ status: "filled", fillPrice: 93.9 });
    expect(broker.account("ALICE").positions.map((p) => p.security)).toEqual(["VOD LN Equity"]);
    expect(broker.account("BOB").orders).toEqual([]);
  });

  it("cancels, rejects unpriceable market orders, validates input and resets", async () => {
    const { broker, portfolios } = setup([q("AAPL US Equity", 100, 99.9, 100.1)]);
    const limit = await broker.place("ALICE", { security: "AAPL US Equity", side: "sell", quantity: 5, type: "limit", limitPrice: 500 });
    expect(broker.cancel("BOB", limit.id)).toBeNull();
    expect(broker.cancel("ALICE", limit.id)).toMatchObject({ status: "cancelled" });
    expect((await broker.place("ALICE", { security: "ZZZ US Equity", side: "buy", quantity: 1 })).status).toBe("rejected");
    expect(() => broker.place("ALICE", { security: "nope", side: "buy", quantity: 1 })).toThrow(PaperError);
    expect(() => broker.place("ALICE", { security: "AAPL US Equity", side: "hold", quantity: 1 })).toThrow(/side/);
    expect(() => broker.place("ALICE", { security: "AAPL US Equity", side: "buy", quantity: -1 })).toThrow(/quantity/);
    expect(() => broker.place("ALICE", { security: "AAPL US Equity", side: "buy", quantity: 1, type: "limit" })).toThrow(/limitPrice/);
    await broker.place("ALICE", { security: "AAPL US Equity", side: "buy", quantity: 1 });
    const fresh = broker.reset("ALICE", 50_000);
    expect(fresh).toMatchObject({ startingCash: 50_000, cash: { USD: 50_000 }, positions: [], orders: [] });
    expect(portfolios.findByName("ALICE", "Paper")).toBeNull();
  });
});
