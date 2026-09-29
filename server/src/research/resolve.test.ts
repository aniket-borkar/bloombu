import { describe, expect, it } from "vitest";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { guessSecurity, isIsin, resolveIdentifiers } from "./resolve.js";

describe("guessSecurity", () => {
  it.each([
    ["AAPL US Equity", "AAPL US Equity"],
    ["aapl us <equity>", "AAPL US Equity"],
    ["AAPL", "AAPL US Equity"],
    ["brk/b", "BRK/B US Equity"],
    ["VOD LN", "VOD LN Equity"],
    ["VOD.L", "VOD LN Equity"],
    ["7203.T", "7203 JT Equity"],
    ["^GSPC", "SPX Index"],
    ["EURUSD=X", "EURUSD Curncy"],
    ["CL=F", "CL1 Comdty"],
    ["BTC-USD", "XBTUSD Curncy"],
    ["CL1 Comdty", "CL1 Comdty"],
    ["AAPL.O", "AAPL US Equity"],
    ["MSFT.OQ", "MSFT US Equity"],
    ["IBM.N", "IBM US Equity"],
  ])("maps %s to %s", (input, expected) => {
    expect(guessSecurity(input)).toBe(expected);
  });

  it("returns null for names, ISINs and unknown exchange codes", () => {
    expect(guessSecurity("Apple Inc")).toBeNull();
    expect(guessSecurity("US0378331005")).toBeNull();
    expect(guessSecurity("AAPL XX")).toBeNull();
    expect(guessSecurity("")).toBeNull();
  });
});

describe("isIsin", () => {
  it("checks the format and check digit", () => {
    expect(isIsin("US0378331005")).toBe(true);
    expect(isIsin("GB00BH4HKS39")).toBe(true);
    expect(isIsin(" de0007164600 ")).toBe(true);
    expect(isIsin("US0378331006")).toBe(false);
    expect(isIsin("US037833100")).toBe(false);
    expect(isIsin("AAPL")).toBe(false);
  });
});

describe("resolveIdentifiers with ISINs", () => {
  it("takes the top search result for a valid ISIN, but not for an invalid one", async () => {
    const search = async (q: string) => (q.startsWith("US03783310") ? [{ security: "AAPL US Equity", name: "Apple Inc.", exchange: "NMS", type: "EQUITY" }] : []);
    const router = new ProviderRouter([{ id: "stub", sectors: ["Equity"], quotes: async () => [], search }], () => {});
    const r = await resolveIdentifiers(router, ["US0378331005", "US0378331006"]);
    expect(r.map((x) => [x.status, x.security])).toEqual([
      ["search", "AAPL US Equity"],
      ["unresolved", null],
    ]);
    expect(r[1].candidates).toHaveLength(1);
  });
});

describe("resolveIdentifiers (mock provider)", () => {
  const router = new ProviderRouter([createMockProvider(() => Date.UTC(2026, 8, 25, 15))], () => {});

  it("prices tickers, resolves names by search, and flags the rest", async () => {
    const r = await resolveIdentifiers(router, ["AAPL", "microsoft", "ZZZZQX", "", "^GSPC"]);
    expect(r.map((x) => [x.status, x.security])).toEqual([
      ["ok", "AAPL US Equity"],
      ["search", "MSFT US Equity"],
      ["unresolved", null],
      ["empty", null],
      ["ok", "SPX Index"],
    ]);
    expect(r[0].name).toBe("Apple Inc.");
  });

  it("offers candidates for ambiguous ticker-shaped input", async () => {
    const [r] = await resolveIdentifiers(router, ["XL"]);
    expect(r.status).toBe("unresolved");
    expect(r.candidates.length).toBeGreaterThan(0);
  });
});
