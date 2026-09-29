import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../config.js";
import { HistoryCache } from "../history/cache.js";
import { loadPlugins } from "../plugins/loader.js";
import { PortfolioService } from "../portfolio/service.js";
import { PortfolioStore } from "../portfolio/store.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { UNIVERSES } from "../research/bql.js";
import { FIELDS, FieldService } from "../research/fields.js";
import { PaperBroker } from "../trading/paper.js";
import { TOOL_BY_NAME, ToolError, ruleHistory, type RuleHistory, type ToolContext } from "./tools.js";

const T = Date.UTC(2026, 8, 25, 15, 30);
const router = new ProviderRouter([createMockProvider(() => T)], () => {});
const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
const portfolios = new PortfolioStore(":memory:");
const base: ToolContext = { router, fields: new FieldService(router), history, portfolios, portfolioService: new PortfolioService(router, history, () => T), user: "ALICE", now: () => T };
const run = (name: string, args: Record<string, unknown> = {}, ctx: ToolContext = base) => TOOL_BY_NAME.get(name)!.run(args, ctx);

describe("tool sources", () => {
  it("say where prices, statements, curves and headlines came from", async () => {
    const hist = await run("get_price_history", { security: "AAPL US Equity", range: "3mo" });
    expect(hist.sources).toEqual([{ label: "AAPL US Equity daily prices (3mo)", asOf: expect.stringMatching(/^2026-09-2\d$/) }]);
    const curve = await run("get_yield_curve");
    expect(curve.sources![0]).toMatchObject({ label: expect.stringContaining("Treasury"), asOf: expect.any(String) });
    const fs = await run("get_financials", { security: "AAPL US Equity" });
    expect(fs.sources![0].label).toMatch(/AAPL US Equity annual income statement$/);
    const news = await run("get_news", { security: "AAPL US Equity" });
    expect(news.sources!.length).toBeGreaterThan(0);
    expect(news.sources!.length).toBeLessThanOrEqual(5);
  });
});

describe("plain-English screens", () => {
  it("describes BQL from the field dictionary and universes", () => {
    const description = TOOL_BY_NAME.get("run_bql")!.spec.description;
    for (const f of FIELDS) expect(description).toContain(f.id);
    for (const u of UNIVERSES) expect(description).toContain(`${u}(`);
    expect(description).toContain("members('SPX Index')");
  });

  it("runs queries, points at syntax errors and hands the query to BQL", async () => {
    const query = "SELECT NAME, PE_RATIO FROM list('AAPL US Equity', 'MSFT US Equity') ORDER BY PE_RATIO";
    const out = await run("run_bql", { query });
    expect(out.result).toMatchObject({ columns: ["SECURITY", "NAME", "PE_RATIO"], totalRows: 2, universeSize: 2 });
    expect(out.action).toEqual({ type: "open_bql", query });
    await expect(run("run_bql", { query: "SELECT NAME, PE FROM wei()" })).rejects.toThrow(/Unknown field PE .*at character 14: "PE FROM wei\(\)"/);
  });
});

describe("plain-English alerts", () => {
  it("drafts alerts with a past-year check for the user to confirm", async () => {
    const out = await run("draft_alert", { security: "AAPL US Equity", kind: "rule", expr: "crossAbove(close, sma(close, 20))", note: "trend turn" });
    expect(out.action).toEqual({
      type: "draft_alert",
      alert: { security: "AAPL US Equity", kind: "rule", value: null, expr: "crossAbove(close, sma(close, 20))", note: "trend turn" },
      label: "AAPL US Equity rule: crossAbove(close, sma(close, 20))",
    });
    const r = out.result as { pastYear: { timesMet: number; metNow: boolean } };
    expect(r.pastYear.timesMet).toBeGreaterThan(0);
    expect(typeof r.pastYear.metNow).toBe("boolean");
    const level = await run("draft_alert", { security: "AAPL US Equity", kind: "above", value: 1 });
    expect((level.result as { pastYear: { metNow: boolean } }).pastYear.metNow).toBe(true);
  });

  it("rejects alerts the server would refuse", async () => {
    await expect(run("draft_alert", { security: "AAPL US Equity", kind: "pct_down", value: 0 })).rejects.toThrow(/positive number/);
    await expect(run("draft_alert", { security: "AAPL US Equity", kind: "rule", expr: "close >" })).rejects.toThrow(/^Rule: /);
  });
});

describe("quant tools", () => {
  it("backtests a rule across securities with an out-of-sample split and hands it to BTST", async () => {
    const out = await run("run_backtest", {
      securities: ["AAPL US Equity", "MSFT US Equity"],
      entry: "close > sma(close, 50)",
      exit: "close < sma(close, 50)",
      range: "2y",
      oosFrom: "2025-10-01",
    });
    const r = out.result as {
      results: { security: string; full: { trades: number }; inSample?: { trades: number }; outOfSample?: { trades: number } }[];
      acrossSecurities: { beatBuyAndHold: string };
    };
    expect(r.results.map((x) => x.security)).toEqual(["AAPL US Equity", "MSFT US Equity"]);
    expect(r.results[0].full.trades).toBeGreaterThan(0);
    expect(r.results[0].inSample).toBeDefined();
    expect(r.results[0].outOfSample).toBeDefined();
    expect(r.acrossSecurities.beatBuyAndHold).toMatch(/ of 2$/);
    expect(out.action).toEqual({
      type: "open_backtest",
      security: "AAPL US Equity",
      entry: "close > sma(close, 50)",
      exit: "close < sma(close, 50)",
      direction: "long",
      costBps: 5,
      range: "2y",
    });
    expect(out.sources).toHaveLength(2);
  });

  it("explains rule and date mistakes so the model can fix them", async () => {
    await expect(run("run_backtest", { securities: ["AAPL US Equity"], entry: "close >> 5" })).rejects.toThrow(/^Entry rule: .*at character \d+/);
    await expect(run("run_backtest", { securities: ["AAPL US Equity"], entry: "close > 1", oosFrom: "someday" })).rejects.toThrow(/oosFrom/);
    await expect(run("evaluate_rule", { security: "AAPL US Equity", rule: "sma(close)" })).rejects.toBeInstanceOf(ToolError);
  });

  it("analyzes returns against a benchmark and extra factors", async () => {
    const out = await run("analyze_returns", { securities: ["AAPL US Equity", "MSFT US Equity"], factors: ["XLK US Equity"], range: "1y" });
    const r = out.result as {
      benchmark: string;
      tradingDays: number;
      securities: { security: string; beta: number; annualizedVolPct: number; factorModel: { loadings: { factor: string; tStat: number | null }[] } }[];
      correlations: { order: string[]; matrix: number[][] };
    };
    expect(r.benchmark).toBe("SPX Index");
    expect(r.tradingDays).toBeGreaterThan(200);
    expect(r.securities[0]).toMatchObject({ security: "AAPL US Equity", beta: expect.any(Number), annualizedVolPct: expect.any(Number) });
    expect(r.securities[0].factorModel.loadings.map((l) => l.factor)).toEqual(["SPX Index", "XLK US Equity"]);
    expect(r.correlations.order).toEqual(["AAPL US Equity", "MSFT US Equity"]);
    expect(r.correlations.matrix[0][0]).toBe(1);
    expect(Math.abs(r.correlations.matrix[0][1])).toBeLessThanOrEqual(1);
    expect(out.sources![0].label).toContain("SPX Index");
  });

  it("reports when a rule fired and what followed", async () => {
    const out = await run("evaluate_rule", { security: "AAPL US Equity", rule: "crossAbove(close, sma(close, 20))", range: "1y" });
    const r = out.result as RuleHistory;
    expect(r.timesFired).toBeGreaterThan(0);
    expect(r.forwardReturns.map((f) => f.days)).toEqual([5, 20]);
    expect(typeof r.trueNow).toBe("boolean");
  });

  it("computes rule history exactly on known bars", () => {
    const closes = [99, 101, 102, 99, 103, 104, 105, 106, 107, 108, 109];
    const bars = closes.map((c, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86_400_000, o: c, h: c, l: c, c, v: null }));
    const h = ruleHistory("close > 100", bars);
    expect(h.daysTrue).toBe(9);
    expect(h.timesFired).toBe(2);
    expect(h.recentFirings.map((f) => f.date)).toEqual(["2026-01-02", "2026-01-05"]);
    expect(h.lastFired).toBe("2026-01-05");
    expect(h.forwardReturns[0]).toMatchObject({ days: 5, samples: 2, winRatePct: 100 });
    expect(h.forwardReturns[0].avgPct).toBeCloseTo(((105 / 101 - 1 + 108 / 103 - 1) / 2) * 100, 1);
    expect(h.forwardReturns[1]).toMatchObject({ days: 20, samples: 0, avgPct: null });
    expect(h.trueNow).toBe(true);
  });
});

describe("analyst tools for index members, rates, forwards, paper and plugins", () => {
  it("summarizes index members with contributors", async () => {
    const out = (await run("get_index_members", { index: "SPX Index" })).result as { topWeights: unknown[]; topContributors: unknown[]; weighting: string };
    expect(out.weighting).toBe("cap");
    expect(out.topWeights.length).toBeGreaterThan(3);
    await expect(run("get_index_members", { index: "VIX Index" })).rejects.toBeInstanceOf(ToolError);
  });

  it("reports the priced Fed path and FX forwards", async () => {
    const rates = (await run("get_rate_expectations")).result as { currentRatePct: number; meetings: { probabilityPct: number }[] };
    expect(rates.currentRatePct).toBe(3.88);
    expect(rates.meetings).toHaveLength(8);
    const fwd = (await run("get_fx_forwards", { pair: "EURUSD Curncy" })).result as { forwards: { tenor: string }[] };
    expect(fwd.forwards.map((f) => f.tenor)).toEqual(["1W", "2W", "1M", "2M", "3M", "6M", "9M", "1Y"]);
    await expect(run("get_fx_forwards", { pair: "USDMXN Curncy" })).rejects.toThrow(/NO FREE OVERNIGHT RATE FOR MXN/);
  });

  it("reads the user's paper account only when paper trading is available", async () => {
    await expect(run("get_paper_account")).rejects.toThrow(/not available/);
    const paper = new PaperBroker(":memory:", router, portfolios, () => {}, () => T);
    await paper.place("ALICE", { security: "AAPL US Equity", side: "buy", quantity: 3 });
    const out = (await run("get_paper_account", {}, { ...base, paper })).result as { positions: { security: string; quantity: number }[] };
    expect(out.positions).toEqual([expect.objectContaining({ security: "AAPL US Equity", quantity: 3 })]);
  });

  it("runs plugin functions and trims their tables", async () => {
    const plugins = await loadPlugins(["./plugins/edgar"], { mock: true, env: {}, log: () => {} }, { baseDir: REPO_ROOT });
    const out = (await run("run_plugin_function", { code: "cf", security: "AAPL US Equity", option: 2 }, { ...base, plugins })).result as {
      options: string[];
      blocks: { type: string; rows?: unknown[]; totalRows?: number }[];
    };
    expect(out.options[2]).toBe("Current Reports");
    const table = out.blocks.find((b) => b.type === "table")!;
    expect(table.totalRows).toBe(6);
    await expect(run("run_plugin_function", { code: "NOPE" }, { ...base, plugins })).rejects.toThrow(/Available: CF/);
  });
});
