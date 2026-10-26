import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { createPlugins } from "./index.js";
import { ProviderRouter } from "./router.js";
import type { Quote } from "../types.js";

const quote = (security: string, source: string): Quote => ({
  security,
  name: security,
  last: 1,
  change: 0,
  changePct: 0,
  bid: null,
  ask: null,
  bidSize: null,
  askSize: null,
  open: null,
  high: null,
  low: null,
  prevClose: null,
  volume: null,
  currency: null,
  exchange: null,
  marketState: null,
  time: null,
  delayMinutes: null,
  source,
});

function plugin(id: string, over: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return {
    id,
    sectors: ["Equity", "Index"],
    quotes: async (secs) => secs.map((s) => quote(s, id)),
    ...over,
  };
}

const silent = () => {};

describe("ProviderRouter.quotes", () => {
  it("uses the first plugin in priority order", async () => {
    const r = new ProviderRouter([plugin("a"), plugin("b")], silent);
    const [q] = await r.quotes(["AAPL US Equity"]);
    expect(q.source).toBe("a");
  });

  it("normalizes input securities", async () => {
    const r = new ProviderRouter([plugin("a")], silent);
    const [q] = await r.quotes(["aapl us <equity>"]);
    expect(q.security).toBe("AAPL US Equity");
  });

  it("skips plugins that do not cover the sector", async () => {
    const r = new ProviderRouter([plugin("a", { sectors: ["Index"] }), plugin("b")], silent);
    const [q] = await r.quotes(["AAPL US Equity"]);
    expect(q.source).toBe("b");
  });

  it("falls back when a plugin throws", async () => {
    const r = new ProviderRouter(
      [plugin("a", { quotes: () => Promise.reject(new Error("down")) }), plugin("b")],
      silent,
    );
    expect((await r.quotes(["AAPL US Equity"]))[0].source).toBe("b");
  });

  it("falls back per security when a plugin omits results", async () => {
    const a = plugin("a", { quotes: async (secs) => secs.filter((s) => s.startsWith("AAPL")).map((s) => quote(s, "a")) });
    const b = plugin("b");
    const bSpy = vi.spyOn(b, "quotes");
    const r = new ProviderRouter([a, b], silent);
    const res = await r.quotes(["AAPL US Equity", "SPX Index"]);
    expect(Object.fromEntries(res.map((q) => [q.security, q.source]))).toEqual({
      "AAPL US Equity": "a",
      "SPX Index": "b",
    });
    expect(bSpy).toHaveBeenCalledWith(["SPX Index"]);
  });

  it("throws when every plugin fails", async () => {
    const r = new ProviderRouter([plugin("a", { quotes: () => Promise.reject(new Error("down")) })], silent);
    await expect(r.quotes(["AAPL US Equity"])).rejects.toThrow("down");
  });

  it("returns empty (not an error) when securities are simply unknown", async () => {
    const r = new ProviderRouter([plugin("a", { quotes: async () => [] })], silent);
    expect(await r.quote("ZZZZ US Equity")).toBeNull();
  });

  it("ignores unparseable securities", async () => {
    const r = new ProviderRouter([plugin("a")], silent);
    expect(await r.quotes(["not a security"])).toEqual([]);
  });
});

describe("ProviderRouter search, history, streaming, describe", () => {
  it("search falls through empty and failing plugins", async () => {
    const r = new ProviderRouter(
      [
        plugin("a", { search: async () => [] }),
        plugin("b", { search: () => Promise.reject(new Error("x")) }),
        plugin("c", { search: async () => [{ security: "X US Equity", name: "X", sector: "Equity", exchange: null }] }),
      ],
      silent,
    );
    expect((await r.search("x"))[0].security).toBe("X US Equity");
  });

  it("history uses only sector-eligible plugins", async () => {
    const bar = { t: 0, o: 1, h: 1, l: 1, c: 1, v: null };
    const r = new ProviderRouter(
      [plugin("a", { sectors: ["Index"], history: async () => [bar] }), plugin("b", { history: async () => [{ ...bar, c: 2 }] })],
      silent,
    );
    expect((await r.history("AAPL US Equity", "1d", new Date(0), new Date()))[0].c).toBe(2);
  });

  it("streamingPlugin returns the quoting plugin only if it can push", () => {
    const pusher = plugin("p", { sectors: ["Equity"], subscribe: () => () => {} });
    const r = new ProviderRouter([pusher, plugin("b")], silent);
    expect(r.streamingPlugin("AAPL US Equity")?.id).toBe("p");
    expect(r.streamingPlugin("SPX Index")).toBeNull();
  });

  it("describe lists capabilities", () => {
    const r = new ProviderRouter([plugin("a", { search: async () => [] })], silent);
    expect(r.describe()).toEqual([{ id: "a", capabilities: ["quotes", "search"], sectors: ["Equity", "Index"] }]);
  });
});

describe("createPlugins", () => {
  it("skips providers whose key is missing and warns", () => {
    const warn = vi.fn();
    const plugins = createPlugins(loadConfig({ PROVIDERS: "finnhub,mock" }), undefined, warn);
    expect(plugins.map((p) => p.id)).toEqual(["mock"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("FINNHUB_API_KEY"));
  });

  it("includes keyed providers when the key is set", () => {
    const plugins = createPlugins(loadConfig({ PROVIDERS: "finnhub,mock", FINNHUB_API_KEY: "k" }), undefined, silent);
    expect(plugins.map((p) => p.id)).toEqual(["finnhub", "mock"]);
  });

  it("configures independent crypto streams without credentials and leaves stocks to snapshots", () => {
    const complete = createPlugins(loadConfig({ PROVIDERS: "kraken,coinbase,mock" }), undefined, silent);
    const router = new ProviderRouter(complete, silent);
    expect(complete.map((p) => p.id)).toEqual(["kraken", "coinbase", "mock"]);
    expect(router.streamingPlugin("XBTUSD Curncy")?.id).toBe("kraken");
    expect(router.streamingPlugin("AAPL US Equity")).toBeNull();
    expect(router.streamingPlugin("VOD LN Equity")).toBeNull();
  });

  it("keeps explicit mock-only configurations isolated even when free credentials exist", () => {
    const plugins = createPlugins(loadConfig({ PROVIDERS: "mock", FINNHUB_API_KEY: "key" }), undefined, silent);
    expect(plugins.map((p) => p.id)).toEqual(["mock"]);
  });

  it("fails when no provider is usable", () => {
    expect(() => createPlugins(loadConfig({ PROVIDERS: "finnhub" }), undefined, silent)).toThrow(/No data providers/);
  });
});
