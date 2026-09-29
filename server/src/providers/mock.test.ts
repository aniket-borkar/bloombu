import { describe, expect, it } from "vitest";
import { createMockProvider, MOCK_CATALOG } from "./mock.js";

const T = Date.UTC(2026, 8, 25, 15, 30);

describe("mock provider", () => {
  it("is deterministic for a given time", async () => {
    const [a] = await createMockProvider(() => T).quotes!(["AAPL US Equity"]);
    const [b] = await createMockProvider(() => T).quotes!(["AAPL US Equity"]);
    expect(a).toEqual(b);
  });

  it("changes price over time", async () => {
    let now = T;
    const p = createMockProvider(() => now);
    const [a] = await p.quotes!(["AAPL US Equity"]);
    now += 10_000;
    const [b] = await p.quotes!(["AAPL US Equity"]);
    expect(a.last).not.toBe(b.last);
  });

  it("produces internally consistent quotes near the anchor price", async () => {
    const p = createMockProvider(() => T);
    const quotes = await p.quotes!(MOCK_CATALOG.map((s) => s.security));
    expect(quotes).toHaveLength(MOCK_CATALOG.length);
    for (const q of quotes) {
      const anchor = MOCK_CATALOG.find((s) => s.security === q.security)!.price;
      expect(q.last!).toBeGreaterThan(anchor * 0.4);
      expect(q.last!).toBeLessThan(anchor * 2.5);
      expect(q.high!).toBeGreaterThanOrEqual(q.last!);
      expect(q.low!).toBeLessThanOrEqual(q.last!);
      expect(q.bid!).toBeLessThan(q.ask!);
      expect(q.change!).toBeCloseTo(q.last! - q.prevClose!, 2);
    }
  });

  it("omits unknown securities", async () => {
    expect(await createMockProvider(() => T).quotes!(["ZZZZQX US Equity"])).toEqual([]);
  });

  it("searches by ticker prefix and by name", async () => {
    const p = createMockProvider(() => T);
    expect((await p.search!("microsoft")).map((r) => r.security)).toContain("MSFT US Equity");
    expect((await p.search!("SP")).map((r) => r.security)).toContain("SPX Index");
  });

  it("returns ordered, well-formed bars inside the requested window", async () => {
    const p = createMockProvider(() => T);
    const from = new Date(T - 30 * 86_400_000);
    const bars = await p.history!("SPX Index", "1d", from, new Date(T));
    expect(bars.length).toBeGreaterThanOrEqual(29);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      expect(b.t).toBeGreaterThanOrEqual(from.getTime());
      expect(b.t).toBeLessThanOrEqual(T);
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
      if (i) expect(b.t - bars[i - 1].t).toBe(86_400_000);
    }
  });

  it("aligns weekly bars to Monday", async () => {
    const bars = await createMockProvider(() => T).history!("SPX Index", "1wk", new Date(T - 90 * 86_400_000), new Date(T));
    for (const b of bars) expect(new Date(b.t).getUTCDay()).toBe(1);
  });

  it("caps very large requests", async () => {
    const bars = await createMockProvider(() => T).history!("SPX Index", "1m", new Date(0), new Date(T));
    expect(bars.length).toBeLessThanOrEqual(5000);
    expect(bars[bars.length - 1].t).toBeLessThanOrEqual(T);
  });
});
