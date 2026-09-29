import { ALERT_KINDS, AlertValidationError, alertRule, describeAlert, validateAlert, type AlertInput } from "../alerts/alerts.js";
import type { HistoryCache } from "../history/cache.js";
import { RANGE_MS, type Range } from "../history/ranges.js";
import type { PortfolioService } from "../portfolio/service.js";
import { validatePortfolio, type PortfolioStore } from "../portfolio/store.js";
import type { ProviderRouter } from "../providers/router.js";
import { backtest, type BacktestStats } from "../research/backtest.js";
import { BqlError, bqlGuide, parseBql, runBql, type BqlDeps } from "../research/bql.js";
import { FIELDS, unknownFields, type FieldService } from "../research/fields.js";
import { RULE_FUNCTIONS, RuleError, ruleSignal } from "../research/rules.js";
import { alignedReturns, correlation, correlationMatrix, mean, ols, returnStats, type ReturnStats } from "../research/stats.js";
import { normalizeSecurity } from "../symbology.js";
import { SCREENS, type PortfolioInput, type ScreenId, type Statement, type StatementPeriod } from "../types.js";
import type { PluginRegistry } from "../plugins/loader.js";
import { sanitizeSpec } from "../plugins/spec.js";
import { ForwardError, forwardsFor } from "../research/forwards.js";
import { membersFor } from "../research/members.js";
import { rateProbabilities } from "../research/wirp.js";
import type { PaperBroker } from "../trading/paper.js";
import type { Bar, Headline, MemberRow } from "../types.js";
import type { ToolSpec } from "./llm.js";

export type ClientAction =
  | { type: "open"; security: string | null; fn: string }
  | { type: "draft_portfolio"; portfolio: PortfolioInput }
  | { type: "open_backtest"; security: string; entry: string; exit: string; direction: "long" | "short"; costBps: number; range: BacktestRange }
  | { type: "open_bql"; query: string }
  | { type: "draft_alert"; alert: AlertInput; label: string };

export const BACKTEST_RANGES = ["1y", "2y", "5y"] as const;
export type BacktestRange = (typeof BACKTEST_RANGES)[number];

export interface ToolContext {
  router: ProviderRouter;
  fields: FieldService;
  history: HistoryCache;
  portfolios: PortfolioStore;
  portfolioService: PortfolioService;
  user: string | null;
  now: () => number;
  plugins?: PluginRegistry;
  paper?: PaperBroker;
  /** Characters of each tool result the model will see (depends on quick or deep research). */
  maxResultChars?: number;
}

/** Where a tool's figures came from, listed under the answer. */
export interface Source {
  label: string;
  url?: string;
  /** Date or timestamp of the data, ISO format. */
  asOf?: string;
}

export interface ToolOutput {
  result: unknown;
  summary: string;
  action?: ClientAction;
  sources?: Source[];
}

export interface ToolDef {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export class ToolError extends Error {}

/** The list shapes small models send instead of JSON arrays: "A", "A, B", '["A", "B"]', "['A', 'B']". */
function looseList(v: string): unknown[] {
  const t = v.trim();
  if (t.startsWith("[")) {
    for (const candidate of [t, t.replace(/'/g, '"')]) {
      try {
        const parsed: unknown = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // Try the next form.
      }
    }
  }
  return t
    .split(",")
    .map((s) => s.replace(/^[\s'"[]+|[\s'"\]]+$/g, ""))
    .filter(Boolean);
}

/** Convert string arguments to the array and number types the tool's schema declares. */
export function coerceArgs(spec: ToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  const props = (spec.parameters as { properties?: Record<string, { type?: string }> }).properties ?? {};
  const out = { ...args };
  for (const [key, schema] of Object.entries(props)) {
    const v = out[key];
    if (typeof v !== "string") continue;
    const n = Number(v.replace(/,/g, "").trim());
    if (schema.type === "array") out[key] = looseList(v);
    else if (schema.type === "number" && v.trim() && Number.isFinite(n)) out[key] = n;
  }
  return out;
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`${name} is required`);
  return v.trim();
};
const security = (v: unknown): string => {
  const s = normalizeSecurity(str(v, "security"));
  if (!s) throw new ToolError(`"${String(v)}" is not a security; use Bloomberg format like "AAPL US Equity" (search_securities can find it)`);
  return s;
};
const securities = (v: unknown, max = 25): string[] => {
  if (!Array.isArray(v) || !v.length) throw new ToolError("securities must be a non-empty list");
  return v.slice(0, max).map(security);
};
const round = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

const headlineSources = (news: Headline[]): Source[] =>
  news.slice(0, 5).map((h) => ({ label: `${h.source}: ${h.title}`, ...(h.url ? { url: h.url } : {}), ...(h.time ? { asOf: h.time } : {}) }));

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const RULE_HELP = `Rules use close, open, high, low, volume, numbers, comparisons, and/or/not and: ${RULE_FUNCTIONS.join(", ")}.`;

async function dailyBars(ctx: ToolContext, s: string, range: Range, min = 30): Promise<Bar[]> {
  const now = ctx.now();
  const bars = await ctx.history.get(s, "1d", now - RANGE_MS[range], now);
  if (bars.length < min) throw new ToolError(`Not enough daily history for ${s} (${bars.length} bars over ${range})`);
  return bars;
}

function signals(label: string, src: string, bars: Bar[]): boolean[] {
  try {
    return ruleSignal(src, bars);
  } catch (e) {
    if (e instanceof RuleError) throw new ToolError(`${label}: ${e.message} (at character ${e.position + 1}). ${RULE_HELP}`);
    throw e;
  }
}

export interface RuleHistory {
  daysTrue: number;
  pctOfDaysTrue: number | null;
  timesFired: number;
  trueNow: boolean;
  lastFired: string | null;
  recentFirings: { date: string; close: number | null }[];
  forwardReturns: { days: number; samples: number; avgPct: number | null; winRatePct: number | null }[];
}

/** When a rule was true on daily bars, when it started being true ("fired"), and what followed. */
export function ruleHistory(src: string, bars: Bar[]): RuleHistory {
  const sig = signals("Rule", src, bars);
  const fired = sig.flatMap((v, i) => (v && i > 0 && !sig[i - 1] ? [i] : []));
  const forward = (days: number) => {
    const rets = fired.filter((i) => i + days < bars.length).map((i) => bars[i + days].c / bars[i].c - 1);
    return {
      days,
      samples: rets.length,
      avgPct: rets.length ? round(mean(rets) * 100, 2) : null,
      winRatePct: rets.length ? round((rets.filter((r) => r > 0).length / rets.length) * 100, 1) : null,
    };
  };
  const daysTrue = sig.filter(Boolean).length;
  return {
    daysTrue,
    pctOfDaysTrue: round((daysTrue / sig.length) * 100, 1),
    timesFired: fired.length,
    trueNow: sig.at(-1) ?? false,
    lastFired: fired.length ? isoDay(bars[fired.at(-1)!].t) : null,
    recentFirings: fired.slice(-10).map((i) => ({ date: isoDay(bars[i].t), close: round(bars[i].c) })),
    forwardReturns: [forward(5), forward(20)],
  };
}

const slimBacktest = (s: BacktestStats) => ({
  totalReturnPct: round(s.totalReturnPct, 2),
  buyHoldReturnPct: round(s.buyHoldReturnPct, 2),
  cagrPct: round(s.cagrPct, 2),
  volatilityPct: round(s.volatilityPct, 2),
  sharpe: round(s.sharpe, 2),
  maxDrawdownPct: round(s.maxDrawdownPct, 2),
  trades: s.trades,
  winRatePct: round(s.winRatePct, 1),
  avgTradePct: round(s.avgTradePct, 2),
  exposurePct: round(s.exposurePct, 1),
});

const slimReturns = (s: ReturnStats) => ({
  totalReturnPct: round(s.totalReturnPct, 2),
  annualizedReturnPct: round(s.annualizedReturnPct, 2),
  annualizedVolPct: round(s.annualizedVolPct, 2),
  sharpe: round(s.sharpe, 2),
  maxDrawdownPct: round(s.maxDrawdownPct, 2),
  skew: round(s.skew, 2),
  excessKurtosis: round(s.excessKurtosis, 2),
  worstDayPct: round(s.worstDayPct, 2),
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

const SEC = { type: "string", description: 'Bloomberg-style security, e.g. "AAPL US Equity", "SPX Index", "EURUSD Curncy", "CL1 Comdty"' };
const RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y"];

export const TOOLS: ToolDef[] = [
  {
    spec: {
      name: "search_securities",
      description: "Find securities by company name or ticker. Returns Bloomberg-style securities.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    async run(args, ctx) {
      const results = (await ctx.router.search(str(args.query, "query"))).slice(0, 8);
      return { result: results, summary: `Searched "${args.query}" (${results.length} results)` };
    },
  },
  {
    spec: {
      name: "get_fields",
      description: `Current values of data fields for up to 25 securities. Fields: ${FIELDS.map((f) => f.id).join(", ")}.`,
      parameters: {
        type: "object",
        properties: { securities: { type: "array", items: SEC }, fields: { type: "array", items: { type: "string" } } },
        required: ["securities", "fields"],
      },
    },
    async run(args, ctx) {
      const secs = securities(args.securities);
      const fields = (Array.isArray(args.fields) ? args.fields : []).map((f) => String(f).toUpperCase()).slice(0, 20);
      if (!fields.length) throw new ToolError("fields must be a non-empty list");
      const unknown = unknownFields(fields);
      if (unknown.length) throw new ToolError(`Unknown fields ${unknown.join(", ")}. Valid: ${FIELDS.map((f) => f.id).join(", ")}`);
      return { result: await ctx.fields.get(secs, fields), summary: `Fetched ${fields.join(", ")} for ${secs.join(", ")}` };
    },
  },
  {
    spec: {
      name: "get_price_history",
      description: "Daily price history summary: return, high/low, volatility and sampled closes.",
      parameters: { type: "object", properties: { security: SEC, range: { type: "string", enum: RANGES } }, required: ["security"] },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const range = (RANGES.includes(String(args.range)) ? String(args.range) : "1y") as Range;
      const now = ctx.now();
      const bars = await ctx.history.get(s, "1d", now - RANGE_MS[range], now);
      if (bars.length < 2) throw new ToolError(`No price history for ${s}`);
      const closes = bars.map((b) => b.c);
      const rets = closes.slice(1).map((c, i) => c / closes[i] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(rets.length - 1, 1)) * Math.sqrt(252);
      const step = Math.max(1, Math.floor(bars.length / 24));
      const end = new Date(bars[bars.length - 1].t).toISOString().slice(0, 10);
      return {
        summary: `Loaded ${range} history for ${s}`,
        sources: [{ label: `${s} daily prices (${range})`, asOf: end }],
        result: {
          security: s,
          range,
          start: new Date(bars[0].t).toISOString().slice(0, 10),
          end,
          firstClose: round(closes[0]),
          lastClose: round(closes[closes.length - 1]),
          returnPct: round((closes[closes.length - 1] / closes[0] - 1) * 100, 2),
          high: round(Math.max(...bars.map((b) => b.h))),
          low: round(Math.min(...bars.map((b) => b.l))),
          annualizedVolPct: round(vol * 100, 2),
          sampledCloses: bars.filter((_, i) => i % step === 0).map((b) => [new Date(b.t).toISOString().slice(0, 10), round(b.c)]),
        },
      };
    },
  },
  {
    spec: {
      name: "get_profile",
      description: "Company description and key statistics (sector, market cap, valuation, dividend, 52-week range).",
      parameters: { type: "object", properties: { security: SEC }, required: ["security"] },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const p = await ctx.router.first("profile", s, (pl) => pl.profile!(s));
      if (!p) throw new ToolError(`No profile for ${s}`);
      const { officers, summary, ...rest } = p;
      return { result: { ...rest, summary: summary?.slice(0, 700) ?? null, officers: officers.slice(0, 5) }, summary: `Loaded profile for ${s}` };
    },
  },
  {
    spec: {
      name: "get_financials",
      description: "Financial statements (income, balance, cashflow), annual or quarterly.",
      parameters: {
        type: "object",
        properties: { security: SEC, statement: { type: "string", enum: ["income", "balance", "cashflow"] }, period: { type: "string", enum: ["annual", "quarterly"] } },
        required: ["security"],
      },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const statement = (["income", "balance", "cashflow"].includes(String(args.statement)) ? args.statement : "income") as Statement;
      const period = (args.period === "quarterly" ? "quarterly" : "annual") as StatementPeriod;
      const fs = await ctx.router.first("financials", s, (pl) => pl.financials!(s, statement, period));
      if (!fs) throw new ToolError(`No ${statement} statement for ${s}`);
      return {
        result: fs,
        summary: `Loaded ${period} ${statement} statement for ${s}`,
        sources: [{ label: `${fs.source}: ${s} ${period} ${statement} statement`, asOf: fs.columns.at(-1) }],
      };
    },
  },
  {
    spec: {
      name: "get_estimates",
      description: "Consensus EPS and revenue estimates, recent earnings surprises, next report date.",
      parameters: { type: "object", properties: { security: SEC }, required: ["security"] },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const e = await ctx.router.first("earnings", s, (pl) => pl.earnings!(s));
      if (!e) throw new ToolError(`No estimates for ${s}`);
      return { result: e, summary: `Loaded estimates for ${s}`, sources: [{ label: `${e.source}: ${s} consensus estimates` }] };
    },
  },
  {
    spec: {
      name: "get_analysts",
      description: "Analyst consensus rating, price targets and recent rating changes.",
      parameters: { type: "object", properties: { security: SEC }, required: ["security"] },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const a = await ctx.router.first("analysts", s, (pl) => pl.analysts!(s));
      if (!a) throw new ToolError(`No analyst data for ${s}`);
      return { result: { ...a, actions: a.actions.slice(0, 8) }, summary: `Loaded analyst views for ${s}` };
    },
  },
  {
    spec: {
      name: "get_news",
      description: "Recent headlines for a security, or for a topic query.",
      parameters: { type: "object", properties: { security: SEC, query: { type: "string" } } },
    },
    async run(args, ctx) {
      if (args.security) {
        const s = security(args.security);
        const news = (await ctx.router.first("companyNews", s, (pl) => pl.companyNews!(s))) ?? [];
        return { result: news.slice(0, 10), summary: `Loaded ${Math.min(news.length, 10)} headlines for ${s}`, sources: headlineSources(news) };
      }
      const q = str(args.query, "security or query");
      const news = (await ctx.router.first("news", null, (pl) => pl.news!(q))) ?? [];
      return { result: news.slice(0, 10), summary: `Loaded headlines about "${q}"`, sources: headlineSources(news) };
    },
  },
  {
    spec: {
      name: "get_option_summary",
      description: "Nearest-expiry option summary: at-the-money strike and implied vol, open interest and put/call ratio.",
      parameters: { type: "object", properties: { security: SEC }, required: ["security"] },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const c = await ctx.router.first("options", s, (pl) => pl.options!(s, null));
      if (!c || c.underlying === null) throw new ToolError(`No options for ${s}`);
      const u = c.underlying;
      const nearest = <T extends { strike: number }>(xs: T[]) => xs.reduce<T | null>((b, x) => (!b || Math.abs(x.strike - u) < Math.abs(b.strike - u) ? x : b), null);
      const sum = (xs: { openInterest: number | null }[]) => xs.reduce((a, x) => a + (x.openInterest ?? 0), 0);
      const callOi = sum(c.calls);
      const putOi = sum(c.puts);
      return {
        summary: `Loaded option chain summary for ${s}`,
        result: {
          security: s,
          underlying: u,
          expiration: c.expiration,
          atmStrike: nearest(c.calls)?.strike ?? null,
          atmCallIvPct: round((nearest(c.calls)?.iv ?? NaN) * 100, 2),
          atmPutIvPct: round((nearest(c.puts)?.iv ?? NaN) * 100, 2),
          callOpenInterest: callOi,
          putOpenInterest: putOi,
          putCallOiRatio: callOi ? round(putOi / callOi, 3) : null,
          expirations: c.expirations.slice(0, 8),
        },
      };
    },
  },
  {
    spec: { name: "get_yield_curve", description: "US Treasury yield curve with 1-week and 1-month comparisons.", parameters: { type: "object", properties: {} } },
    async run(_args, ctx) {
      const c = await ctx.router.first("yieldCurve", null, (pl) => pl.yieldCurve!());
      if (!c) throw new ToolError("Yield curve unavailable");
      return { result: c, summary: `Loaded ${c.name} (${c.date})`, sources: [{ label: `${c.source}: ${c.name}`, asOf: c.date }] };
    },
  },
  {
    spec: {
      name: "run_screen",
      description: `Run a predefined equity screen. ids: ${Object.keys(SCREENS).join(", ")}.`,
      parameters: { type: "object", properties: { id: { type: "string", enum: Object.keys(SCREENS) } }, required: ["id"] },
    },
    async run(args, ctx) {
      const id = String(args.id) as ScreenId;
      if (!(id in SCREENS)) throw new ToolError(`Unknown screen ${id}`);
      const rows = ((await ctx.router.first("screen", null, (pl) => pl.screen!(id))) ?? []).slice(0, 15);
      return { result: rows, summary: `Ran screen ${SCREENS[id]}` };
    },
  },
  {
    spec: {
      name: "run_bql",
      description: bqlGuide(),
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    async run(args, ctx) {
      const query = str(args.query, "query");
      try {
        parseBql(query);
      } catch (err) {
        if (err instanceof BqlError) throw new ToolError(`${err.message} (at character ${err.position + 1}: "${query.slice(err.position, err.position + 20)}")`);
        throw err;
      }
      const deps: BqlDeps = { router: ctx.router, fields: ctx.fields, portfolios: ctx.portfolios };
      const r = await runBql(query, ctx.user, deps);
      return {
        result: { columns: r.columns, rows: r.rows.slice(0, 30), totalRows: r.rows.length, universeSize: r.universeSize },
        summary: `Ran BQL (${r.rows.length} rows from ${r.universeSize} securities)`,
        action: { type: "open_bql", query },
      };
    },
  },
  {
    spec: { name: "list_portfolios", description: "List the current user's saved portfolios.", parameters: { type: "object", properties: {} } },
    async run(_args, ctx) {
      if (!ctx.user) throw new ToolError("No user is signed in");
      const list = ctx.portfolios.list(ctx.user);
      return { result: list, summary: `Listed ${list.length} portfolios` };
    },
  },
  {
    spec: {
      name: "portfolio_analytics",
      description: "Risk, performance, exposures and top holdings for one of the user's portfolios, by name.",
      parameters: { type: "object", properties: { name: { type: "string" }, range: { type: "string", enum: ["3mo", "6mo", "1y", "2y", "5y"] } }, required: ["name"] },
    },
    async run(args, ctx) {
      if (!ctx.user) throw new ToolError("No user is signed in");
      const p = ctx.portfolios.findByName(ctx.user, str(args.name, "name"));
      if (!p) throw new ToolError(`No portfolio named "${args.name}". Use list_portfolios.`);
      const range = (["3mo", "6mo", "1y", "2y", "5y"].includes(String(args.range)) ? String(args.range) : "1y") as Range;
      const a = await ctx.portfolioService.analyze(p, range, "SPX Index");
      return {
        summary: `Analyzed portfolio "${p.name}" over ${range}`,
        result: {
          name: a.name,
          baseCurrency: a.baseCurrency,
          totals: a.totals,
          performance: { ...a.performance, points: undefined },
          risk: a.risk,
          topHoldings: [...a.holdings]
            .sort((x, y) => (y.weightPct ?? 0) - (x.weightPct ?? 0))
            .slice(0, 10)
            .map((h) => ({ security: h.security, weightPct: round(h.weightPct, 2), periodReturnPct: round(h.periodReturnPct, 2), riskContributionPct: round(h.riskContributionPct, 2) })),
          exposures: { sector: a.exposures.sector.slice(0, 8), country: a.exposures.country.slice(0, 8), currency: a.exposures.currency },
          warnings: a.warnings.slice(0, 5),
        },
      };
    },
  },
  {
    spec: {
      name: "open_function",
      description: "Open a terminal function for the user, e.g. GP (price graph), DES, FA, ANR, OMON, PORT, GC, WEI. Use when the user asks to see or show something.",
      parameters: { type: "object", properties: { function: { type: "string" }, security: SEC }, required: ["function"] },
    },
    async run(args) {
      const fn = str(args.function, "function").toUpperCase();
      if (!/^[A-Z][A-Z0-9]{0,7}$/.test(fn)) throw new ToolError(`"${fn}" is not a function mnemonic`);
      const s = args.security ? security(args.security) : null;
      return { result: { opened: fn, security: s }, summary: `Suggested ${s ? `${s} ` : ""}${fn}`, action: { type: "open", security: s, fn } };
    },
  },
  {
    spec: {
      name: "draft_portfolio",
      description: "Draft a portfolio for the user to review and save in PRTU. kind 'model' uses weights in %, 'positions' uses share quantities.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["model", "positions"] },
          baseCurrency: { type: "string" },
          notional: { type: "number" },
          holdings: {
            type: "array",
            items: { type: "object", properties: { security: SEC, weight: { type: "number" }, quantity: { type: "number" } }, required: ["security"] },
          },
        },
        required: ["name", "kind", "holdings"],
      },
    },
    async run(args) {
      let portfolio: PortfolioInput;
      try {
        portfolio = validatePortfolio(args);
      } catch (err) {
        throw new ToolError((err as Error).message);
      }
      return {
        result: { drafted: portfolio.name, holdings: portfolio.holdings.length, note: "The user reviews and saves it in PRTU." },
        summary: `Drafted portfolio "${portfolio.name}" (${portfolio.holdings.length} holdings)`,
        action: { type: "draft_portfolio", portfolio },
      };
    },
  },
  {
    spec: {
      name: "get_index_members",
      description: "Members of an index (SPX, INDU, NDX, UKX, DAX, CAC, SX5E, HSI, AS51) with estimated weights and today's biggest point contributors.",
      parameters: { type: "object", properties: { index: { type: "string", description: 'e.g. "SPX Index"' } }, required: ["index"] },
    },
    async run(args, ctx) {
      const index = security(args.index);
      const m = await membersFor(ctx.router, index);
      if (!m) throw new ToolError(`No member list for ${index}; covered: SPX, INDU, NDX, UKX, DAX, CAC, SX5E, HSI, AS51 (all "... Index")`);
      const slim = (r: MemberRow) => ({ security: r.security, name: r.name, weightPct: round(r.weightPct, 2), changePct: round(r.changePct, 2), points: round(r.points, 2) });
      const byPoints = [...m.members].filter((r) => r.points !== null).sort((a, b) => b.points! - a.points!);
      return {
        summary: `Loaded ${m.total} members of ${index}`,
        result: {
          index,
          name: m.name,
          weighting: m.weighting,
          level: m.level,
          changePct: round(m.changePct, 2),
          advancers: m.advancers,
          decliners: m.decliners,
          topWeights: m.members.slice(0, 15).map(slim),
          topContributors: byPoints.slice(0, 5).map(slim),
          bottomContributors: byPoints.slice(-5).reverse().map(slim),
          sectors: m.sectors.slice(0, 11).map((s) => ({ sector: s.sector, weightPct: round(s.weightPct, 2), points: round(s.points, 2) })),
          note: "Weights are estimated from full market cap (price for INDU); index providers also apply free-float and capping rules.",
        },
      };
    },
  },
  {
    spec: {
      name: "get_rate_expectations",
      description: "Federal Reserve rate path priced by fed funds futures: current rate, and for each upcoming FOMC meeting the implied rate, bp change and probability of a 25bp move.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      const r = await rateProbabilities(ctx.router, new Date(ctx.now()));
      if (!r) throw new ToolError("No current fed funds rate available");
      return {
        summary: `Loaded fed funds expectations for ${r.meetings.length} meetings`,
        result: {
          currentRatePct: r.currentRatePct,
          targetRange: r.targetLow !== null && r.targetHigh !== null ? `${r.targetLow}-${r.targetHigh}` : null,
          meetings: r.meetings.map((m) => ({
            date: m.date,
            impliedRatePct: round(m.impliedRatePct, 3),
            stepBp: round(m.stepBp, 1),
            cumulativeBp: round(m.cumulativeBp, 1),
            probabilityPct: round(m.probabilityPct, 0),
            direction: m.direction,
          })),
        },
      };
    },
  },
  {
    spec: {
      name: "get_fx_forwards",
      description: "Theoretical FX forward outrights and points (1W to 1Y) for a currency pair, from official overnight rates by covered interest parity.",
      parameters: { type: "object", properties: { pair: { type: "string", description: 'e.g. "EURUSD Curncy"' } }, required: ["pair"] },
    },
    async run(args, ctx) {
      try {
        const c = await forwardsFor(ctx.router, str(args.pair, "pair"));
        return {
          summary: `Priced forwards for ${c.security}`,
          result: {
            security: c.security,
            spot: c.spot,
            rates: [c.base, c.quote].map((r) => ({ currency: r.currency, name: r.name, ratePct: r.ratePct, date: r.date })),
            forwards: c.rows.map((r) => ({ tenor: r.tenor, outright: round(r.outright, 5), points: round(r.points, 2) })),
            method: c.method,
          },
        };
      } catch (err) {
        if (err instanceof ForwardError) throw new ToolError(err.message);
        throw err;
      }
    },
  },
  {
    spec: {
      name: "get_paper_account",
      description: "The user's paper trading account: cash by currency, positions with average cost, and recent orders.",
      parameters: { type: "object", properties: {} },
    },
    async run(_args, ctx) {
      if (!ctx.paper) throw new ToolError("Paper trading is not available on this server");
      if (!ctx.user) throw new ToolError("Sign in with a login name to use a paper account");
      const a = ctx.paper.account(ctx.user);
      return {
        summary: `Loaded paper account (${a.positions.length} positions)`,
        result: { cash: a.cash, positions: a.positions, recentOrders: a.orders.slice(0, 10).map((o) => ({ security: o.security, side: o.side, quantity: o.quantity, type: o.type, status: o.status, fillPrice: o.fillPrice })) },
      };
    },
  },
  {
    spec: {
      name: "run_plugin_function",
      description: "Run a function added by a plugin (for example CF, SEC company filings, for a US equity) and read its screen.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" }, security: SEC, option: { type: "number", description: "Index of the option to select, if the function has options" } },
        required: ["code"],
      },
    },
    async run(args, ctx) {
      const code = str(args.code, "code").toUpperCase();
      const entry = ctx.plugins?.functions.get(code);
      if (!entry) throw new ToolError(`No plugin function ${code}. Available: ${[...(ctx.plugins?.functions.keys() ?? [])].join(", ") || "none"}`);
      const s = entry.fn.security ? security(args.security) : null;
      const count = entry.fn.options?.length ?? 0;
      const option = count ? Math.min(Math.max(Math.trunc(Number(args.option) || 0), 0), count - 1) : 0;
      const spec = sanitizeSpec(await entry.fn.run({ security: s, option, router: ctx.router, signal: AbortSignal.timeout(20_000) }));
      const blocks = spec.blocks.map((b) => (b.type === "table" ? { ...b, rows: b.rows.slice(0, 25), totalRows: b.rows.length } : b.type === "series" ? { type: b.type, title: b.title, series: b.series.map((x) => x.label) } : b));
      return { summary: `Ran ${code}${s ? ` for ${s}` : ""}`, result: { title: spec.title, options: entry.fn.options ?? [], blocks } };
    },
  },
  {
    spec: {
      name: "run_backtest",
      description: `Backtest a trading rule on daily history for up to 10 securities; the user can open the result in BTST. Signals are read at the close and filled at the next open, fully invested, with costs per side. ${RULE_HELP} Test several related securities rather than one, pass oosFrom to judge the rule on data after that date separately, and treat rules tuned to one series as likely overfit.`,
      parameters: {
        type: "object",
        properties: {
          securities: { type: "array", items: SEC },
          entry: { type: "string", description: 'Entry rule, e.g. "crossAbove(sma(close, 50), sma(close, 200))"' },
          exit: { type: "string", description: "Exit rule; omit to exit when the entry rule stops being true" },
          direction: { type: "string", enum: ["long", "short"] },
          costBps: { type: "number", description: "Cost per side in basis points (default 5)" },
          range: { type: "string", enum: [...BACKTEST_RANGES] },
          oosFrom: { type: "string", description: "Date (YYYY-MM-DD) splitting in-sample from out-of-sample results" },
        },
        required: ["securities", "entry"],
      },
    },
    async run(args, ctx) {
      const secs = securities(args.securities, 10);
      const entrySrc = str(args.entry, "entry");
      const exitSrc = typeof args.exit === "string" ? args.exit.trim() : "";
      const direction = args.direction === "short" ? "short" : "long";
      const costBps = typeof args.costBps === "number" && Number.isFinite(args.costBps) && args.costBps >= 0 ? args.costBps : 5;
      const range = pick(args.range, BACKTEST_RANGES, "5y");
      const oosFrom = args.oosFrom ? Date.parse(String(args.oosFrom)) : null;
      if (Number.isNaN(oosFrom)) throw new ToolError("oosFrom must be a date like 2024-01-01");
      const results = await Promise.all(
        secs.map(async (s) => {
          let bars: Bar[];
          try {
            bars = await dailyBars(ctx, s, range);
          } catch (err) {
            if (err instanceof ToolError) return { security: s, error: err.message };
            throw err;
          }
          const entry = signals("Entry rule", entrySrc, bars);
          const exit = exitSrc ? signals("Exit rule", exitSrc, bars) : null;
          const test = (from: number, to: number) =>
            backtest({ bars: bars.slice(from, to), entry: entry.slice(from, to), exit: exit?.slice(from, to) ?? null, direction, costBps });
          const full = test(0, bars.length);
          const split = oosFrom === null ? -1 : bars.findIndex((b) => b.t >= oosFrom);
          const periods =
            oosFrom === null
              ? {}
              : split >= 20 && split <= bars.length - 20
                ? { inSample: slimBacktest(test(0, split).stats), outOfSample: slimBacktest(test(split, bars.length).stats) }
                : { splitNote: "oosFrom leaves fewer than 20 trading days on one side, so no split is reported" };
          return {
            security: s,
            start: isoDay(bars[0].t),
            end: isoDay(bars[bars.length - 1].t),
            full: slimBacktest(full.stats),
            ...periods,
            recentTrades: full.trades.slice(-5).map((t) => ({ entry: isoDay(t.entryDate), exit: t.open ? "open" : isoDay(t.exitDate), returnPct: round(t.returnPct, 2), days: t.bars })),
          };
        }),
      );
      const ok = results.filter((r): r is Extract<(typeof results)[number], { full: unknown }> => "full" in r);
      if (!ok.length) throw new ToolError(results.map((r) => ("error" in r ? r.error : "")).join("; "));
      const excess = ok.map((r) => (r.full.totalReturnPct ?? 0) - (r.full.buyHoldReturnPct ?? 0));
      return {
        summary: `Backtested a ${direction} rule on ${ok.map((r) => r.security).join(", ")} (${range})`,
        result: {
          rule: { entry: entrySrc, exit: exitSrc || "(when the entry rule stops being true)", direction, costBps, range, oosFrom: oosFrom === null ? null : isoDay(oosFrom) },
          results,
          ...(ok.length > 1
            ? {
                acrossSecurities: {
                  beatBuyAndHold: `${excess.filter((x) => x > 0).length} of ${ok.length}`,
                  medianExcessReturnPct: round(median(excess), 2),
                  medianSharpe: round(median(ok.map((r) => r.full.sharpe ?? NaN).filter(Number.isFinite)), 2),
                },
              }
            : {}),
          method: "Daily bars; signals at the close fill at the next open; positions are 100% of equity; costs on entry and exit; Sharpe uses a zero risk-free rate.",
        },
        sources: ok.slice(0, 3).map((r) => ({ label: `${r.security} daily prices, ${r.start} to ${r.end}`, asOf: r.end })),
        action: { type: "open_backtest", security: ok[0].security, entry: entrySrc, exit: exitSrc, direction, costBps, range },
      };
    },
  },
  {
    spec: {
      name: "analyze_returns",
      description:
        "Daily return statistics for up to 10 securities: annualized return and volatility, Sharpe, max drawdown, skew and excess kurtosis, beta, alpha and R² against a benchmark, a correlation matrix, and optionally a multi-factor regression on up to 4 factor securities (for example sector ETFs, a bond ETF or oil) with t-statistics.",
      parameters: {
        type: "object",
        properties: {
          securities: { type: "array", items: SEC },
          benchmark: { ...SEC, description: 'Benchmark security (default "SPX Index")' },
          factors: { type: "array", items: SEC, description: "Factor securities regressed on alongside the benchmark" },
          range: { type: "string", enum: ["3mo", "6mo", "1y", "2y", "5y"] },
        },
        required: ["securities"],
      },
    },
    async run(args, ctx) {
      const secs = securities(args.securities, 10);
      const bench = args.benchmark ? security(args.benchmark) : "SPX Index";
      const factors = Array.isArray(args.factors) && args.factors.length ? securities(args.factors, 4) : [];
      const range = pick(args.range, ["3mo", "6mo", "1y", "2y", "5y"] as const, "1y");
      const all = [...new Set([...secs, bench, ...factors])];
      const series = await Promise.all(all.map((s) => dailyBars(ctx, s, range, 20)));
      const { days, returns } = alignedReturns(series);
      if (days.length < 20) throw new ToolError(`Only ${days.length} trading days are common to all series; use a longer range or fewer markets`);
      const rets = (s: string) => returns[all.indexOf(s)];
      const benchRets = rets(bench);
      const rows = secs.map((s) => {
        const y = rets(s);
        const single = ols(y, [benchRets]);
        const multi = factors.length ? ols(y, [benchRets, ...factors.map(rets)]) : null;
        return {
          security: s,
          ...slimReturns(returnStats(y)),
          beta: round(single?.betas[0], 3),
          alphaAnnualPct: round(single?.alphaAnnualPct, 2),
          r2: round(single?.r2, 3),
          correlationToBenchmark: round(correlation(y, benchRets), 3),
          ...(multi
            ? {
                factorModel: {
                  alphaAnnualPct: round(multi.alphaAnnualPct, 2),
                  alphaTStat: round(multi.alphaTStat, 2),
                  r2: round(multi.r2, 3),
                  loadings: [bench, ...factors].map((f, j) => ({ factor: f, beta: round(multi.betas[j], 3), tStat: round(multi.tStats[j], 2) })),
                },
              }
            : {}),
        };
      });
      const start = isoDay(days[0]);
      const end = isoDay(days[days.length - 1]);
      return {
        summary: `Analyzed daily returns of ${secs.join(", ")} against ${bench} (${range})`,
        result: {
          range,
          benchmark: bench,
          start,
          end,
          tradingDays: days.length,
          benchmarkStats: slimReturns(returnStats(benchRets)),
          securities: rows,
          ...(secs.length > 1 ? { correlations: { order: secs, matrix: correlationMatrix(secs.map(rets)).map((r) => r.map((v) => round(v, 2))) } } : {}),
          method: "Close-to-close daily returns on days every series traded, annualized over 252 days; Sharpe uses a zero risk-free rate; regressions are OLS with an intercept.",
        },
        sources: [{ label: `Daily prices for ${all.join(", ")}, ${start} to ${end}`, asOf: end }],
      };
    },
  },
  {
    spec: {
      name: "draft_alert",
      description: `Draft an alert for the user to confirm with a Create alert button; the server watches it and notifies the user in the terminal. Kinds: above and below (price level), pct_up and pct_down (today's move in %, a positive value), volume_above (shares traded today), rule (expr in the rule language, checked on daily bars). Also reports how often the condition was met over the past year. ${RULE_HELP}`,
      parameters: {
        type: "object",
        properties: {
          security: SEC,
          kind: { type: "string", enum: [...ALERT_KINDS] },
          value: { type: "number", description: "Price level, percent move or volume, for every kind except rule" },
          expr: { type: "string", description: 'Rule for kind "rule", e.g. "crossAbove(close, sma(close, 200))"' },
          note: { type: "string", description: "Why the user wants the alert, shown when it fires" },
        },
        required: ["security", "kind"],
      },
    },
    async run(args, ctx) {
      let alert: AlertInput;
      try {
        alert = validateAlert(args);
      } catch (err) {
        if (err instanceof AlertValidationError) throw new ToolError(err.message);
        throw err;
      }
      let pastYear: Record<string, unknown>;
      try {
        const h = ruleHistory(alertRule(alert), await dailyBars(ctx, alert.security, "1y"));
        pastYear = { timesMet: h.timesFired, daysMet: h.daysTrue, lastMet: h.lastFired, metNow: h.trueNow };
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        pastYear = { unavailable: err.message };
      }
      const label = describeAlert(alert);
      return {
        summary: `Drafted alert: ${label}`,
        result: {
          drafted: label,
          alert,
          pastYear,
          note: "The past-year check uses daily closes, while the live alert watches intraday quotes (rule alerts use daily bars). The user confirms it with the Create alert button.",
        },
        action: { type: "draft_alert", alert, label },
      };
    },
  },
  {
    spec: {
      name: "evaluate_rule",
      description: `How a rule behaved on a security's daily history: share of days it was true, when it fired (became true), whether it is true now, and the average return 5 and 20 trading days after each firing. ${RULE_HELP}`,
      parameters: {
        type: "object",
        properties: { security: SEC, rule: { type: "string", description: 'e.g. "rsi(close, 14) < 30"' }, range: { type: "string", enum: ["6mo", "1y", "2y", "5y"] } },
        required: ["security", "rule"],
      },
    },
    async run(args, ctx) {
      const s = security(args.security);
      const rule = str(args.rule, "rule");
      const range = pick(args.range, ["6mo", "1y", "2y", "5y"] as const, "1y");
      const bars = await dailyBars(ctx, s, range);
      const h = ruleHistory(rule, bars);
      const start = isoDay(bars[0].t);
      const end = isoDay(bars[bars.length - 1].t);
      return {
        summary: `Checked "${rule}" on ${s} (${range}): fired ${h.timesFired} times`,
        result: {
          security: s,
          rule,
          range,
          start,
          end,
          tradingDays: bars.length,
          ...h,
          note: "Forward returns are close to close after each firing; few or overlapping samples make them noisy.",
        },
        sources: [{ label: `${s} daily prices, ${start} to ${end}`, asOf: end }],
      };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.spec.name, t]));

const PLUGIN_TOOL_TIMEOUT_MS = 30_000;

/** A plugin's sources, kept only when well formed; links must be http(s). */
function cleanSources(raw: unknown): Source[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.flatMap((s): Source[] => {
    const { label, url, asOf } = (s ?? {}) as Partial<Source>;
    if (typeof label !== "string" || !label.trim()) return [];
    return [
      {
        label: label.slice(0, 200),
        ...(typeof url === "string" && /^https?:\/\//i.test(url) ? { url } : {}),
        ...(typeof asOf === "string" && asOf ? { asOf: asOf.slice(0, 40) } : {}),
      },
    ];
  });
  return out.length ? out.slice(0, 10) : undefined;
}

/** Tools that plugins add, run with a timeout and cleaned-up sources. */
export function pluginToolDefs(registry: PluginRegistry | undefined): ToolDef[] {
  return (registry?.aiTools ?? []).map(({ tool }) => ({
    spec: tool.spec,
    async run(args, ctx) {
      const out = await tool.run(args, { router: ctx.router, signal: AbortSignal.timeout(PLUGIN_TOOL_TIMEOUT_MS), maxResultChars: ctx.maxResultChars ?? 8_000 });
      if (!out || typeof out !== "object" || typeof out.summary !== "string") throw new ToolError(`${tool.spec.name} returned no summary`);
      return { result: out.result, summary: out.summary.slice(0, 200), sources: cleanSources(out.sources) };
    },
  }));
}
