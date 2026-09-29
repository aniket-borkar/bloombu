import { describe, expect, it } from "vitest";
import { PortfolioStore, validatePortfolio } from "../portfolio/store.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { UserStore } from "../userstore/store.js";
import { BqlError, parseBql, runBql } from "./bql.js";
import { FieldService } from "./fields.js";

describe("parseBql", () => {
  it("parses select, universe, where, order and limit", () => {
    const q = parseBql("select name, px_last from screen('most_actives') where PE_RATIO < 30 and (CHG_PCT_1D > 0 or NAME = 'x') order by CUR_MKT_CAP desc, NAME limit 5");
    expect(q.select).toEqual(["NAME", "PX_LAST"]);
    expect(q.universe).toEqual({ fn: "screen", args: ["most_actives"] });
    expect(q.order).toEqual([
      { field: "CUR_MKT_CAP", desc: true },
      { field: "NAME", desc: false },
    ]);
    expect(q.limit).toBe(5);
    expect(q.where?.k).toBe("and");
  });

  it("supports SELECT *, negative numbers and IS NOT NULL", () => {
    const q = parseBql("SELECT * FROM wei() WHERE CHG_PCT_1D > -1.5 AND PE_RATIO IS NOT NULL");
    expect(q.select).toContain("PX_LAST");
    expect(q.where).toEqual({
      k: "and",
      a: { k: "cmp", op: ">", left: { k: "field", id: "CHG_PCT_1D" }, right: { k: "lit", v: -1.5 } },
      b: { k: "isnull", field: "PE_RATIO", negate: true },
    });
  });

  it.each([
    ["SELECT FOO FROM wei()", /Unknown field FOO/],
    ["SELECT NAME FROM nowhere()", /Unknown universe/],
    ["SELECT NAME wei()", /Expected FROM/],
    ["SELECT NAME FROM wei() LIMIT 0", /LIMIT/],
    ["SELECT NAME FROM list('AAPL US Equity' ", /Expected \)/],
    ["SELECT NAME FROM wei() WHERE NAME ~ 'x'", /Unexpected character/],
  ])("reports errors with positions: %s", (src, message) => {
    expect(() => parseBql(src)).toThrow(message);
    try {
      parseBql(src);
    } catch (e) {
      expect(e).toBeInstanceOf(BqlError);
      expect((e as BqlError).position).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("runBql (mock provider)", () => {
  const router = new ProviderRouter([createMockProvider(() => Date.UTC(2026, 8, 25, 15))], () => {});
  const fields = new FieldService(router);
  const portfolios = new PortfolioStore(":memory:");
  portfolios.create(
    "ALICE",
    validatePortfolio({ name: "Core", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 1 }, { security: "IBM US Equity", quantity: 2 }] }),
  );

  it("filters, sorts and limits screen results", async () => {
    const r = await runBql("SELECT NAME, CUR_MKT_CAP FROM screen('most_actives') WHERE CUR_MKT_CAP > 0 ORDER BY CUR_MKT_CAP DESC LIMIT 3", null, { router, fields });
    expect(r.columns).toEqual(["SECURITY", "NAME", "CUR_MKT_CAP"]);
    expect(r.rows).toHaveLength(3);
    const caps = r.rows.map((x) => x[2] as number);
    expect([...caps].sort((a, b) => b - a)).toEqual(caps);
  });

  it("queries a user's portfolio and explicit lists", async () => {
    const p = await runBql("SELECT PX_LAST FROM portfolio('core')", "ALICE", { router, fields, portfolios });
    expect(p.rows.map((x) => x[0])).toEqual(["AAPL US Equity", "IBM US Equity"]);
    await expect(runBql("SELECT PX_LAST FROM portfolio('core')", "BOB", { router, fields, portfolios })).rejects.toThrow(/No portfolio/);
    const l = await runBql("SELECT NAME FROM list('msft us equity', 'SPX Index') WHERE NAME = 's&p 500'", null, { router, fields });
    expect(l.rows).toEqual([["SPX Index", "S&P 500"]]);
  });

  it("returns nothing for comparisons against missing values", async () => {
    const r = await runBql("SELECT PE_RATIO FROM wei() WHERE PE_RATIO > 0", null, { router, fields });
    expect(r.rows).toEqual([]);
    expect(r.universeSize).toBe(25);
  });
});

describe("UserStore", () => {
  it("stores documents per user and kind", () => {
    const s = new UserStore(":memory:", () => 7);
    s.put("ALICE", "sheet", "Watch", { cells: { A1: "x" } });
    expect(s.list("ALICE", "sheet")).toEqual([{ name: "Watch", updated: 7 }]);
    expect(s.get("ALICE", "sheet", "Watch")).toEqual({ cells: { A1: "x" } });
    expect(s.get("BOB", "sheet", "Watch")).toBeNull();
    expect(s.list("ALICE", "workspace")).toEqual([]);
    expect(() => s.put("ALICE", "sheet", "Big", "x".repeat(600 * 1024))).toThrow(/larger/);
    expect(s.remove("ALICE", "sheet", "Watch")).toBe(true);
    s.close();
  });
});
