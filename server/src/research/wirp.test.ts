import { describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock.js";
import { parseFomcCalendar } from "../providers/public.js";
import { ProviderRouter } from "../providers/router.js";
import { impliedPath, rateProbabilities } from "./wirp.js";

describe("impliedPath", () => {
  it("uses the next contract when the following month has no meeting", () => {
    const avg = new Map([
      ["2026-10", 3.89],
      ["2026-11", 3.8],
      ["2026-12", 3.7],
      ["2027-01", 3.62],
    ]);
    const rows = impliedPath(
      [
        { date: "2026-10-28", sep: false },
        { date: "2026-12-09", sep: true },
      ],
      avg,
      new Map([["2026-10", "FFV6 Comdty"]]),
      3.88,
    );
    expect(rows[0]).toMatchObject({ contract: "FFV6 Comdty", impliedRatePct: 3.8, direction: "cut" });
    expect(rows[0].stepBp).toBeCloseTo(-8, 9);
    expect(rows[0].probabilityPct).toBeCloseTo(32, 9);
    expect(rows[1].stepBp).toBeCloseTo(-18, 9);
    expect(rows[1].cumulativeBp).toBeCloseTo(-26, 9);
    expect(rows[1].movesPriced).toBeCloseTo(-1.04, 9);
  });

  it("solves within the month when the next month also has a meeting", () => {
    const rows = impliedPath(
      [
        { date: "2027-01-27", sep: false },
        { date: "2027-02-24", sep: false },
      ],
      new Map([
        ["2027-01", 3.6],
        ["2027-03", 3.4],
      ]),
      new Map(),
      3.62,
    );
    expect(rows[0].impliedRatePct).toBeCloseTo((3.6 * 31 - 3.62 * 27) / 4, 9);
    expect(rows[1].impliedRatePct).toBe(3.4);
    const missing = impliedPath([{ date: "2027-05-05", sep: false }], new Map(), new Map(), 3.6);
    expect(missing[0]).toMatchObject({ impliedRatePct: null, direction: null });
  });
});

describe("parseFomcCalendar", () => {
  it("reads decision days, projection meetings and cross-month meetings", () => {
    const meeting = (month: string, date: string) =>
      `<div class="fomc-meeting__month col-xs-5"><strong>${month}</strong></div><div class="fomc-meeting__date col-xs-4">${date}</div>`;
    const html = `<h4>2026 FOMC Meetings</h4>${meeting("January", "27-28")}${meeting("Apr/May", "30-1")}${meeting("December", "8-9*")}${meeting("March", "(notation vote)")}
      <h4>2025 FOMC Meetings</h4>${meeting("October", "28-29")}`;
    expect(parseFomcCalendar(html)).toEqual([
      { date: "2025-10-29", sep: false },
      { date: "2026-01-28", sep: false },
      { date: "2026-05-01", sep: false },
      { date: "2026-12-09", sep: true },
    ]);
  });
});

describe("rateProbabilities (mock)", () => {
  it("prices every upcoming meeting from the futures strip", async () => {
    const t = Date.UTC(2026, 8, 25, 15);
    const r = await rateProbabilities(new ProviderRouter([createMockProvider(() => t)], () => {}), new Date(t));
    expect(r).toMatchObject({ currentRatePct: 3.88, targetLow: 3.75, targetHigh: 4 });
    expect(r!.months).toHaveLength(16);
    expect(r!.months[0]).toMatchObject({ contract: "FFU6 Comdty", month: "Sep 26" });
    expect(r!.meetings.length).toBe(8);
    expect(r!.meetings.every((m) => m.impliedRatePct !== null)).toBe(true);
    expect(r!.meetings.at(-1)!.cumulativeBp!).toBeLessThan(0);
  });
});
