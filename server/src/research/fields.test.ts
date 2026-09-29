import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { HistoryCache } from "../history/cache.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { FIELDS, FieldService, registerFieldRoutes, unknownFields } from "./fields.js";

const T = Date.UTC(2026, 8, 25, 15, 30);
const router = new ProviderRouter([createMockProvider(() => T)], () => {});
let server: Server;
let base: string;

beforeAll(async () => {
  const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
  server = createApp({ router, history, routes: [(a) => registerFieldRoutes(a, new FieldService(router))] }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("FieldService", () => {
  it("has unique field ids", () => {
    expect(new Set(FIELDS.map((f) => f.id)).size).toBe(FIELDS.length);
    expect(unknownFields(["PX_LAST", "NOPE"])).toEqual(["NOPE"]);
  });

  it("returns values from every source for each security", async () => {
    const t = await new FieldService(router).get(
      ["aapl us equity", "SPX Index"],
      ["PX_LAST", "CHG_PCT_1D", "PE_RATIO", "GICS_SECTOR_NAME", "BEST_TARGET_PRICE", "NAME"],
    );
    expect(Object.keys(t)).toEqual(["AAPL US Equity", "SPX Index"]);
    expect(t["AAPL US Equity"].PX_LAST).toBeGreaterThan(0);
    expect(t["AAPL US Equity"].PE_RATIO).toBeGreaterThan(0);
    expect(t["AAPL US Equity"].GICS_SECTOR_NAME).toBe("Technology");
    expect(t["AAPL US Equity"].BEST_TARGET_PRICE).toBeGreaterThan(0);
    expect(t["SPX Index"].NAME).toBe("S&P 500");
    expect(t["SPX Index"].PE_RATIO).toBeNull();
  });
});

describe("fields API", () => {
  it("serves the dictionary and batch values, validating input", async () => {
    const list = await (await fetch(`${base}/api/fields/list`)).json();
    expect(list.find((f: { id: string }) => f.id === "PX_LAST").description).toBe("Last price");
    const res = await fetch(`${base}/api/fields?s=AAPL%20US%20Equity,MSFT%20US%20Equity&f=px_last,cur_mkt_cap`);
    const body = await res.json();
    expect(body["MSFT US Equity"].CUR_MKT_CAP).toBeGreaterThan(0);
    const bad = await fetch(`${base}/api/fields?s=AAPL%20US%20Equity&f=PX_LAST,FOO`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("FOO");
  });
});
