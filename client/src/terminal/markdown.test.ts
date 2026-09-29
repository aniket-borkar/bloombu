import { describe, expect, it } from "vitest";
import { isNumericCell, parseBlocks } from "./markdown";

describe("parseBlocks", () => {
  it("splits lines, bullets and headings", () => {
    expect(parseBlocks("## Plan\n- step one\nplain")).toEqual([
      { type: "line", bullet: false, text: "Plan" },
      { type: "line", bullet: true, text: "step one" },
      { type: "line", bullet: false, text: "plain" },
    ]);
  });

  it("reads pipe tables with a header divider", () => {
    const text = "Results:\n| Ticker | P/E |\n|---|---:|\n| AAPL | 31.4 |\n| MSFT | 27.7 |\nDone.";
    expect(parseBlocks(text)).toEqual([
      { type: "line", bullet: false, text: "Results:" },
      { type: "table", header: ["Ticker", "P/E"], rows: [["AAPL", "31.4"], ["MSFT", "27.7"]] },
      { type: "line", bullet: false, text: "Done." },
    ]);
  });

  it("keeps tables without a header, and rows still streaming in stay plain lines", () => {
    expect(parseBlocks("| a | 1 |\n| b | 2 |")).toEqual([{ type: "table", header: null, rows: [["a", "1"], ["b", "2"]] }]);
    expect(parseBlocks("| a | 1")).toEqual([{ type: "line", bullet: false, text: "| a | 1" }]);
  });
});

describe("isNumericCell", () => {
  it("recognizes numbers, percentages, amounts and multiples", () => {
    for (const cell of ["31.4", "-2.5%", "$1,234.5", "**12x**", "3.2B", "+15bp", "0.85"]) expect(isNumericCell(cell)).toBe(true);
    for (const cell of ["AAPL", "2026-09-25", "n/a", "1.2 (est)"]) expect(isNumericCell(cell)).toBe(false);
  });
});
