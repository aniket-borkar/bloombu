import { describe, expect, it } from "vitest";
import { buildStatement } from "../research/statements.js";
import { issuerKey } from "../research/routes.js";
import { buildCurve, parseFredReleaseDates, parseTreasuryCsv } from "./public.js";
import { parseRss } from "./yahooResearch.js";

describe("Treasury CSV", () => {
  const csv = [
    'Date,"1 Mo","1.5 Month","3 Mo","1 Yr","10 Yr","30 Yr"',
    "09/25/2026,4.04,4.14,4.24,4.50,5.17,5.49",
    "09/18/2026,4.00,4.10,4.20,4.40,5.00,5.30",
    "08/25/2026,3.90,,4.10,4.30,4.90,5.20",
  ].join("\n");

  it("parses tenors, dates and blanks", () => {
    const rows = parseTreasuryCsv(csv);
    expect(rows[0].date).toBe("2026-09-25");
    expect(rows[0].points.map((p) => p.tenor)).toEqual(["1M", "1.5M", "3M", "1Y", "10Y", "30Y"]);
    expect(rows[0].points[1]).toEqual({ tenor: "1.5M", years: 0.125, yieldPct: 4.14 });
    expect(rows[2].points[1].yieldPct).toBeNull();
  });

  it("builds the latest curve with 1W and 1M comparisons", () => {
    const curve = buildCurve(parseTreasuryCsv(csv))!;
    expect(curve.date).toBe("2026-09-25");
    expect(curve.history.map((h) => [h.label, h.date])).toEqual([
      ["1W Ago", "2026-09-18"],
      ["1M Ago", "2026-08-25"],
    ]);
  });
});

describe("RSS", () => {
  it("parses items, CDATA and entities", () => {
    const xml = `<rss><channel><title>Feed</title>
      <item><title><![CDATA[Stocks & bonds rally]]></title><link>https://x.test/a?b=1&amp;c=2</link>
      <pubDate>Fri, 25 Sep 2026 20:00:00 GMT</pubDate><source url="https://s">Reuters</source><guid>id-1</guid></item>
      <item><title>Oil &#8212; steady</title><link>https://x.test/b</link></item>
    </channel></rss>`;
    const items = parseRss(xml, "Fallback");
    expect(items).toEqual([
      { id: "id-1", title: "Stocks & bonds rally", source: "Reuters", time: "2026-09-25T20:00:00.000Z", url: "https://x.test/a?b=1&c=2" },
      { id: "https://x.test/b", title: "Oil \u2014 steady", source: "Fallback", time: null, url: "https://x.test/b" },
    ]);
  });
});

describe("FRED release dates", () => {
  it("maps release names and dates", () => {
    expect(
      parseFredReleaseDates({ release_dates: [{ release_id: 10, release_name: "Consumer Price Index", date: "2026-10-14" }, { date: "x" }] }),
    ).toEqual([{ date: "2026-10-14", name: "Consumer Price Index", source: "FRED, Federal Reserve Bank of St. Louis" }]);
  });
});

describe("buildStatement", () => {
  it("drops a sparse oldest period", () => {
    const full = { totalRevenue: 1, costOfRevenue: 1, grossProfit: 1, operatingIncome: 1, netIncome: 1 };
    const s = buildStatement(
      "X US Equity",
      "income",
      "annual",
      [
        { date: "2021-12-31", values: { interestExpense: 5 } },
        { date: "2022-12-31", values: full },
        { date: "2023-12-31", values: full },
      ],
      "Test",
    )!;
    expect(s.columns).toEqual(["2022-12-31", "2023-12-31"]);
    expect(s.rows.map((r) => r.key)).not.toContain("interestExpense");
  });

  it("orders periods, drops empty periods and empty lines", () => {
    const s = buildStatement(
      "X US Equity",
      "income",
      "annual",
      [
        { date: "2025-12-31", values: { totalRevenue: 200, netIncome: 20 } },
        { date: "2023-12-31", values: { interestIncome: 5 } },
        { date: "2024-12-31", values: { totalRevenue: 150, netIncome: null } },
      ],
      "Test",
    )!;
    expect(s.columns).toEqual(["2024-12-31", "2025-12-31"]);
    expect(s.rows.map((r) => [r.key, r.values])).toEqual([
      ["totalRevenue", [150, 200]],
      ["netIncome", [null, 20]],
    ]);
  });
});

describe("issuerKey", () => {
  it("groups listings of the same issuer", () => {
    expect(issuerKey("Vodafone Group Public Limited Company")).toBe(issuerKey("Vodafone Group Plc"));
    expect(issuerKey("Apple Inc.")).toBe("apple");
    expect(issuerKey("Vodafone Idea Limited")).not.toBe(issuerKey("Vodafone Group Plc"));
  });
});
