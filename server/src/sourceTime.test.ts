import { describe, expect, it } from "vitest";
import { sourceTimeNs } from "./sourceTime.js";

describe("sourceTimeNs", () => {
  it("preserves nanosecond ordering for trades within the same millisecond", () => {
    const early = "2026-10-26T14:30:00.123000001Z";
    const later = "2026-10-26T14:30:00.123999999Z";
    expect(Date.parse(early)).toBe(Date.parse(later));
    expect(sourceTimeNs(later)! - sourceTimeNs(early)!).toBe(999_998n);
    expect(sourceTimeNs(later)! > sourceTimeNs(early)!).toBe(true);
  });

  it("compares offset timestamps as the same instant without losing fractions", () => {
    const utc = sourceTimeNs("2026-10-26T14:30:00.123456789Z");
    expect(sourceTimeNs("2026-10-26T10:30:00.123456789-04:00")).toBe(utc);
    expect(sourceTimeNs("2026-10-26T20:00:00.123456789+05:30")).toBe(utc);
    expect(sourceTimeNs("2026-10-26t14:30:00.123456789z")).toBe(utc);
  });

  it("pads fractional seconds and supports timestamps before the Unix epoch", () => {
    expect(sourceTimeNs("1970-01-01T00:00:00Z")).toBe(0n);
    expect(sourceTimeNs("1970-01-01T00:00:00.1Z")).toBe(100_000_000n);
    expect(sourceTimeNs("1970-01-01T00:00:00.001Z")).toBe(1_000_000n);
    expect(sourceTimeNs("1969-12-31T23:59:59.999999999Z")).toBe(-1n);
  });

  it("rejects missing, malformed and impossible source times", () => {
    for (const input of [null, undefined, "", "invalid", "2026-10-26", "2026-10-26T14:30:00", "2026-10-26T14:30:00.1234567890Z",
      "2026-02-30T14:30:00Z", "2026-10-26T24:00:00Z", "2026-10-26T14:60:00Z", "2026-10-26T14:30:00+24:00"]) {
      expect(sourceTimeNs(input)).toBeNull();
    }
    expect(sourceTimeNs("2024-02-29T00:00:00Z")).not.toBeNull();
    expect(sourceTimeNs("2026-02-29T00:00:00Z")).toBeNull();
  });
});
