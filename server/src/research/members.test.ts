import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { HistoryCache } from "../history/cache.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { INDEX_SOURCES, cellText, memberSecurity, parseMembers } from "../providers/wikipedia.js";
import type { IndexMembers, Quote, Valuation } from "../types.js";
import { runBql } from "./bql.js";
import { FieldService } from "./fields.js";
import { analyzeMembers, companyOf, registerMembersRoute } from "./members.js";

describe("Wikipedia member lists", () => {
  it("maps each index's ticker style to Bloomberg securities", () => {
    expect(memberSecurity("BRK.B", "US")).toBe("BRK/B US Equity");
    expect(memberSecurity("BT.A", "LN")).toBe("BT/A LN Equity");
    expect(memberSecurity("ADS.DE", "GY")).toBe("ADS GY Equity");
    expect(memberSecurity("ASML.AS", "GY")).toBe("ASML NA Equity");
    expect(memberSecurity("AC.PA", "FP")).toBe("AC FP Equity");
    expect(memberSecurity("SEHK: 5", "HK")).toBe("5 HK Equity");
    expect(memberSecurity("360", "AU")).toBe("360 AU Equity");
  });

  it("reads tables that contain nested tables", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td>Co ${i}</td><td>S${i}</td></tr>`).join("");
    const html = `<table class="wikitable"><tr><th>Company</th><th>Symbol</th></tr><tr><td><table><tr><td>logo</td></tr></table>Co X</td><td>X</td></tr>${rows}</table>`;
    const members = parseMembers(html, INDEX_SOURCES.INDU);
    expect(members).toHaveLength(13);
    expect(members[0]).toEqual({ security: "X US Equity", name: "Co X", sector: null });
  });

  it("finds the constituents table and cleans cell markup", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `<tr><td><a href="x">T${i}</a></td><td>Co &amp; ${i}<sup>[1]</sup></td><td>Tech</td></tr>`).join("");
    const html = `<table class="wikitable"><tr><th>Year</th><th>Close</th></tr>${rows}</table>
      <table class="wikitable" id="constituents"><tbody><tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>${rows}</tbody></table>`;
    const members = parseMembers(html, INDEX_SOURCES.SPX);
    expect(members).toHaveLength(12);
    expect(members[0]).toEqual({ security: "T0 US Equity", name: "Co & 0", sector: "Tech" });
    expect(cellText("A&#160;B &#91;2&#93; <br/>C")).toBe("A B C");
  });
});

describe("analyzeMembers", () => {
  const members: IndexMembers = {
    index: "TEST Index",
    name: "Test",
    weighting: "cap",
    source: "t",
    sourceUrl: null,
    members: [
      { security: "A US Equity", name: "A", sector: "Tech" },
      { security: "B US Equity", name: "B", sector: "Energy" },
      { security: "C US Equity", name: "C", sector: "Tech" },
    ],
  };
  const quote = (security: string, last: number, changePct: number): Quote =>
    ({ security, name: security, last, change: last - last / (1 + changePct / 100), changePct, currency: "USD" }) as Quote;
  const val = (security: string, marketCap: number) => ({ security, marketCap }) as Valuation;

  it("weights by market cap and attributes index points from yesterday's weights", () => {
    const a = analyzeMembers(
      members,
      [quote("A US Equity", 110, 10), quote("B US Equity", 50, 0)],
      [val("A US Equity", 110), val("B US Equity", 100)],
      { security: "TEST Index", last: 1050, change: 50, changePct: 5, prevClose: 1000 } as Quote,
    );
    expect(a.members.map((m) => m.security)).toEqual(["A US Equity", "B US Equity", "C US Equity"]);
    expect(a.members[0].weightPct).toBeCloseTo((110 / 210) * 100, 6);
    expect(a.members[0].points).toBeCloseTo(0.5 * 0.1 * 1000, 6);
    expect(a.members[1].points).toBe(0);
    expect(a.members[2]).toMatchObject({ weightPct: null, points: null });
    expect(a).toMatchObject({ total: 3, priced: 2, advancers: 1, decliners: 0 });
    expect(a.sectors[0]).toMatchObject({ sector: "Tech", count: 2 });
  });

  it("splits a company-wide market cap reported for each share class", () => {
    const classes: IndexMembers = {
      ...members,
      members: [
        { security: "A US Equity", name: "Alpha Inc. (Class A)", sector: null },
        { security: "B US Equity", name: "Alpha Inc. (Class C)", sector: null },
        { security: "C US Equity", name: "Gamma Corp", sector: null },
      ],
    };
    const a = analyzeMembers(
      classes,
      [quote("A US Equity", 10, 0), quote("B US Equity", 10, 0), quote("C US Equity", 10, 0)],
      [val("A US Equity", 202), val("B US Equity", 198), val("C US Equity", 100)],
      null,
    );
    expect(a.members.map((m) => [m.security, Math.round(m.weightPct!)])).toEqual([
      ["A US Equity", 34],
      ["C US Equity", 33],
      ["B US Equity", 33],
    ]);
    expect(companyOf("Alphabet Inc. Class C Capital Stock")).toBe(companyOf("Alphabet Inc. (Class A)"));
  });

  it("weights price-weighted indices by price", () => {
    const a = analyzeMembers({ ...members, weighting: "price" }, [quote("A US Equity", 300, 0), quote("B US Equity", 100, 0)], [], null);
    expect(a.members[0].weightPct).toBeCloseTo(75, 6);
    expect(a.members[0].points).toBeNull();
  });
});

describe("members route and BQL universe (mock)", () => {
  const router = new ProviderRouter([createMockProvider()], () => {});
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t));
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createApp({ router, history, routes: [(a) => registerMembersRoute(a, router)] }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("serves weights and contributions, and explains unsupported indices", async () => {
    const res = await fetch(`${base}/api/members/SPX%20Index`);
    const body = await res.json();
    expect(body).toMatchObject({ index: "SPX Index", weighting: "cap" });
    expect(body.priced).toBeGreaterThan(5);
    const total = body.members.reduce((s: number, m: { weightPct: number | null }) => s + (m.weightPct ?? 0), 0);
    expect(total).toBeCloseTo(100, 6);
    expect((await fetch(`${base}/api/members/VIX%20Index`)).status).toBe(404);
    expect((await fetch(`${base}/api/members/AAPL%20US%20Equity`)).status).toBe(400);
  });

  it("queries index members in BQL and guards per-security fields on big universes", async () => {
    const fields = new FieldService(router);
    const r = await runBql("SELECT NAME, CUR_MKT_CAP FROM members('SPX Index') ORDER BY CUR_MKT_CAP DESC LIMIT 3", null, { router, fields });
    expect(r.rows).toHaveLength(3);
    expect(r.universeSize).toBeGreaterThan(5);
    await expect(runBql("SELECT NAME FROM members('VIX Index')", null, { router, fields })).rejects.toThrow(/No member list/);
  });
});
