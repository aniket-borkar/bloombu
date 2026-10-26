import { describe, expect, it, vi } from "vitest";
import { yahooQuote } from "./yahooQuote.js";
import { createYahooProvider } from "./yahoo.js";

const quoteRequest = vi.hoisted(() => vi.fn());
vi.mock("yahoo-finance2", () => ({ default: class { quote = quoteRequest; } }));

const SECURITY = "AAPL US Equity";
const regularTime = new Date("2026-10-23T20:00:00Z");
const base = {
  regularMarketPrice: 100, regularMarketTime: regularTime, regularMarketChange: 2, regularMarketChangePercent: 2.040816,
  regularMarketPreviousClose: 98, regularMarketOpen: 99, regularMarketDayHigh: 101, regularMarketDayLow: 97,
  regularMarketVolume: 1234, currency: "USD", longName: "Apple", marketState: "CLOSED",
};

describe("Yahoo quote session selection", () => {
  it("returns an extended observation through the provider when the regular price is missing", async () => {
    quoteRequest.mockResolvedValueOnce([{ ...base, symbol: "AAPL", regularMarketPrice: null, marketState: "PRE",
      preMarketPrice: 103, preMarketTime: new Date("2026-10-26T08:55:00Z") }]);
    const quotes = await createYahooProvider().quotes!([SECURITY]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ security: SECURITY, last: 103, priceSession: "pre", time: "2026-10-26T08:55:00.000Z", prevClose: null });
  });

  it("uses current pre-market prints rather than the prior regular close", () => {
    const q = yahooQuote(SECURITY, { ...base, marketState: "PRE", preMarketPrice: 103, preMarketTime: new Date("2026-10-26T08:55:00Z") })!;
    expect(q).toMatchObject({ last: 103, time: "2026-10-26T08:55:00.000Z", prevClose: 100, regularClose: 100, change: 3, changePct: 3, priceSession: "pre", open: 99, high: 101, low: 97, volume: 1234 });
  });

  it("uses post-market prints without replacing the previous-day P&L reference", () => {
    const q = yahooQuote(SECURITY, { ...base, marketState: "POST", postMarketPrice: 99, postMarketTime: Date.parse("2026-10-23T21:00:00Z") / 1000 })!;
    expect(q.priceSession).toBe("post");
    expect(q).toMatchObject({ last: 99, prevClose: 98, regularClose: 100, change: 1, time: "2026-10-23T21:00:00.000Z" });
    expect(q.changePct).toBeCloseTo(1 / 98 * 100);
  });

  it("supports unified current-extended-session fields and picks the newer valid observation", () => {
    const q = yahooQuote(SECURITY, { ...base, marketState: "PREPRE", preMarketPrice: 102, preMarketTime: "2026-10-26T08:50:00Z",
      extendedMarketPrice: 104, extendedMarketTime: "2026-10-26T08:55:00Z" })!;
    expect(q).toMatchObject({ last: 104, priceSession: "pre", time: "2026-10-26T08:55:00.000Z" });
  });

  it("does not select stale, invalid, missing-time or opposite-session values", () => {
    for (const values of [
      { preMarketPrice: 105, preMarketTime: new Date("2026-10-23T13:00:00Z") },
      { preMarketPrice: 105, preMarketTime: regularTime },
      { preMarketPrice: 105, preMarketTime: new Date(NaN) },
      { preMarketPrice: 105 },
      { preMarketPrice: NaN, preMarketTime: new Date("2026-10-26T08:55:00Z") },
      { postMarketPrice: 105, postMarketTime: new Date("2026-10-26T08:55:00Z") },
    ]) expect(yahooQuote(SECURITY, { ...base, marketState: "PRE", ...values })).toMatchObject({ last: 100, priceSession: "regular", time: regularTime.toISOString(), prevClose: 98, change: 2 });
  });

  it("keeps regular-session and closed-market observations explicit", () => {
    for (const marketState of ["REGULAR", "CLOSED"]) {
      expect(yahooQuote(SECURITY, { ...base, marketState, postMarketPrice: 105, postMarketTime: new Date("2026-10-23T21:00:00Z") }))
        .toMatchObject({ last: 100, priceSession: "regular", marketState, time: regularTime.toISOString() });
    }
  });

  it("admits a valid extended quote when the regular price is unavailable without inventing a reference", () => {
    expect(yahooQuote(SECURITY, { ...base, marketState: "PREPRE", regularMarketPrice: null, preMarketPrice: 101, preMarketTime: "2026-10-26T08:55:00Z" }))
      .toMatchObject({ last: 101, priceSession: "pre", change: null, changePct: null, prevClose: null });
    expect(yahooQuote(SECURITY, { ...base, regularMarketPrice: null })).toBeNull();
  });

  it("handles unavailable regular timestamps without throwing or inventing a market time", () => {
    expect(yahooQuote(SECURITY, { ...base, regularMarketTime: new Date(NaN) })).toMatchObject({ last: 100, time: null });
  });
});
