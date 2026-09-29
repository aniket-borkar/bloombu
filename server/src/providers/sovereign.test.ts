import { describe, expect, it } from "vitest";
import { curveFromSeries, parseBocCurve, parseBoeCurveCsv, parseEcbCurveCsv, parseMofCsv } from "./sovereign.js";

describe("sovereign curve parsers", () => {
  it("builds the latest curve with one-week and one-month comparisons", () => {
    const csv = [
      "KEY,FREQ,TIME_PERIOD,OBS_VALUE",
      ...["2026-08-24", "2026-09-17", "2026-09-24"].flatMap((d, i) => [
        `YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_2Y,B,${d},${2.5 + i / 10}`,
        `YC.B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y,B,${d},${3 + i / 10}`,
      ]),
    ].join("\n");
    const c = curveFromSeries("Euro", "ECB", ["2Y", "10Y"], parseEcbCurveCsv(csv))!;
    expect(c.date).toBe("2026-09-24");
    expect(c.points).toEqual([
      { tenor: "2Y", years: 2, yieldPct: 2.7 },
      { tenor: "10Y", years: 10, yieldPct: 3.2 },
    ]);
    expect(c.history.map((h) => [h.label, h.date])).toEqual([
      ["1W Ago", "2026-09-17"],
      ["1M Ago", "2026-08-24"],
    ]);
  });

  it("reads Japan MOF, Bank of Canada and Bank of England formats", () => {
    const mof = parseMofCsv("Interest Rate,,(Unit : %)\nDate,1Y,2Y,10Y\n2026/9/24,1.627,1.912,3.073\n2026/9/25,1.6,-,3.1\n");
    expect(Object.fromEntries(mof.get("2026-09-24")!)).toEqual({ "1Y": 1.627, "2Y": 1.912, "10Y": 3.073 });
    expect(mof.get("2026-09-25")!.has("2Y")).toBe(false);
    const boc = parseBocCurve({ observations: [{ d: "2026-09-24", "BD.CDN.2YR.DQ.YLD": { v: "3.39" }, "BD.CDN.LONG.DQ.YLD": { v: "4.27" } }] });
    expect(Object.fromEntries(boc.get("2026-09-24")!)).toEqual({ "2Y": 3.39, Long: 4.27 });
    const boe = parseBoeCurveCsv("DATE,IUDSNZC,IUDMNZC,IUDLNZC\n23 Sep 2026,4.8957,5.3055,5.8458\n");
    expect(Object.fromEntries(boe.get("2026-09-23")!)).toEqual({ "5Y": 4.8957, "10Y": 5.3055, "20Y": 5.8458 });
    expect(curveFromSeries("x", "y", ["2Y"], new Map())).toBeNull();
  });
});
