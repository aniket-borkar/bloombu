import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { REPO_ROOT, loadConfig } from "../config.js";
import { HistoryCache } from "../history/cache.js";
import type { ProviderPlugin } from "../providers/DataProvider.js";
import { PLUGIN_FACTORIES, createPlugins } from "../providers/index.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { loadPlugins, pluginSpecifier, type PluginRegistry } from "./loader.js";
import { registerPluginRoutes } from "./routes.js";
import type { PluginAiTool, PluginContext, PluginFunction, TerminalPlugin } from "./sdk.js";
import { sanitizeSpec, type TableBlock } from "./spec.js";

const silent = () => {};
const ctx = (mock = true, env: Record<string, string> = {}): PluginContext => ({ mock, env, log: silent });
const fn = (over: Partial<PluginFunction> = {}): PluginFunction => ({
  code: "HELLO",
  name: "Hello",
  security: false,
  run: () => ({ blocks: [{ type: "text", text: "hi" }] }),
  ...over,
});
const load = (mods: Record<string, unknown>, reserved: string[] = []) =>
  loadPlugins(Object.keys(mods), ctx(), { baseDir: REPO_ROOT, reservedProviders: reserved, importer: async (s) => mods[s] });

describe("sanitizeSpec", () => {
  it("keeps known fields, bounds them and drops unsafe links", () => {
    const spec = sanitizeSpec({
      title: "T",
      extra: "ignored",
      blocks: [
        { type: "text", text: "hello", color: "red" },
        { type: "kv", items: [["When", new Date("2026-01-02T00:00:00Z")], ["Ok", true], ["N", Number.NaN]] },
        {
          type: "table",
          columns: [{ key: "a", label: "A", format: "number", decimals: 2, align: "right" }, { key: "b", format: "bogus" }],
          rows: [
            { a: 1.5, b: "x", url: "javascript:alert(1)", secret: "not copied" },
            { a: null, url: "https://www.sec.gov/x" },
          ],
          linkKey: "url",
        },
        { type: "series", series: [{ label: "S", points: [{ t: "2026-01-01", v: 1 }, { t: 1767312000000, v: "2" }] }] },
      ],
    });
    expect(spec.blocks[1]).toEqual({ type: "kv", title: undefined, items: [["When", "2026-01-02T00:00:00.000Z"], ["Ok", "Yes"], ["N", null]] });
    const table = spec.blocks[2] as TableBlock;
    expect(table.columns[1]).toEqual({ key: "b", label: "b", align: undefined, format: undefined, decimals: undefined });
    expect(table.rows).toEqual([
      { a: 1.5, b: "x", url: null },
      { a: null, b: null, url: "https://www.sec.gov/x" },
    ]);
    expect(spec.blocks[3]).toMatchObject({ unit: "number", series: [{ points: [{ t: Date.parse("2026-01-01"), v: 1 }, { v: null }] }] });
  });

  it("explains what is wrong", () => {
    expect(() => sanitizeSpec(null)).toThrow(/the screen must be an object/);
    expect(() => sanitizeSpec({ blocks: [{ type: "chart" }] })).toThrow(/block 1 has unknown type "chart"/);
    expect(() => sanitizeSpec({ blocks: [{ type: "kv", items: [["a", { x: 1 }]] }] })).toThrow(/item 1 value must be a string/);
    expect(() => sanitizeSpec({ blocks: [{ type: "table", columns: [], rows: [] }] })).toThrow(/at least one column/);
    expect(() => sanitizeSpec({ blocks: [{ type: "series", series: [{ label: "s", points: [{ t: "never" }] }] }] })).toThrow(/needs a time/);
  });
});

describe("loadPlugins", () => {
  it("accepts plugin objects and factories, passing the context", async () => {
    const factory = vi.fn((c: PluginContext): TerminalPlugin => ({ name: "b", version: "2.0", functions: [fn({ code: "B1" })] }));
    const reg = await load({ a: { default: { name: "a", functions: [fn()] } }, b: { default: factory } });
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ mock: true }));
    expect(reg.plugins).toEqual([
      { name: "a", version: null, source: "a", providers: [], functions: ["HELLO"], aiTools: [] },
      { name: "b", version: "2.0", source: "b", providers: [], functions: ["B1"], aiTools: [] },
    ]);
    expect([...reg.functions.keys()]).toEqual(["HELLO", "B1"]);
  });

  it("rejects invalid plugins with a message naming the plugin", async () => {
    await expect(load({ x: { default: { name: "x", functions: [fn({ code: "bad code" })] } } })).rejects.toThrow(/Plugin "x": function code "bad code"/);
    await expect(load({ x: { default: { name: "x", functions: [fn({ sectors: ["Equity"] })] } } })).rejects.toThrow(/sectors only apply to security functions/);
    await expect(load({ x: { default: { name: "x", functions: [fn({ security: true, sectors: ["Stocks" as never] })] } } })).rejects.toThrow(/sectors must be/);
    await expect(load({ x: { default: { name: "x", functions: [fn({ options: Array(10).fill("o") })] } } })).rejects.toThrow(/at most 9/);
    await expect(load({ x: { default: { name: "x" } } })).rejects.toThrow(/adds no providers, functions or AI tools/);
    await expect(load({ x: { default: { name: "x", providers: [{ id: "p", sectors: ["Equity"] }] } } })).rejects.toThrow(/implements none of/);
    await expect(load({ x: { default: { name: "x", providers: [{ id: "yahoo", sectors: [], quotes: async () => [] }] } } }, ["yahoo"])).rejects.toThrow(
      /provider id "yahoo" is already in use/,
    );
    await expect(load({ x: { default: { name: "x", functions: [fn()] } }, y: { default: { name: "y", functions: [fn()] } } })).rejects.toThrow(
      /function HELLO is already defined by plugin "x"/,
    );
    await expect(load({ x: { default: () => Promise.reject(new Error("no key")) } })).rejects.toThrow(/failed to initialize: no key/);
    await expect(
      loadPlugins(["./nowhere/plugin.mjs"], ctx(), { baseDir: REPO_ROOT }),
    ).rejects.toThrow(/Plugin "\.\/nowhere\/plugin\.mjs" not found/);
  });

  it("registers AI tools and rejects bad or clashing ones", async () => {
    const tool = (name: string, over: Partial<PluginAiTool["spec"]> = {}): PluginAiTool => ({
      spec: { name, description: `does ${name}`, parameters: { type: "object", properties: {} }, ...over },
      run: () => ({ result: { ok: true }, summary: `ran ${name}` }),
    });
    const reg = await load({ t: { default: { name: "t", aiTools: [tool("read_doc")] } } });
    expect(reg.plugins[0]).toMatchObject({ name: "t", functions: [], providers: [], aiTools: ["read_doc"] });
    expect(reg.aiTools.map((x) => [x.plugin, x.tool.spec.name])).toEqual([["t", "read_doc"]]);

    await expect(load({ t: { default: { name: "t", aiTools: [tool("Read Doc")] } } })).rejects.toThrow(/AI tool name "Read Doc" must be lowercase/);
    await expect(load({ t: { default: { name: "t", aiTools: [tool("read_doc", { description: " " })] } } })).rejects.toThrow(/needs a description/);
    await expect(load({ t: { default: { name: "t", aiTools: [tool("read_doc", { parameters: {} })] } } })).rejects.toThrow(/type "object"/);
    await expect(load({ t: { default: { name: "t", aiTools: [{ spec: tool("x").spec }] } } })).rejects.toThrow(/needs a run/);
    await expect(
      loadPlugins(["t"], ctx(), { baseDir: REPO_ROOT, reservedTools: ["run_bql"], importer: async () => ({ default: { name: "t", aiTools: [tool("run_bql")] } }) }),
    ).rejects.toThrow(/AI tool run_bql is already a built-in analyst tool/);
    await expect(load({ a: { default: { name: "a", aiTools: [tool("dup")] } }, b: { default: { name: "b", aiTools: [tool("dup")] } } })).rejects.toThrow(
      /AI tool dup is already defined by plugin "a"/,
    );
  });

  it("gives each plugin its own keys in the shared cache", async () => {
    const keys: string[] = [];
    const cache = { wrap: <T,>(key: string, _ttl: number, load: () => Promise<T>) => (keys.push(key), load()) };
    let seen: PluginContext | null = null;
    await loadPlugins(["x"], { ...ctx(), cache }, { baseDir: REPO_ROOT, importer: async () => ({ default: (c: PluginContext) => ((seen = c), { name: "x", functions: [fn()] }) }) });
    expect(await seen!.cache!.wrap("k", 1000, async () => 42)).toBe(42);
    expect(keys).toEqual(["plugin:x:k"]);
  });

  it("resolves plugin directories through package.json main", () => {
    expect(pluginSpecifier("./plugins/edgar", REPO_ROOT)).toMatch(/^file:\/\/.*\/plugins\/edgar\/index\.mjs$/);
    expect(pluginSpecifier("blmbu-plugin-x", REPO_ROOT)).toBe("blmbu-plugin-x");
  });
});

describe("createPlugins with plugin providers", () => {
  const extra: ProviderPlugin = { id: "extra", sectors: ["Equity"], quotes: async () => [] };

  it("places listed plugin providers in PROVIDERS order and appends the rest", () => {
    const config = loadConfig({ PROVIDERS: "extra,mock", PLUGINS: "./x" });
    expect(createPlugins(config, PLUGIN_FACTORIES, silent, [extra]).map((p) => p.id)).toEqual(["extra", "mock"]);
    expect(createPlugins(loadConfig({ PROVIDERS: "mock" }), PLUGIN_FACTORIES, silent, [extra]).map((p) => p.id)).toEqual(["mock", "extra"]);
  });

  it("still rejects unknown ids once plugins have loaded", () => {
    const config = loadConfig({ PROVIDERS: "mock,nope", PLUGINS: "./x" });
    expect(() => createPlugins(config, PLUGIN_FACTORIES, silent, [extra])).toThrow(/Unknown provider "nope" in PROVIDERS. Known: coinbase, yahoo, finnhub, public, mock, extra/);
    expect(() => loadConfig({ PROVIDERS: "nope" })).toThrow(/Unknown provider "nope"/);
  });
});

describe("SEC EDGAR example plugin", () => {
  afterEach(() => vi.unstubAllGlobals());

  const edgar = async (mock: boolean, env: Record<string, string> = {}) => {
    const reg = await loadPlugins(["./plugins/edgar"], ctx(mock, env), { baseDir: REPO_ROOT });
    return { cf: reg.functions.get("CF")!.fn, provider: reg.providers[0], reg };
  };
  const router = new ProviderRouter([createMockProvider()], silent);
  const run = (cf: PluginFunction, security: string, option = 0) =>
    Promise.resolve(cf.run({ security, option, router, signal: new AbortController().signal })).then(sanitizeSpec);

  it("serves offline fixture filings in mock mode", async () => {
    const { cf, reg } = await edgar(true);
    expect(reg.plugins[0]).toMatchObject({ name: "edgar", functions: ["CF"], providers: ["edgar"] });
    expect(cf.options).toEqual(["All", "Financials", "Current Reports", "Proxies", "Insiders", "Ownership", "Registrations"]);
    const all = await run(cf, "AAPL US Equity");
    const table = all.blocks[1] as TableBlock;
    expect(table.rows.length).toBe(36);
    const current = (await run(cf, "AAPL US Equity", 2)).blocks[1] as TableBlock;
    expect(current.title).toBe("Current Reports Filings (6)");
    expect(new Set(current.rows.map((r) => r.form))).toEqual(new Set(["8-K"]));
    expect(current.rows[0].description).toBe("Results of operations; Financial statements and exhibits");
    const foreign = await run(cf, "VOD LN Equity");
    expect(foreign.blocks).toEqual([{ type: "text", title: undefined, text: expect.stringMatching(/not a US listing/) }]);
  });

  it("maps tickers, sends the SEC User-Agent and builds filing links from live-format data", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["User-Agent"]).toBe("Jane Doe jane@example.com");
      if (url.endsWith("company_tickers.json")) {
        return Response.json({ 0: { cik_str: 1067983, ticker: "BRK-B", title: "BERKSHIRE HATHAWAY INC" } });
      }
      expect(url).toBe("https://data.sec.gov/submissions/CIK0001067983.json");
      return Response.json({
        cik: "0001067983",
        name: "BERKSHIRE HATHAWAY INC",
        sic: "6331",
        sicDescription: "Fire, Marine & Casualty Insurance",
        fiscalYearEnd: "1231",
        exchanges: ["NYSE", "NYSE"],
        filings: {
          recent: {
            accessionNumber: ["0000950170-26-000001", "0001193125-26-000002"],
            filingDate: ["2026-08-03", "2026-05-04"],
            reportDate: ["2026-06-30", ""],
            acceptanceDateTime: ["2026-08-03T20:05:00.000Z", "2026-05-04T12:00:00.000Z"],
            form: ["10-Q", "8-K"],
            items: ["", "5.07"],
            primaryDocument: ["brka-20260630.htm", "d123.htm"],
            primaryDocDescription: ["10-Q", "8-K"],
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { cf, provider } = await edgar(false, { SEC_USER_AGENT: "Jane Doe jane@example.com" });
    const spec = await run(cf, "BRK/B US Equity");
    expect(spec.title).toBe("BERKSHIRE HATHAWAY INC");
    expect(spec.blocks[0]).toMatchObject({ items: expect.arrayContaining([["Fiscal Year End", "Dec 31"], ["Exchanges", "NYSE"]]) });
    expect((spec.blocks[1] as TableBlock).rows).toEqual([
      { filed: "2026-08-03", form: "10-Q", description: "Quarterly report", period: "2026-06-30", url: "https://www.sec.gov/Archives/edgar/data/1067983/000095017026000001/brka-20260630.htm" },
      { filed: "2026-05-04", form: "8-K", description: "Shareholder vote results", period: null, url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526000002/d123.htm" },
    ]);
    const news = await provider.companyNews!("BRK/B US Equity");
    expect(news[1]).toEqual({
      id: "edgar-0001193125-26-000002",
      title: "BERKSHIRE HATHAWAY INC files 8-K: Shareholder vote results",
      source: "SEC EDGAR",
      time: "2026-05-04T12:00:00.000Z",
      url: "https://www.sec.gov/Archives/edgar/data/1067983/000119312526000002/d123.htm",
    });
    await run(cf, "BRK/B US Equity");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("explains an SEC 403", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const { cf } = await edgar(false);
    await expect(run(cf, "AAPL US Equity")).rejects.toThrow(/HTTP 403 \(set SEC_USER_AGENT/);
  });

  describe("AI analyst tools", () => {
    const signal = new AbortController().signal;
    const tools = async (mock = true, env: Record<string, string> = {}, cache?: PluginContext["cache"]) => {
      const reg = await loadPlugins(["./plugins/edgar"], { ...ctx(mock, env), cache }, { baseDir: REPO_ROOT });
      return Object.fromEntries(reg.aiTools.map(({ tool }) => [tool.spec.name, (args: Record<string, unknown>, maxResultChars = 8000) => Promise.resolve(tool.run(args, { router, signal, maxResultChars }))]));
    };

    it("are registered with the plugin", async () => {
      const reg = await loadPlugins(["./plugins/edgar"], ctx(), { baseDir: REPO_ROOT });
      expect(reg.plugins[0].aiTools).toEqual(["list_filings", "read_filing", "compare_filings", "get_company_facts", "get_earnings_release"]);
    });

    it("list filings by form and read a named section past the table of contents", async () => {
      const t = await tools();
      const list = (await t.list_filings({ security: "AAPL US Equity", forms: ["8-K"], limit: 2 })).result as { filings: { form: string; items: string }[] };
      expect(list.filings).toEqual([expect.objectContaining({ form: "8-K", items: "2.02,9.01" }), expect.objectContaining({ form: "8-K" })]);

      const risk = await t.read_filing({ security: "AAPL US Equity", section: "risk factors" });
      const r = risk.result as { section: { key: string; label: string }; text: string; nextOffset: number | null; sections: { key: string }[] };
      expect(r.section).toMatchObject({ key: "I-1A", label: "Item 1A" });
      expect(r.text).toContain("artificial intelligence");
      expect(r.text).not.toMatch(/Risk Factors 8/);
      expect(r.sections.map((s) => s.key)).toContain("II-7");
      expect(risk.sources![0]).toMatchObject({ label: expect.stringContaining("10-K Item 1A"), url: expect.stringMatching(/^https:\/\/www\.sec\.gov\/Archives\//) });

      const legal = await t.read_filing({ security: "AAPL", form: "10-Q", section: "legal proceedings" });
      expect(legal.summary).toMatch(/^Read Part II Item 1 of /);
      await expect(t.read_filing({ security: "AAPL US Equity", section: "item 99" })).rejects.toThrow(/No section "item 99".*Found: /);
      await expect(t.read_filing({ security: "VOD LN Equity" })).rejects.toThrow(/not a US listing/);
    });

    it("compare a section across the two latest filings", async () => {
      const t = await tools();
      const out = await t.compare_filings({ security: "AAPL US Equity" });
      const r = out.result as { counts: Record<string, number>; added: string[]; removed: string[]; reworded: { newTerms: string[] }[] };
      expect(r.counts).toEqual({ added: 1, removed: 1, reworded: 1, unchanged: 4 });
      expect(r.added[0]).toMatch(/artificial intelligence/);
      expect(r.removed[0]).toMatch(/foreign exchange/);
      expect(r.reworded[0].newTerms).toEqual(expect.arrayContaining(["semiconductors", "china"]));
      expect(out.sources).toHaveLength(2);
    });

    it("return long XBRL histories with renamed concepts, restatements and derived quarters", async () => {
      const t = await tools();
      const out = await t.get_company_facts({ security: "AAPL US Equity", metrics: ["revenue", "epsDiluted"] });
      const rev = (out.result as { metrics: Record<string, { concepts: string[]; annual: { end: string; value: number }[]; quarterly: { end: string; derived?: boolean }[] }> }).metrics.revenue;
      expect(rev.concepts).toEqual(["RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"]);
      expect(rev.annual).toHaveLength(10);
      expect(rev.annual[0].end).toBe("2016-09-30");
      expect(rev.annual.find((y) => y.end === "2024-09-30")!.value).toBeCloseTo(Math.round(50_000 * 1.08 ** 8) * 1.01, 0);
      expect(rev.quarterly.at(-1)).toEqual(expect.objectContaining({ end: "2025-09-30", derived: true }));
      await expect(t.get_company_facts({ security: "AAPL US Equity", metrics: ["ebitda"] })).rejects.toThrow(/Unknown metrics ebitda/);
    });

    it("read the latest earnings press release and page long text to fit", async () => {
      const t = await tools();
      const out = await t.get_earnings_release({ security: "AAPL US Equity" });
      const r = out.result as { document: string; url: string; text: string };
      expect(r.document).toBe("Exhibit 99.1 press release");
      expect(r.url).toMatch(/ex991-\d+\.htm$/);
      expect(r.text).toMatch(/Diluted earnings per share were \$/);
      const first = (await t.read_filing({ security: "AAPL US Equity" }, 2_000)).result as { nextOffset: number | null; text: string };
      expect(first.text.length).toBeLessThanOrEqual(2_000);
    });

    it("cache documents, so a second read makes no request", async () => {
      const html = "<html><body><p>PART I</p><p>Item 1A. Risk Factors</p><p>" + "Supply chain disruptions could hurt results. ".repeat(10) + "</p></body></html>";
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith("company_tickers.json")) return Response.json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } });
        if (url.includes("/submissions/")) {
          return Response.json({
            cik: "0000320193",
            name: "Apple Inc.",
            filings: { recent: { accessionNumber: ["0000320193-25-000079"], filingDate: ["2025-10-31"], reportDate: ["2025-09-27"], form: ["10-K"], items: [""], primaryDocument: ["aapl-20250927.htm"], primaryDocDescription: ["10-K"] } },
          });
        }
        return new Response(html, { headers: { "content-type": "text/html" } });
      });
      vi.stubGlobal("fetch", fetchMock);
      const t = await tools(false, { SEC_USER_AGENT: "Jane Doe jane@example.com" });
      const read = () => t.read_filing({ security: "AAPL US Equity", section: "1A" });
      expect(((await read()).result as { text: string }).text).toContain("Supply chain disruptions");
      await read();
      expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith("aapl-20250927.htm"))).toHaveLength(1);
    });
  });
});

describe("EDGAR filing text and facts", async () => {
  const text = await import("../../../plugins/edgar/text.mjs");
  const facts = await import("../../../plugins/edgar/facts.mjs");

  it("turns inline-XBRL HTML into lines of text", () => {
    const html = '<html><head><title>x</title></head><body><div style="display:none"><ix:header>hidden</ix:header></div><style>p{}</style><p>Item&#160;1A.&nbsp;Risk Factors</p><table><tr><td>Net sales</td><td>$ 416,161</td></tr></table><p>Apple&#8217;s &amp; more</p></body></html>';
    expect(text.htmlToText(html)).toBe("Item 1A. Risk Factors\nNet sales $ 416,161\nApple\u2019s & more");
  });

  it("finds sections by number or name, preferring the body over the table of contents", () => {
    const doc = ["Item 1A. Risk Factors 12", "Item 7. MD&A 30", "PART I", "Item 1A. Risk Factors", "Risk one is long enough to count as a paragraph.", "PART II", "Item 7. MD&A", "Sales grew."].join("\n");
    const sections = text.splitSections(doc);
    expect(text.findSection(sections, "10-K", "risk factors").text).toContain("Risk one");
    expect(text.findSection(sections, "10-K", "Item 7").key).toBe("II-7");
    expect(text.findSection(sections, "10-K", "9A")).toBeNull();
  });

  it("pages text at line breaks", () => {
    const body = Array.from({ length: 50 }, (_, i) => `line ${i} `.padEnd(40, ".")).join("\n");
    const first = text.page(body, 0, 500);
    expect(first.text.endsWith(".")).toBe(true);
    expect(first.nextOffset).toBe(first.text.length);
    expect(text.page(body, first.nextOffset, 500).offset).toBe(first.nextOffset);
    expect(text.page(body, body.length - 10, 500).nextOffset).toBeNull();
  });

  it("derives quarters from year-to-date totals without inventing any", () => {
    const e = (start: string, end: string, val: number, form = "10-Q") => ({ start, end, val, form, fp: form === "10-K" ? "FY" : "Q", filed: "2025-11-01" });
    const raw = {
      facts: {
        "us-gaap": {
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: [e("2024-10-01", "2024-12-31", 30e6), e("2024-10-01", "2025-03-31", 55e6), e("2024-10-01", "2025-06-30", 85e6), e("2024-10-01", "2025-09-30", 120e6, "10-K")] },
          },
          PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [e("2024-10-01", "2024-12-31", 3e6), e("2024-10-01", "2025-09-30", 12e6, "10-K")] } },
        },
      },
    };
    const m = facts.extractFacts(raw).metrics;
    expect(m.operatingCashFlow.quarterly).toEqual([
      { end: "2024-12-31", value: 30 },
      { end: "2025-03-31", value: 25, derived: true },
      { end: "2025-06-30", value: 30, derived: true },
      { end: "2025-09-30", value: 35, derived: true },
    ]);
    expect(m.capex.quarterly).toEqual([{ end: "2024-12-31", value: 3 }]);
  });
});

describe("plugin routes", () => {
  let server: Server;
  let base: string;
  let registry: PluginRegistry;

  beforeAll(async () => {
    const router = new ProviderRouter([createMockProvider()], silent);
    const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t));
    registry = await load({
      demo: {
        default: {
          name: "demo",
          functions: [
            fn({ code: "ECHO", security: true, sectors: ["Equity"], options: ["One", "Two"], run: ({ security, option }) => ({ blocks: [{ type: "text", text: `${security} ${option}` }] }) }),
            fn({ code: "BOOM", run: () => Promise.reject(new Error("upstream said no")) }),
            fn({ code: "JUNK", run: () => ({ blocks: [{ type: "video" }] }) as never }),
            fn({ code: "SLOW", run: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }),
          ],
        },
      },
    });
    server = createApp({ router, history, routes: [(a) => registerPluginRoutes(a, registry, router, 200)] }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };

  it("lists plugin functions", async () => {
    const { body } = await get("/api/plugins");
    expect(body.plugins[0]).toMatchObject({ name: "demo", functions: ["ECHO", "BOOM", "JUNK", "SLOW"] });
    expect(body.functions[0]).toEqual({ code: "ECHO", name: "Hello", security: true, sectors: ["Equity"], options: ["One", "Two"], plugin: "demo" });
  });

  it("runs functions with a normalized security and clamped option", async () => {
    expect((await get("/api/plugins/run/echo?security=aapl%20us%20equity&option=7")).body.blocks[0].text).toBe("AAPL US Equity 1");
    expect((await get("/api/plugins/run/ECHO?security=AAPL%20US%20Equity&option=x")).body.blocks[0].text).toBe("AAPL US Equity 0");
  });

  it("maps failures to clear statuses", async () => {
    expect(await get("/api/plugins/run/NOPE")).toEqual({ status: 404, body: { error: "UNKNOWN PLUGIN FUNCTION NOPE" } });
    expect(await get("/api/plugins/run/ECHO")).toEqual({ status: 400, body: { error: "ECHO NEEDS A SECURITY" } });
    expect(await get("/api/plugins/run/ECHO?security=SPX%20Index")).toEqual({ status: 400, body: { error: "ECHO IS AVAILABLE FOR EQUITY SECURITIES ONLY" } });
    expect(await get("/api/plugins/run/BOOM")).toEqual({ status: 502, body: { error: "upstream said no" } });
    expect((await get("/api/plugins/run/JUNK")).body.error).toMatch(/^JUNK RETURNED AN INVALID SCREEN: block 1 has unknown type/);
    expect(await get("/api/plugins/run/SLOW")).toEqual({ status: 504, body: { error: "SLOW TIMED OUT" } });
  });
});
