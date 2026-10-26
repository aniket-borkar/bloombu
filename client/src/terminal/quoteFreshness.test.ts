import { describe, expect, it } from "vitest";
import type { Quote } from "../api";
import { preferFreshQuote, quoteAge } from "./quoteFreshness";

const quote = (time: string | null, last = 100, source = "Test stream") => ({ security: "AAPL US Equity", time, last, source }) as Quote;

describe("quote freshness", () => {
  it("retains a newer streamed price when a slower snapshot completes", () => {
    const live = quote("2026-10-26T14:30:10Z", 101);
    expect(preferFreshQuote(live, quote("2026-10-26T14:30:00Z"))).toBe(live);
    expect(preferFreshQuote(live, quote(null))).toBe(live);
    expect(preferFreshQuote(live, quote("invalid"))).toBe(live);
  });

  it("compares instants across time zones and keeps equal-time provenance updates", () => {
    const before = quote("2026-10-26T10:30:00-04:00");
    const next = quote("2026-10-26T14:30:01Z", 102);
    expect(preferFreshQuote(before, next)).toBe(next);
    const fallback = quote(next.time, 102, "Finnhub");
    expect(preferFreshQuote(next, fallback)).toBe(fallback);
  });

  it("rejects out-of-order ticks within one millisecond and accepts the newer nanosecond", () => {
    const early = quote("2026-10-26T14:30:00.123000001Z", 100);
    const later = quote("2026-10-26T14:30:00.123999999Z", 101);
    expect(preferFreshQuote(early, later)).toBe(later);
    expect(preferFreshQuote(later, early)).toBe(later);
    const equal = quote("2026-10-26T10:30:00.123999999-04:00", 101, "Finnhub");
    expect(preferFreshQuote(later, equal)).toBe(equal);
  });

  it("accepts an initial untimed observation and a changed security", () => {
    const first = quote(null);
    expect(preferFreshQuote(null, first)).toBe(first);
    const other = { ...first, security: "MSFT US Equity" };
    expect(preferFreshQuote(quote("2026-10-26T14:30:00Z"), other)).toBe(other);
  });

  it("labels source age without calling it transport latency", () => {
    const now = Date.parse("2026-10-26T14:30:00Z");
    expect(quoteAge("2026-10-26T14:29:50Z", now)).toBe("10s old");
    expect(quoteAge("2026-10-26T14:28:30Z", now)).toBe("1m 30s old");
    expect(quoteAge("2026-10-26T12:20:00Z", now)).toBe("2h 10m old");
    expect(quoteAge("2026-10-24T12:30:00Z", now)).toBe("2d 2h old");
    expect(quoteAge("2026-10-26T14:30:05Z", now)).toBe("0s old");
    expect(quoteAge(null, now)).toBe("time unavailable");
    expect(quoteAge("bad", now)).toBe("time unavailable");
  });
});
