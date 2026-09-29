import { describe, expect, it } from "vitest";
import { mapPastedTable } from "./portfolioGrid";
import { columnName, mapHeader, parseNumber, parseTable, toHtmlTable, toTsv } from "./table";

describe("parseTable", () => {
  it("parses Excel TSV with a trailing newline and CRLF", () => {
    expect(parseTable("Ticker\tShares\r\nAAPL\t100\r\nMSFT\t50\r\n")).toEqual([
      ["Ticker", "Shares"],
      ["AAPL", "100"],
      ["MSFT", "50"],
    ]);
  });

  it("parses quoted TSV cells", () => {
    expect(parseTable('"Apple, Inc."\t"say ""hi"""')).toEqual([["Apple, Inc.", 'say "hi"']]);
  });

  it("parses CSV with quotes and commas", () => {
    expect(parseTable('security,qty,cost\n"BRK/B US Equity","1,000",410.5\nAAPL,10,')).toEqual([
      ["security", "qty", "cost"],
      ["BRK/B US Equity", "1,000", "410.5"],
      ["AAPL", "10", ""],
    ]);
  });

  it("treats a single column as one cell per line", () => {
    expect(parseTable("AAPL\nMSFT\n")).toEqual([["AAPL"], ["MSFT"]]);
    expect(parseTable("")).toEqual([]);
  });
});

describe("clipboard output", () => {
  it("round-trips TSV including special characters", () => {
    const rows = [
      ["a\tb", 'q"x'],
      ["1", "2"],
    ];
    expect(parseTable(toTsv(rows))).toEqual(rows);
  });

  it("escapes HTML", () => {
    expect(toHtmlTable([["<b>&"]])).toBe("<table><tr><td>&lt;b&gt;&amp;</td></tr></table>");
  });
});

describe("mapHeader", () => {
  const aliases = { security: ["ticker", "security", "symbol"], quantity: ["shares", "qty", "quantity"], cost: ["cost", "avg cost"] };

  it("maps header names case- and punctuation-insensitively", () => {
    expect(mapHeader(["Symbol", "Avg. Cost", "Qty"], aliases)).toEqual({ security: 0, cost: 1, quantity: 2 });
  });

  it("prefers earlier aliases over earlier columns", () => {
    expect(mapHeader(["Symbol", "Ticker", "Shares"], aliases)).toEqual({ security: 1, quantity: 2 });
    expect(mapPastedTable(parseTable("Name\tISIN\tTicker\tShares\nApple\tUS0378331005\tAAPL\t10"), "positions")!.rows[0]).toEqual(["AAPL", "10", "", ""]);
    expect(mapPastedTable(parseTable("Name\tISIN\tShares\nApple\tUS0378331005\t10"), "positions")!.rows[0]).toEqual(["US0378331005", "10", "", ""]);
  });

  it("rejects data rows and mostly-unknown headers", () => {
    expect(mapHeader(["AAPL", "100", "150"], aliases)).toBeNull();
    expect(mapHeader(["Foo", "Bar", "Ticker"], aliases)).toBeNull();
    expect(mapHeader(["", ""], aliases)).toBeNull();
  });
});

describe("helpers", () => {
  it("parses spreadsheet numbers", () => {
    expect(parseNumber("1,234.5")).toBe(1234.5);
    expect(parseNumber("$12")).toBe(12);
    expect(parseNumber("(3.2)")).toBe(-3.2);
    expect(parseNumber("45%")).toBe(45);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber(" ")).toBeNull();
  });

  it("names columns like a spreadsheet", () => {
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(["A", "Z", "AA", "AB", "ZZ", "AAA"]);
  });
});
