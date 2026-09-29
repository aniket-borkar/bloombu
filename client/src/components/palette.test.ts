import { describe, expect, it } from "vitest";
import { fuzzyScore } from "./CommandPalette";

describe("fuzzyScore", () => {
  it("prefers substring matches, then subsequences", () => {
    expect(fuzzyScore("gp", "GP Price Graph")).toBe(0);
    expect(fuzzyScore("graph", "GP Price Graph")).toBe(9);
    expect(fuzzyScore("pg", "GP Price Graph")).toBeGreaterThanOrEqual(100);
    expect(fuzzyScore("xyz", "GP Price Graph")).toBe(-1);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});
