import { describe, expect, it } from "vitest";
import { FormulaError, colIndex, computeSheet, formatCell, parseFormula, type Cell, type SheetData } from "./formula";

const none: SheetData = { bdp: () => undefined, bdh: () => undefined };
const sheet = (raw: string[][], data: SheetData = none) => computeSheet(raw, data);
const show = (raw: string[][], r: number, c: number, data?: SheetData) => formatCell(sheet(raw, data).value(r, c));

describe("parser", () => {
  it("parses precedence and references", () => {
    expect(show([["=1+2*3^2"]], 0, 0)).toBe("19");
    expect(show([["=(1+2)*3"]], 0, 0)).toBe("9");
    expect(show([["=-2^2"]], 0, 0)).toBe("-4");
    expect(colIndex("A")).toBe(0);
    expect(colIndex("AA")).toBe(26);
  });

  it("rejects malformed formulas", () => {
    expect(() => parseFormula("1+")).toThrow(FormulaError);
    expect(() => parseFormula('"abc')).toThrow(FormulaError);
    expect(() => parseFormula("SUM(A1")).toThrow(FormulaError);
    expect(show([["=1+"]], 0, 0)).toMatch(/^#ERROR!/);
  });
});

describe("evaluation", () => {
  const raw = [
    ["10", "=A1*2", "=SUM(A1:B1)", "hello"],
    ["5", "=AVERAGE(A1:A2)", "=MAX(A1:A2)-MIN(A1:A2)", '=D1&" world"'],
    ["", "=COUNT(A1:D2)", "=IF(A1>A2,\"up\",\"down\")", "=ROUND(2/3,3)"],
    ["=A1/A3", "=ABS(-3)", "=D1*2", "=B4=3"],
  ];
  const s = sheet(raw);

  it("computes arithmetic, ranges and functions", () => {
    expect(s.value(0, 1)).toBe(20);
    expect(s.value(0, 2)).toBe(30);
    expect(s.value(1, 1)).toBe(7.5);
    expect(s.value(1, 2)).toBe(5);
    expect(s.value(1, 3)).toBe("hello world");
    expect(s.value(2, 1)).toBe(6);
    expect(s.value(2, 2)).toBe("up");
    expect(s.value(2, 3)).toBe(0.667);
    expect(s.value(3, 1)).toBe(3);
    expect(s.value(3, 3)).toBe(true);
  });

  it("returns spreadsheet errors", () => {
    expect(formatCell(s.value(3, 0))).toBe("#DIV/0!");
    expect(formatCell(s.value(3, 2))).toMatch(/^#VALUE!/);
    expect(show([["=NOPE(1)"]], 0, 0)).toMatch(/^#NAME\?/);
    expect(show([["=A1+1"]], 0, 0)).toBe("#CYCLE!");
    expect(show([["=B1", "=A1"]], 0, 0)).toBe("#CYCLE!");
  });

  it("treats numeric text as numbers and formats output", () => {
    expect(show([["1,234.5", "=A1*2"]], 0, 1)).toBe("2,469");
    expect(show([["1,234.5", "=A1*3"]], 0, 1)).toBe("3,703.50");
    expect(formatCell(0.12345)).toBe("0.1235");
    expect(formatCell(1500)).toBe("1,500");
    expect(formatCell(null)).toBe("");
  });
});

describe("BDP and BDH", () => {
  it("requests missing data, then uses it", () => {
    const raw = [["AAPL US Equity", '=BDP(A1,"px_last")', "=B1*10"]];
    const first = sheet(raw);
    expect(first.requests.bdp).toEqual([["AAPL US Equity", "PX_LAST"]]);
    expect(formatCell(first.value(0, 1))).toBe("#N/A Requesting Data...");
    const loaded = sheet(raw, { bdp: (s, f) => (s === "AAPL US Equity" && f === "PX_LAST" ? 200.5 : undefined), bdh: () => undefined });
    expect(loaded.value(0, 1)).toBe(200.5);
    expect(loaded.value(0, 2)).toBe(2005);
    expect(loaded.requests.bdp).toEqual([]);
  });

  it("spills history and blocks spills onto non-empty cells", () => {
    const history: Cell[][] = [
      ["2026-01-02", 100],
      ["2026-01-05", 101],
      ["2026-01-06", 102],
    ];
    const data: SheetData = { bdp: () => undefined, bdh: () => history };
    const s = sheet([['=BDH("SPX Index","PX_LAST","1mo")'], [], [], ["=SUM(B1:B3)"]], data);
    expect(s.value(0, 0)).toBe("2026-01-02");
    expect(s.value(2, 1)).toBe(102);
    expect(s.value(3, 0)).toBe(303);
    expect(s.extent).toEqual({ rows: 4, cols: 2 });
    const blocked = sheet([['=BDH("SPX Index","PX_LAST")'], ["x"]], data);
    expect(formatCell(blocked.value(0, 0))).toMatch(/^#SPILL!/);
  });
});
