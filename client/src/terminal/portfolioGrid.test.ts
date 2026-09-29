import { describe, expect, it } from "vitest";
import type { Resolution } from "../api";
import { holdingsFromRows, mapPastedTable, normalizeDate, rowsFromHoldings } from "./portfolioGrid";
import { parseTable } from "./table";

const ok = (input: string, security: string): [string, Resolution] => [input, { input, security, name: security, status: "ok", candidates: [] }];

describe("mapPastedTable", () => {
  it("maps a broker-style export by header", () => {
    const table = parseTable("Symbol\tDescription\tQuantity\tAvg Cost\tDate\nAAPL\tApple\t100\t$150.00\t01/02/2024\nMSFT\tMicrosoft\t50\t300\t\n");
    expect(mapPastedTable(table, "positions")).toEqual({
      rows: [
        ["AAPL", "100", "$150.00", "01/02/2024"],
        ["MSFT", "50", "300", ""],
      ],
      suggestedKind: "positions",
      headerMapped: true,
    });
  });

  it("suggests a model portfolio for a weights-only table", () => {
    const r = mapPastedTable(parseTable("Ticker,Weight %\nSPY,60\nAGG,40"), "positions")!;
    expect(r.suggestedKind).toBe("model");
    expect(r.rows).toEqual([
      ["SPY", "60"],
      ["AGG", "40"],
    ]);
  });

  it("ignores headerless data so the grid pastes positionally", () => {
    expect(mapPastedTable(parseTable("AAPL\t100\nMSFT\t50"), "positions")).toBeNull();
  });
});

describe("normalizeDate", () => {
  it.each([
    ["2024-01-02", "2024-01-02"],
    ["1/2/2024", "2024-01-02"],
    ["01/02/24", "2024-01-02"],
    ["2024-02-30", null],
    ["yesterday", null],
  ])("%s -> %s", (input, out) => {
    expect(normalizeDate(input)).toBe(out);
  });
});

describe("holdingsFromRows", () => {
  const resolutions = new Map<string, Resolution>([
    ok("AAPL", "AAPL US Equity"),
    ok("MSFT", "MSFT US Equity"),
    ["ZZZ", { input: "ZZZ", security: null, name: null, status: "unresolved", candidates: [] }],
  ]);

  it("builds positions and reports row-level problems", () => {
    const r = holdingsFromRows(
      [
        ["AAPL", "1,000", "$150.25", "1/2/2024"],
        ["MSFT", "0", "", ""],
        ["ZZZ", "5", "", ""],
        ["", "", "", ""],
        ["NEW", "1", "", ""],
      ],
      "positions",
      resolutions,
    );
    expect(r.holdings).toEqual([{ security: "AAPL US Equity", quantity: 1000, weight: null, cost: 150.25, acquired: "2024-01-02" }]);
    expect(r.errors).toEqual([
      "Row 2: shares must be a non-zero number",
      'Row 3: could not identify "ZZZ"',
      'Row 5: still identifying "NEW"',
    ]);
  });

  it("builds model weights and round-trips through editor rows", () => {
    const r = holdingsFromRows([["AAPL", "60%"], ["MSFT", "40"]], "model", resolutions);
    expect(r.errors).toEqual([]);
    expect(rowsFromHoldings(r.holdings, "model")).toEqual([
      ["AAPL US Equity", "60"],
      ["MSFT US Equity", "40"],
    ]);
  });
});
