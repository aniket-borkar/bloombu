import { describe, expect, it } from "vitest";
import { parseBocJson, parseBoeCsv, parseBojJson, parseEcbCsv, parseRbaCsv, parseSnbCsv } from "../providers/centralBanks.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import type { OvernightRate } from "../types.js";
import { ForwardError, forwardCurve, forwardsFor, fxPair } from "./forwards.js";

const r = (currency: string, ratePct: number): OvernightRate => ({ currency, name: currency, ratePct, date: "2026-09-24", source: "t" });

describe("forwardCurve", () => {
  it("applies covered interest parity with each currency's day count", () => {
    const c = forwardCurve("EURUSD Curncy", 1.16, r("EUR", 2.44), r("USD", 3.88));
    const oneYear = c.rows.find((x) => x.tenor === "1Y")!;
    expect(oneYear.outright).toBeCloseTo((1.16 * (1 + 0.0388 * (365 / 360))) / (1 + 0.0244 * (365 / 360)), 12);
    expect(oneYear.points).toBeCloseTo((oneYear.outright - 1.16) / 0.0001, 9);
    expect(oneYear.points).toBeGreaterThan(0);
    const gbp = forwardCurve("GBPUSD Curncy", 1.33, r("GBP", 3.73), r("USD", 3.88)).rows.find((x) => x.tenor === "3M")!;
    expect(gbp.outright).toBeCloseTo((1.33 * (1 + 0.0388 * (91 / 360))) / (1 + 0.0373 * (91 / 365)), 12);
    const jpy = forwardCurve("USDJPY Curncy", 157, r("USD", 3.88), r("JPY", 0.98)).rows[0];
    expect(jpy.points).toBeCloseTo((jpy.outright - 157) / 0.01, 9);
    expect(jpy.points).toBeLessThan(0);
  });

  it("reads FX pairs and single-currency codes by market convention", () => {
    expect(fxPair("EURUSD Curncy")).toEqual({ base: "EUR", quote: "USD" });
    expect(fxPair("JPY Curncy")).toEqual({ base: "USD", quote: "JPY" });
    expect(fxPair("GBP Curncy")).toEqual({ base: "GBP", quote: "USD" });
    expect(fxPair("XBTUSD Curncy")).toBeNull();
    expect(fxPair("AAPL US Equity")).toBeNull();
  });
});

describe("central bank parsers", () => {
  it("reads each source's latest observation", () => {
    expect(parseEcbCsv("KEY,FREQ,TIME_PERIOD,OBS_VALUE\nEST.B,B,2026-09-24,2.44\n")).toEqual({ date: "2026-09-24", value: 2.44 });
    expect(parseBoeCsv("DATE,IUDSOIA\n23 Sep 2026,3.7301\n24 Sep 2026,3.7302\n")).toEqual({ date: "2026-09-24", value: 3.7302 });
    expect(parseSnbCsv('\uFEFF"CubeId";"zirepo"\n\n"Date";"D0";"Value"\n"2026-09-14";"H0";"-0.038744"\n"2026-09-15";"H0";"-0.040425"\n')).toEqual({
      date: "2026-09-15",
      value: -0.040425,
    });
    expect(parseRbaCsv("F1 INTEREST RATES\nTitle,Cash Rate Target,Change,Interbank Overnight Cash Rate\n24-Sep-2026,4.35,,4.35\n25-Sep-2026,,,\n")).toEqual({
      date: "2026-09-24",
      value: 4.35,
    });
    expect(parseBojJson({ RESULTSET: [{ VALUES: { SURVEY_DATES: [20260924, 20260925, 20260926], VALUES: [0.977, 0.978, null] } }] })).toEqual({
      date: "2026-09-25",
      value: 0.978,
    });
    expect(parseBocJson({ observations: [{ d: "2026-09-24", "AVG.INTWO": { v: "2.2600" } }] }, "AVG.INTWO")).toEqual({ date: "2026-09-24", value: 2.26 });
  });
});

describe("forwardsFor (mock)", () => {
  const router = new ProviderRouter([createMockProvider()], () => {});
  it("prices a pair and explains what is missing", async () => {
    const c = await forwardsFor(router, "eurusd curncy");
    expect(c).toMatchObject({ security: "EURUSD Curncy", base: { currency: "EUR" }, quote: { currency: "USD" } });
    expect(c.rows).toHaveLength(8);
    await expect(forwardsFor(router, "USDMXN Curncy")).rejects.toThrow(/NO FREE OVERNIGHT RATE FOR MXN/);
    await expect(forwardsFor(router, "AAPL US Equity")).rejects.toBeInstanceOf(ForwardError);
  });
});
