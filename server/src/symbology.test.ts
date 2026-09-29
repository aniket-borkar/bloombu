import { describe, expect, it } from "vitest";
import { fromYahoo, futuresContracts, parseContract, toYahoo } from "./symbology.js";

describe("toYahoo", () => {
  it.each([
    ["AAPL US Equity", "AAPL"],
    ["VOD LN Equity", "VOD.L"],
    ["700 HK Equity", "0700.HK"],
    ["BRK/B US Equity", "BRK-B"],
    ["SPX Index", "^GSPC"],
    ["EURUSD Curncy", "EURUSD=X"],
    ["JPY Curncy", "USDJPY=X"],
    ["XBTUSD Curncy", "BTC-USD"],
    ["CL1 Comdty", "CL=F"],
    ["C 1 Comdty", "ZC=F"],
    ["HG1 Comdty", "HG=F"],
    ["CT10 Govt", "^TNX"],
  ])("maps %s to %s", (bb, yahoo) => {
    expect(toYahoo(bb)).toBe(yahoo);
  });

  it("maps specific futures contracts relative to the current year", () => {
    const year = new Date().getUTCFullYear();
    const digit = year % 10;
    expect(toYahoo(`CLZ${digit} Comdty`)).toBe(`CLZ${String(year % 100).padStart(2, "0")}.NYM`);
    expect(toYahoo(`C Z${digit} Comdty`)).toBe(`ZCZ${String(year % 100).padStart(2, "0")}.CBT`);
    expect(toYahoo(`GCG${(digit + 1) % 10} Comdty`)).toBe(`GCG${String((year + 1) % 100).padStart(2, "0")}.CMX`);
  });

  it("rejects unknown instruments", () => {
    expect(toYahoo("ZZ1 Comdty")).toBeNull();
    expect(toYahoo("AAPL XX Equity")).toBeNull();
    expect(toYahoo("NOPE Index")).toBeNull();
  });
});

describe("contracts", () => {
  const now = new Date(Date.UTC(2026, 8, 27));

  it("parses contract tickers and resolves the year", () => {
    expect(parseContract("CLZ6", now)).toEqual({ root: "CL", month: 11, year: 2026 });
    expect(parseContract("C H7", now)).toEqual({ root: "C", month: 2, year: 2027 });
    expect(parseContract("CLZ5", now)).toEqual({ root: "CL", month: 11, year: 2025 });
    expect(parseContract("CL1", now)).toBeNull();
  });

  it("lists upcoming monthly contracts for a generic", () => {
    const list = futuresContracts("CL1 Comdty", now, 3);
    expect(list).toEqual([
      { security: "CLU6 Comdty", yahoo: "CLU26.NYM", month: "Sep 26" },
      { security: "CLV6 Comdty", yahoo: "CLV26.NYM", month: "Oct 26" },
      { security: "CLX6 Comdty", yahoo: "CLX26.NYM", month: "Nov 26" },
    ]);
    expect(futuresContracts("C 1 Comdty", now, 1)[0]).toEqual({ security: "C U6 Comdty", yahoo: "ZCU26.CBT", month: "Sep 26" });
    expect(futuresContracts("SPX Index", now, 3)).toEqual([]);
  });

  it("maps Yahoo contract symbols back", () => {
    expect(fromYahoo("CLZ26.NYM", "FUTURE")).toBe("CLZ6 Comdty");
    expect(fromYahoo("ZCH27.CBT", "FUTURE")).toBe("C H7 Comdty");
    expect(fromYahoo("CL=F", "FUTURE")).toBe("CL1 Comdty");
  });
});
