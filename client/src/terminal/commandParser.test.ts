import { describe, expect, it } from "vitest";
import { parseCommand, tokenize } from "./commandParser";

describe("tokenize", () => {
  it("uppercases, strips <GO> and angle brackets", () => {
    expect(tokenize("aapl us <Equity> des <GO>")).toEqual(["AAPL", "US", "EQUITY", "DES"]);
  });

  it("collapses whitespace", () => {
    expect(tokenize("   ibm    us   equity  ")).toEqual(["IBM", "US", "EQUITY"]);
  });
});

describe("parseCommand", () => {
  it("returns empty for blank input", () => {
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
    expect(parseCommand("<GO>")).toEqual({ kind: "empty" });
  });

  it("loads an equity via yellow-key text", () => {
    expect(parseCommand("AAPL US <EQUITY>")).toEqual({ kind: "load", security: "AAPL US Equity", fn: null });
  });

  it("loads an equity typed in full", () => {
    expect(parseCommand("IBM US EQUITY")).toEqual({ kind: "load", security: "IBM US Equity", fn: null });
  });

  it("defaults a bare equity ticker to the US composite", () => {
    expect(parseCommand("MSFT <EQUITY>")).toEqual({ kind: "load", security: "MSFT US Equity", fn: null });
  });

  it("loads a security together with a function", () => {
    expect(parseCommand("AAPL US <EQUITY> DES <GO>")).toEqual({ kind: "load", security: "AAPL US Equity", fn: "DES" });
  });

  it.each([
    ["EURUSD CURNCY", "EURUSD Curncy"],
    ["EURUSD <CRNCY>", "EURUSD Curncy"],
    ["SPX INDEX", "SPX Index"],
    ["CL1 <CMDTY>", "CL1 Comdty"],
    ["C 1 COMDTY", "C 1 Comdty"],
    ["CT10 GOVT", "CT10 Govt"],
    ["VOD LN EQUITY", "VOD LN Equity"],
    ["BRK/B US EQUITY", "BRK/B US Equity"],
    ["XYZ <M-MKT>", "XYZ M-Mkt"],
  ])("normalizes %s", (input, security) => {
    expect(parseCommand(input)).toEqual({ kind: "load", security, fn: null });
  });

  it("recognizes a bare mnemonic", () => {
    expect(parseCommand("wei")).toEqual({ kind: "function", fn: "WEI" });
    expect(parseCommand("DES <GO>")).toEqual({ kind: "function", fn: "DES" });
  });

  it("recognizes a menu number", () => {
    expect(parseCommand("3")).toEqual({ kind: "menuItem", index: 3 });
    expect(parseCommand("12 <GO>")).toEqual({ kind: "menuItem", index: 12 });
  });

  it("rejects a sector with no ticker", () => {
    expect(parseCommand("<EQUITY>").kind).toBe("error");
  });

  it("rejects an unknown trailing function", () => {
    expect(parseCommand("AAPL US EQUITY FOOBAR")).toEqual({ kind: "error", message: "UNKNOWN FUNCTION: FOOBAR" });
  });

  it("rejects extra tokens after the function", () => {
    expect(parseCommand("AAPL US EQUITY DES GP").kind).toBe("error");
  });

  it("routes ? questions to the AI analyst, keeping case", () => {
    expect(parseCommand("? Why is NVDA down today?")).toEqual({ kind: "ask", question: "Why is NVDA down today?" });
    expect(parseCommand("  ?compare AAPL and MSFT")).toEqual({ kind: "ask", question: "compare AAPL and MSFT" });
    expect(parseCommand("?").kind).toBe("error");
    expect(parseCommand("?? backtest a 50/200 day crossover on SPY")).toEqual({ kind: "ask", question: "backtest a 50/200 day crossover on SPY", depth: "deep" });
    expect(parseCommand(" ??  why did margins fall")).toEqual({ kind: "ask", question: "why did margins fall", depth: "deep" });
    expect(parseCommand("??").kind).toBe("error");
  });

  it("treats unknown text without a sector as a search", () => {
    expect(parseCommand("apple")).toEqual({ kind: "search", query: "APPLE" });
    expect(parseCommand("AAPL US")).toEqual({ kind: "search", query: "AAPL US" });
  });
});
