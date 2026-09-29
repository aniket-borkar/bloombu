import type YahooFinance from "yahoo-finance2";
import { buildStatement } from "../research/statements.js";
import { futuresContracts, fromYahoo, normalizeSecurity, sectorOf, toYahoo } from "../symbology.js";
import type {
  Analysts,
  CorporateEvents,
  Earnings,
  FinancialStatement,
  FuturesChain,
  Headline,
  Holders,
  Holding,
  OptionChain,
  OptionQuote,
  Profile,
  ScreenId,
  ScreenRow,
  Statement,
  StatementPeriod,
  Valuation,
} from "../types.js";

type YF = InstanceType<typeof YahooFinance>;
type R = Record<string, unknown>;

const SOURCE = "Yahoo Finance";
const OPT = { validateResult: false } as const;

export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): R => (v && typeof v === "object" ? (v as R) : {});
const arr = (v: unknown): R[] => (Array.isArray(v) ? (v as R[]) : []);
const pct = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n * 100;
};
/** Zero means "not reported" for these Yahoo fields. */
const nonZero = (v: unknown): number | null => num(v) || null;

export function iso(v: unknown): string | null {
  const d =
    v instanceof Date ? v : typeof v === "number" ? new Date(v > 1e12 ? v : v * 1000) : typeof v === "string" ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

const isEquity = (security: string) => sectorOf(security) === "Equity";

async function summary(yf: YF, symbol: string, modules: string[]): Promise<R> {
  return obj(await yf.quoteSummary(symbol, { modules: modules as never }, OPT));
}

export async function profile(yf: YF, security: string): Promise<Profile | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key) return null;
  let r: R;
  try {
    r = await summary(
      yf,
      symbol,
      isEquity(security)
        ? ["assetProfile", "summaryDetail", "defaultKeyStatistics", "price", "calendarEvents"]
        : ["price", "summaryDetail"],
    );
  } catch {
    r = await summary(yf, symbol, ["price", "summaryDetail"]);
  }
  const ap = obj(r.assetProfile);
  const sd = obj(r.summaryDetail);
  const ks = obj(r.defaultKeyStatistics);
  const pr = obj(r.price);
  const cal = obj(obj(r.calendarEvents).earnings);
  if (!Object.keys(pr).length) return null;
  return {
    security: key,
    name: str(pr.longName) ?? str(pr.shortName) ?? key,
    summary: str(ap.longBusinessSummary),
    sector: str(ap.sectorDisp) ?? str(ap.sector),
    industry: str(ap.industryDisp) ?? str(ap.industry),
    website: str(ap.website),
    employees: num(ap.fullTimeEmployees),
    address: [str(ap.city), str(ap.state), str(ap.country)].filter(Boolean).join(", ") || null,
    currency: str(pr.currency),
    exchange: str(pr.exchangeName),
    marketCap: num(pr.marketCap) ?? num(sd.marketCap),
    enterpriseValue: num(ks.enterpriseValue),
    sharesOutstanding: num(ks.sharesOutstanding),
    floatShares: num(ks.floatShares),
    pe: num(sd.trailingPE),
    forwardPe: num(sd.forwardPE) ?? num(ks.forwardPE),
    eps: num(ks.trailingEps),
    priceToBook: num(ks.priceToBook),
    beta: num(sd.beta) ?? num(ks.beta),
    dividendRate: num(sd.dividendRate),
    dividendYieldPct: pct(sd.dividendYield),
    exDividendDate: iso(sd.exDividendDate),
    high52: num(sd.fiftyTwoWeekHigh),
    low52: num(sd.fiftyTwoWeekLow),
    avgVolume: num(sd.averageVolume),
    shortFloatPct: pct(ks.shortPercentOfFloat),
    nextEarnings: iso(arr(cal.earningsDate)[0]),
    officers: arr(ap.companyOfficers).map((o) => ({
      name: str(o.name) ?? "",
      title: str(o.title) ?? "",
      age: num(o.age),
      totalPay: num(o.totalPay),
    })),
    source: SOURCE,
  };
}

const STATEMENT_MODULE: Record<Statement, string> = {
  income: "financials",
  balance: "balance-sheet",
  cashflow: "cash-flow",
};

export async function financials(
  yf: YF,
  security: string,
  statement: Statement,
  period: StatementPeriod,
): Promise<FinancialStatement | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key || !isEquity(security)) return null;
  const years = period === "annual" ? 6 : 2;
  const rows = (await yf.fundamentalsTimeSeries(
    symbol,
    {
      period1: new Date(Date.now() - years * 366 * 86_400_000),
      type: period,
      module: STATEMENT_MODULE[statement],
    } as never,
    OPT,
  )) as unknown as R[];
  const records = arr(rows).flatMap((r) => {
    const date = iso(r.date);
    return date ? [{ date: date.slice(0, 10), values: r }] : [];
  });
  return buildStatement(key, statement, period, records, SOURCE);
}

const TREND_LABEL: Record<string, string> = {
  "0q": "Current Qtr",
  "+1q": "Next Qtr",
  "0y": "Current Year",
  "+1y": "Next Year",
};

export async function earnings(yf: YF, security: string): Promise<Earnings | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key || !isEquity(security)) return null;
  const r = await summary(yf, symbol, ["earnings", "earningsHistory", "earningsTrend", "calendarEvents", "price"]);
  const history = arr(obj(r.earningsHistory).history).map((h) => ({
    quarter: (iso(h.quarter) ?? "").slice(0, 10),
    actual: num(h.epsActual),
    estimate: num(h.epsEstimate),
    surprisePct: pct(h.surprisePercent),
  }));
  const estimates = arr(obj(r.earningsTrend).trend)
    .filter((t) => str(t.period) && TREND_LABEL[t.period as string])
    .map((t) => {
      const e = obj(t.earningsEstimate);
      const v = obj(t.revenueEstimate);
      return {
        period: TREND_LABEL[t.period as string],
        endDate: iso(t.endDate),
        epsAvg: num(e.avg),
        epsLow: num(e.low),
        epsHigh: num(e.high),
        epsYearAgo: num(e.yearAgoEps),
        epsGrowthPct: pct(e.growth),
        revenueAvg: num(v.avg),
        revenueLow: num(v.low),
        revenueHigh: num(v.high),
        revenueGrowthPct: pct(v.growth),
        analysts: num(e.numberOfAnalysts),
      };
    });
  const annual = arr(obj(obj(r.earnings).financialsChart).yearly).map((y) => ({
    year: String(y.date ?? ""),
    revenue: num(y.revenue),
    earnings: num(y.earnings),
  }));
  if (!history.length && !estimates.length && !annual.length) return null;
  return {
    security: key,
    currency: str(obj(r.price).currency),
    nextDate: iso(arr(obj(obj(r.calendarEvents).earnings).earningsDate)[0]),
    history,
    estimates,
    annual,
    source: SOURCE,
  };
}

const TREND_PERIOD: Record<string, string> = { "0m": "Current", "-1m": "1M Ago", "-2m": "2M Ago", "-3m": "3M Ago" };
const ACTION: Record<string, string> = {
  up: "Upgrade",
  down: "Downgrade",
  main: "Maintains",
  reit: "Reiterates",
  init: "Initiates",
};

export async function analysts(yf: YF, security: string): Promise<Analysts | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key || !isEquity(security)) return null;
  const r = await summary(yf, symbol, ["financialData", "recommendationTrend", "upgradeDowngradeHistory", "price"]);
  const fd = obj(r.financialData);
  const trend = arr(obj(r.recommendationTrend).trend).map((t) => ({
    period: TREND_PERIOD[str(t.period) ?? ""] ?? str(t.period) ?? "",
    strongBuy: num(t.strongBuy) ?? 0,
    buy: num(t.buy) ?? 0,
    hold: num(t.hold) ?? 0,
    sell: num(t.sell) ?? 0,
    strongSell: num(t.strongSell) ?? 0,
  }));
  const actions = arr(obj(r.upgradeDowngradeHistory).history)
    .slice(0, 50)
    .map((h) => ({
      date: iso(h.epochGradeDate) ?? "",
      firm: str(h.firm) ?? "",
      action: ACTION[str(h.action) ?? ""] ?? str(h.action) ?? "",
      fromGrade: str(h.fromGrade),
      toGrade: str(h.toGrade),
      target: nonZero(h.currentPriceTarget),
      priorTarget: nonZero(h.priorPriceTarget),
    }));
  if (!trend.length && !actions.length && num(fd.targetMeanPrice) === null) return null;
  return {
    security: key,
    currency: str(obj(r.price).currency),
    currentPrice: num(fd.currentPrice),
    recommendationMean: num(fd.recommendationMean),
    recommendation: str(fd.recommendationKey),
    analystCount: num(fd.numberOfAnalystOpinions),
    targetMean: num(fd.targetMeanPrice),
    targetMedian: num(fd.targetMedianPrice),
    targetHigh: num(fd.targetHighPrice),
    targetLow: num(fd.targetLowPrice),
    trend,
    actions,
    source: SOURCE,
  };
}

const holding = (h: R): Holding => ({
  name: str(h.organization) ?? "",
  reportDate: iso(h.reportDate),
  heldPct: pct(h.pctHeld),
  shares: num(h.position),
  value: num(h.value),
  changePct: pct(h.pctChange),
});

export async function holders(yf: YF, security: string): Promise<Holders | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key || !isEquity(security)) return null;
  const r = await summary(yf, symbol, ["majorHoldersBreakdown", "institutionOwnership", "fundOwnership", "insiderHolders"]);
  const mb = obj(r.majorHoldersBreakdown);
  const institutions = arr(obj(r.institutionOwnership).ownershipList).map(holding);
  const funds = arr(obj(r.fundOwnership).ownershipList).map(holding);
  const insiders = arr(obj(r.insiderHolders).holders).map((h) => ({
    name: str(h.name) ?? "",
    relation: str(h.relation),
    shares: num(h.positionDirect),
    lastTransaction: str(h.transactionDescription),
    date: iso(h.latestTransDate),
  }));
  if (!institutions.length && !funds.length && !insiders.length && num(mb.institutionsPercentHeld) === null) return null;
  return {
    security: key,
    insidersPct: pct(mb.insidersPercentHeld),
    institutionsPct: pct(mb.institutionsPercentHeld),
    institutionsFloatPct: pct(mb.institutionsFloatPercentHeld),
    institutionCount: num(mb.institutionsCount),
    institutions,
    funds,
    insiders,
    source: SOURCE,
  };
}

export async function events(yf: YF, security: string): Promise<CorporateEvents | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key) return null;
  const [chart, r] = await Promise.all([
    yf.chart(
      symbol,
      { period1: new Date(Date.now() - 15 * 366 * 86_400_000), interval: "1mo", events: "div|split", return: "array" },
      OPT,
    ) as Promise<unknown>,
    isEquity(security) ? summary(yf, symbol, ["summaryDetail", "calendarEvents", "price"]).catch(() => ({}) as R) : Promise.resolve({} as R),
  ]);
  const ev = obj(obj(chart).events);
  const dividends = arr(ev.dividends).flatMap((d) => {
    const date = iso(d.date);
    const amount = num(d.amount);
    return date && amount !== null ? [{ date, amount }] : [];
  });
  const splits = arr(ev.splits).flatMap((s) => {
    const date = iso(s.date);
    const ratio = str(s.splitRatio) ?? (num(s.numerator) && num(s.denominator) ? `${s.numerator}:${s.denominator}` : null);
    return date && ratio ? [{ date, ratio }] : [];
  });
  const sd = obj((r as R).summaryDetail);
  const cal = obj((r as R).calendarEvents);
  return {
    security: key,
    currency: str(obj((r as R).price).currency) ?? str(obj(obj(chart).meta).currency),
    dividendRate: num(sd.dividendRate),
    dividendYieldPct: pct(sd.dividendYield),
    payoutRatioPct: pct(sd.payoutRatio),
    exDividendDate: iso(sd.exDividendDate) ?? iso(cal.exDividendDate),
    payDate: iso(cal.dividendDate),
    dividends,
    splits,
    source: SOURCE,
  };
}

function optionQuote(o: R): OptionQuote | null {
  const strike = num(o.strike);
  if (strike === null) return null;
  return {
    contract: str(o.contractSymbol) ?? "",
    strike,
    last: num(o.lastPrice),
    bid: num(o.bid),
    ask: num(o.ask),
    change: num(o.change),
    volume: num(o.volume),
    openInterest: num(o.openInterest),
    iv: num(o.impliedVolatility),
    itm: o.inTheMoney === true,
  };
}

export async function options(yf: YF, security: string, expiration: string | null): Promise<OptionChain | null> {
  const symbol = toYahoo(security);
  const key = normalizeSecurity(security);
  if (!symbol || !key || !isEquity(security)) return null;
  const res = obj(await yf.options(symbol, expiration ? { date: new Date(expiration) } : {}, OPT));
  const expirations = arr(res.expirationDates).map((d) => iso(d)).filter((d): d is string => !!d);
  const chain = obj(arr(res.options)[0]);
  if (!expirations.length) return null;
  return {
    security: key,
    underlying: num(obj(res.quote).regularMarketPrice),
    expirations,
    expiration: iso(chain.expirationDate) ?? expirations[0],
    calls: arr(chain.calls).map(optionQuote).filter((q): q is OptionQuote => !!q),
    puts: arr(chain.puts).map(optionQuote).filter((q): q is OptionQuote => !!q),
    source: SOURCE,
  };
}

export async function related(yf: YF, security: string): Promise<string[]> {
  const symbol = toYahoo(security);
  if (!symbol || !isEquity(security)) return [];
  const res = obj(await yf.recommendationsBySymbol(symbol, {}, OPT));
  return arr(res.recommendedSymbols)
    .map((r) => str(r.symbol))
    .flatMap((s) => (s ? [fromYahoo(s, "EQUITY")] : []))
    .filter((s): s is string => !!s);
}

export async function valuations(yf: YF, securities: string[]): Promise<Valuation[]> {
  const pairs = securities.flatMap((s) => {
    const key = normalizeSecurity(s);
    const symbol = toYahoo(s);
    return key && symbol ? [{ key, symbol }] : [];
  });
  if (!pairs.length) return [];
  const symbols = [...new Set(pairs.map((p) => p.symbol))];
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += 100) batches.push(symbols.slice(i, i + 100));
  const rows = (await Promise.all(batches.map(async (b) => arr(await yf.quote(b, { return: "array" }, OPT))))).flat();
  const bySymbol = new Map(rows.map((r) => [r.symbol as string, r]));
  return pairs.flatMap(({ key, symbol }) => {
    const q = bySymbol.get(symbol);
    if (!q || num(q.regularMarketPrice) === null) return [];
    return [
      {
        security: key,
        name: str(q.longName) ?? str(q.shortName) ?? key,
        currency: str(q.currency),
        last: num(q.regularMarketPrice),
        changePct: num(q.regularMarketChangePercent),
        marketCap: num(q.marketCap),
        pe: num(q.trailingPE),
        forwardPe: num(q.forwardPE),
        priceToBook: num(q.priceToBook),
        eps: num(q.epsTrailingTwelveMonths),
        dividendYieldPct: num(q.dividendYield),
      },
    ];
  });
}

export async function futuresChain(yf: YF, security: string): Promise<FuturesChain | null> {
  const key = normalizeSecurity(security);
  const candidates = futuresContracts(security, new Date(), 24);
  if (!key || !candidates.length) return null;
  const rows = arr(await yf.quote(candidates.map((c) => c.yahoo), { return: "array" }, OPT));
  const bySymbol = new Map(rows.map((r) => [r.symbol as string, r]));
  const contracts = candidates.flatMap((c) => {
    const q = bySymbol.get(c.yahoo);
    if (!q || num(q.regularMarketPrice) === null) return [];
    return [
      {
        security: c.security,
        name: str(q.shortName) ?? c.security,
        month: c.month,
        last: num(q.regularMarketPrice),
        change: num(q.regularMarketChange),
        changePct: num(q.regularMarketChangePercent),
        volume: num(q.regularMarketVolume),
        openInterest: num(q.openInterest),
        expiry: iso(q.expireDate),
      },
    ];
  });
  return contracts.length ? { security: key, contracts: contracts.slice(0, 12), source: SOURCE } : null;
}

function headline(n: R): Headline | null {
  const title = str(n.title);
  if (!title) return null;
  return {
    id: str(n.uuid) ?? title,
    title,
    source: str(n.publisher) ?? SOURCE,
    time: iso(n.providerPublishTime),
    url: str(n.link),
  };
}

export async function news(yf: YF, query: string): Promise<Headline[]> {
  const res = obj(await yf.search(query, { quotesCount: 0, newsCount: 25 }, OPT));
  return arr(res.news)
    .map(headline)
    .filter((h): h is Headline => !!h);
}

export async function companyNews(yf: YF, security: string): Promise<Headline[]> {
  const symbol = toYahoo(security);
  return symbol ? news(yf, symbol) : [];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decode(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

/** Parse RSS 2.0 items into headlines. */
export function parseRss(xml: string, fallbackSource: string): Headline[] {
  const out: Headline[] = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => item.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];
    const title = tag("title");
    if (!title) continue;
    const url = tag("link");
    const pub = tag("pubDate");
    out.push({
      id: decode(tag("guid") ?? url ?? title),
      title: decode(title),
      source: decode(tag("source") ?? fallbackSource),
      time: pub ? iso(decode(pub)) : null,
      url: url ? decode(url) : null,
    });
  }
  return out;
}

export async function topNews(): Promise<Headline[]> {
  const res = await fetch("https://finance.yahoo.com/news/rssindex", {
    headers: { "user-agent": "Mozilla/5.0 (compatible; blmbu-terminal)" },
  });
  if (!res.ok) throw new Error(`Yahoo RSS ${res.status}`);
  return parseRss(await res.text(), SOURCE);
}

export async function screen(yf: YF, id: ScreenId): Promise<ScreenRow[]> {
  const res = obj(await yf.screener({ scrIds: id, count: 25 } as never, undefined, OPT));
  return arr(res.quotes).flatMap((q) => {
    const symbol = str(q.symbol);
    const security = symbol ? fromYahoo(symbol, str(q.quoteType) ?? undefined) : null;
    if (!security) return [];
    return [
      {
        security,
        name: str(q.longName) ?? str(q.shortName) ?? security,
        last: num(q.regularMarketPrice),
        change: num(q.regularMarketChange),
        changePct: num(q.regularMarketChangePercent),
        volume: num(q.regularMarketVolume),
        marketCap: num(q.marketCap),
        currency: str(q.currency),
      },
    ];
  });
}
