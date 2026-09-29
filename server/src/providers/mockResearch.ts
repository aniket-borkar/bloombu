import type { ProviderPlugin } from "./DataProvider.js";
import { hash, rand, round } from "./mockRandom.js";
import { buildStatement } from "../research/statements.js";
import { blackScholes } from "../research/quant.js";
import { futuresContracts, normalizeSecurity } from "../symbology.js";
import {
  SCREENS,
  type CurvePoint,
  type EconStats,
  type FinancialStatement,
  type Headline,
  type OptionQuote,
  type Quote,
  type ScreenRow,
  type Statement,
  type StatementPeriod,
  type Valuation,
} from "../types.js";

const SOURCE = "Mock";
const DAY = 86_400_000;

export interface MockResearchDeps {
  equities: { security: string; name: string; currency: string | null; exchange: string }[];
  quote(security: string): Quote | null;
  now(): number;
}

export const SECTOR_OF_TICKER: Record<string, [string, string]> = {
  AAPL: ["Technology", "Consumer Electronics"],
  MSFT: ["Technology", "Software - Infrastructure"],
  NVDA: ["Technology", "Semiconductors"],
  AMZN: ["Consumer Cyclical", "Internet Retail"],
  GOOGL: ["Communication Services", "Internet Content & Information"],
  META: ["Communication Services", "Internet Content & Information"],
  TSLA: ["Consumer Cyclical", "Auto Manufacturers"],
  IBM: ["Technology", "Information Technology Services"],
  JPM: ["Financial Services", "Banks - Diversified"],
  VOD: ["Communication Services", "Telecom Services"],
  SAP: ["Technology", "Software - Application"],
  "7203": ["Consumer Cyclical", "Auto Manufacturers"],
};

/** Seeded fundamentals for a mock equity, anchored to its current mock price. */
function model(security: string, price: number) {
  const s = hash(`${security}|fundamentals`);
  const marketCap = (80 + rand(s, 1) * 2900) * 1e9;
  const shares = marketCap / price;
  const pe = 14 + rand(s, 2) * 28;
  const revenue = marketCap * (0.08 + rand(s, 3) * 0.3);
  const grossMargin = 0.35 + rand(s, 4) * 0.35;
  const growth = -0.02 + rand(s, 5) * 0.16;
  const payer = rand(s, 6) > 0.2;
  const yieldPct = payer ? 0.3 + rand(s, 7) * 2.7 : 0;
  return { s, marketCap, shares, pe, eps: price / pe, revenue, grossMargin, growth, payer, yieldPct, beta: 0.6 + rand(s, 8) * 1.2 };
}

function statementValues(statement: Statement, revenue: number, gm: number, shares: number): Record<string, number> {
  const operatingIncome = revenue * (gm - 0.16);
  const interest = revenue * 0.006;
  const pretax = operatingIncome - interest;
  const tax = pretax * 0.18;
  const net = pretax - tax;
  const cash = revenue * 0.12;
  const debt = revenue * 0.28;
  if (statement === "income") {
    return {
      totalRevenue: revenue,
      costOfRevenue: revenue * (1 - gm),
      grossProfit: revenue * gm,
      researchAndDevelopment: revenue * 0.07,
      sellingGeneralAndAdministration: revenue * 0.09,
      operatingExpense: revenue * 0.16,
      operatingIncome,
      EBITDA: operatingIncome * 1.12,
      interestExpense: interest,
      pretaxIncome: pretax,
      taxProvision: tax,
      netIncome: net,
      basicEPS: net / shares,
      dilutedEPS: (net / shares) * 0.995,
      dilutedAverageShares: shares * 1.005,
    };
  }
  if (statement === "balance") {
    return {
      cashAndCashEquivalents: cash,
      cashCashEquivalentsAndShortTermInvestments: revenue * 0.2,
      receivables: revenue * 0.1,
      inventory: revenue * 0.03,
      currentAssets: revenue * 0.5,
      netPPE: revenue * 0.15,
      totalAssets: revenue * 1.4,
      payables: revenue * 0.12,
      currentDebt: revenue * 0.03,
      currentLiabilities: revenue * 0.45,
      longTermDebt: revenue * 0.25,
      totalDebt: debt,
      netDebt: debt - cash,
      totalLiabilitiesNetMinorityInterest: revenue * 0.9,
      stockholdersEquity: revenue * 0.5,
      retainedEarnings: revenue * 0.1,
      workingCapital: revenue * 0.05,
      ordinarySharesNumber: shares,
    };
  }
  const ocf = net * 1.2;
  const capex = -revenue * 0.05;
  const investing = -revenue * 0.06;
  const financing = -net * 0.8;
  return {
    operatingCashFlow: ocf,
    depreciationAndAmortization: revenue * 0.04,
    stockBasedCompensation: revenue * 0.03,
    changeInWorkingCapital: -revenue * 0.01,
    capitalExpenditure: capex,
    investingCashFlow: investing,
    cashDividendsPaid: -net * 0.15,
    repurchaseOfCapitalStock: -net * 0.6,
    financingCashFlow: financing,
    freeCashFlow: ocf + capex,
    changesInCash: ocf + investing + financing,
    endCashPosition: cash,
  };
}

function periodEnds(period: StatementPeriod, now: Date): string[] {
  const out: string[] = [];
  if (period === "annual") {
    for (let i = 4; i >= 1; i--) out.push(`${now.getUTCFullYear() - i}-12-31`);
    return out;
  }
  const quarterEnds = ["03-31", "06-30", "09-30", "12-31"];
  let y = now.getUTCFullYear();
  let q = Math.floor(now.getUTCMonth() / 3) - 1;
  for (let i = 0; i < 5; i++) {
    if (q < 0) {
      q = 3;
      y--;
    }
    out.unshift(`${y}-${quarterEnds[q]}`);
    q--;
  }
  return out;
}

function fridays(from: number, count: number): string[] {
  const out: string[] = [];
  const d = new Date(from);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7));
  while (out.length < count) {
    out.push(d.toISOString());
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return out;
}

function strikeStep(spot: number): number {
  if (spot < 25) return 0.5;
  if (spot < 100) return 1;
  if (spot < 250) return 2.5;
  if (spot < 1000) return 5;
  return 25;
}

const HEADLINES = [
  "%s shares move as investors weigh the outlook",
  "Analysts revisit price targets on %s",
  "%s: what the options market is signaling",
  "Institutional flows into %s pick up",
  "%s management outlines strategy at industry conference",
  "Why %s is on traders' radar this week",
  "%s earnings preview: key numbers to watch",
  "Sector rotation puts %s in focus",
  "%s volatility: a look at recent trading ranges",
  "Credit analysts comment on %s balance sheet",
  "%s dividend and buyback policy under review by analysts",
  "Supply chain update: %s",
];

const MARKET_HEADLINES = [
  "Stocks drift as investors await central bank signals",
  "Treasury yields edge higher ahead of inflation data",
  "Oil prices steady as traders assess supply outlook",
  "Dollar mixed against major currencies",
  "Tech shares lead early trading",
  "Gold holds near recent levels",
  "Earnings season: what to expect this week",
  "Global markets: Asia closes mixed, Europe opens higher",
  "Bond market volatility eases",
  "Commodities roundup: grains, metals, and energy",
  "Small caps outperform large caps in session",
  "Economic calendar: key releases ahead",
  "Crypto markets trade in narrow range",
  "Emerging market currencies firm",
  "Volatility index slips as markets stabilize",
];

function headlines(template: string[], subject: string | null, count: number, now: number, seedKey: string): Headline[] {
  const s = hash(seedKey);
  return Array.from({ length: count }, (_, i) => {
    const t = template[(i + Math.floor(rand(s, 0) * template.length)) % template.length];
    return {
      id: `${seedKey}-${i}`,
      title: `[SIMULATED] ${subject ? t.replace("%s", subject) : t}`,
      source: SOURCE,
      time: new Date(now - (i * 2 + rand(s, i + 1)) * 3_600_000).toISOString(),
      url: null,
    };
  });
}

const CURVE: [string, number, number][] = [
  ["1M", 1 / 12, 4.04],
  ["2M", 2 / 12, 4.2],
  ["3M", 0.25, 4.24],
  ["4M", 4 / 12, 4.32],
  ["6M", 0.5, 4.33],
  ["1Y", 1, 4.5],
  ["2Y", 2, 4.81],
  ["3Y", 3, 4.94],
  ["5Y", 5, 4.98],
  ["7Y", 7, 5.06],
  ["10Y", 10, 5.17],
  ["20Y", 20, 5.54],
  ["30Y", 30, 5.49],
];

const ECON_NAMES: Record<string, string> = {
  USA: "United States", CHN: "China", JPN: "Japan", DEU: "Germany", IND: "India", GBR: "United Kingdom",
  FRA: "France", ITA: "Italy", BRA: "Brazil", CAN: "Canada", KOR: "Korea, Rep.", AUS: "Australia",
  ESP: "Spain", MEX: "Mexico", IDN: "Indonesia", TUR: "Turkiye",
};

const RELEASES = [
  "Consumer Price Index",
  "Employment Situation",
  "Producer Price Index",
  "Advance Monthly Sales for Retail and Food Services",
  "Gross Domestic Product",
  "Industrial Production and Capacity Utilization",
  "New Residential Construction",
  "Personal Income and Outlays",
  "Job Openings and Labor Turnover Survey",
  "University of Michigan: Consumer Sentiment",
];

export function createMockResearch(deps: MockResearchDeps): Partial<ProviderPlugin> {
  const mockCurve = (name: string, level: number) => {
    const pts = (shift: number): CurvePoint[] => CURVE.map(([tenor, years, y]) => ({ tenor, years, yieldPct: round(y + level + shift * (1 + years / 30), 4) }));
    const back = (days: number) => new Date(deps.now() - days * DAY).toISOString().slice(0, 10);
    return {
      name,
      date: new Date(deps.now()).toISOString().slice(0, 10),
      points: pts(0),
      history: [
        { label: "1W Ago", date: back(7), points: pts(-0.05) },
        { label: "1M Ago", date: back(30), points: pts(-0.18) },
      ],
      source: SOURCE,
    };
  };

  const equity = (security: string) => {
    const key = normalizeSecurity(security);
    const found = key ? deps.equities.find((e) => e.security === key) : undefined;
    const q = found ? deps.quote(found.security) : null;
    return found && q?.last ? { ...found, q, m: model(found.security, q.last) } : null;
  };

  return {
    async profile(security) {
      const q = deps.quote(security);
      if (!q) return null;
      const e = equity(security);
      const ticker = q.security.split(" ")[0];
      const [sector, industry] = SECTOR_OF_TICKER[ticker] ?? [null, null];
      const s = hash(q.security);
      return {
        security: q.security,
        name: q.name,
        summary: e ? `[SIMULATED] ${q.name} is shown with generated data for development and testing. Figures do not describe the real company.` : null,
        sector: e ? sector : null,
        industry: e ? industry : null,
        website: null,
        employees: e ? Math.round(5_000 + rand(s, 1) * 200_000) : null,
        address: null,
        currency: q.currency,
        exchange: q.exchange,
        marketCap: e ? round(e.m.marketCap) : null,
        enterpriseValue: e ? round(e.m.marketCap * 1.05) : null,
        sharesOutstanding: e ? Math.round(e.m.shares) : null,
        floatShares: e ? Math.round(e.m.shares * 0.98) : null,
        pe: e ? round(e.m.pe, 4) : null,
        forwardPe: e ? round(e.m.pe * 0.9, 4) : null,
        eps: e ? round(e.m.eps, 4) : null,
        priceToBook: e ? round(3 + rand(s, 2) * 20, 4) : null,
        beta: e ? round(e.m.beta, 3) : null,
        dividendRate: e?.m.payer ? round((q.last! * e.m.yieldPct) / 100, 4) : null,
        dividendYieldPct: e?.m.payer ? round(e.m.yieldPct, 3) : null,
        exDividendDate: e?.m.payer ? new Date(deps.now() - 20 * DAY).toISOString() : null,
        high52: q.last ? round(q.last * 1.18) : null,
        low52: q.last ? round(q.last * 0.78) : null,
        avgVolume: q.volume,
        shortFloatPct: e ? round(0.5 + rand(s, 3) * 4, 3) : null,
        nextEarnings: e ? new Date(deps.now() + (10 + rand(s, 4) * 60) * DAY).toISOString() : null,
        officers: e
          ? ["Chief Executive Officer", "Chief Financial Officer", "Chief Operating Officer", "General Counsel", "Chief Technology Officer"].map(
              (title, i) => ({ name: `Executive ${String.fromCharCode(65 + i)}`, title, age: 45 + Math.floor(rand(s, 10 + i) * 20), totalPay: Math.round(1e6 + rand(s, 20 + i) * 2e7) }),
            )
          : [],
        source: SOURCE,
      };
    },

    async financials(security, statement, period): Promise<FinancialStatement | null> {
      const e = equity(security);
      if (!e) return null;
      const ends = periodEnds(period, new Date(deps.now()));
      const records = ends.map((date, i) => {
        const yearsBack = period === "annual" ? ends.length - i : (ends.length - i) / 4;
        const scale = Math.pow(1 + e.m.growth, -yearsBack) * (period === "annual" ? 1 : 0.25 * (0.9 + 0.2 * rand(e.m.s, 30 + i)));
        const values = statementValues(statement, e.m.revenue * scale, e.m.grossMargin, e.m.shares);
        return { date, values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)])) };
      });
      return buildStatement(e.security, statement, period, records, SOURCE);
    },

    async earnings(security) {
      const e = equity(security);
      if (!e) return null;
      const quarterly = e.m.eps / 4;
      const ends = periodEnds("quarterly", new Date(deps.now())).slice(-4);
      return {
        security: e.security,
        currency: e.currency,
        nextDate: new Date(deps.now() + 30 * DAY).toISOString(),
        history: ends.map((quarter, i) => {
          const estimate = round(quarterly * (0.92 + 0.04 * i), 4);
          const surprisePct = round((rand(e.m.s, 40 + i) - 0.35) * 10, 3);
          return { quarter, estimate, actual: round(estimate * (1 + surprisePct / 100), 4), surprisePct };
        }),
        estimates: ["Current Qtr", "Next Qtr", "Current Year", "Next Year"].map((period, i) => {
          const annual = i >= 2;
          const eps = (annual ? e.m.eps : quarterly) * (1 + e.m.growth * (i % 2 ? 1 : 0.5));
          const revenue = (annual ? e.m.revenue : e.m.revenue / 4) * (1 + e.m.growth * (i % 2 ? 1 : 0.5));
          return {
            period,
            endDate: null,
            epsAvg: round(eps, 4),
            epsLow: round(eps * 0.94, 4),
            epsHigh: round(eps * 1.06, 4),
            epsYearAgo: round(eps / (1 + e.m.growth), 4),
            epsGrowthPct: round(e.m.growth * 100, 3),
            revenueAvg: round(revenue),
            revenueLow: round(revenue * 0.97),
            revenueHigh: round(revenue * 1.03),
            revenueGrowthPct: round(e.m.growth * 100, 3),
            analysts: 10 + Math.floor(rand(e.m.s, 50 + i) * 30),
          };
        }),
        annual: [4, 3, 2, 1].map((back) => {
          const revenue = e.m.revenue * Math.pow(1 + e.m.growth, -back);
          return { year: String(new Date(deps.now()).getUTCFullYear() - back), revenue: round(revenue), earnings: round(revenue * (e.m.grossMargin - 0.16) * 0.8) };
        }),
        source: SOURCE,
      };
    },

    async analysts(security) {
      const e = equity(security);
      if (!e) return null;
      const price = e.q.last!;
      const mean = price * (1.02 + rand(e.m.s, 60) * 0.15);
      const trend = ["Current", "1M Ago", "2M Ago", "3M Ago"].map((period, i) => ({
        period,
        strongBuy: 4 + Math.floor(rand(e.m.s, 61 + i) * 8),
        buy: 8 + Math.floor(rand(e.m.s, 65 + i) * 12),
        hold: 5 + Math.floor(rand(e.m.s, 69 + i) * 10),
        sell: Math.floor(rand(e.m.s, 73 + i) * 4),
        strongSell: Math.floor(rand(e.m.s, 77 + i) * 2),
      }));
      const grades = ["Buy", "Overweight", "Outperform", "Neutral", "Hold", "Equal-Weight"];
      const actions = ["Maintains", "Reiterates", "Upgrade", "Downgrade", "Initiates"];
      return {
        security: e.security,
        currency: e.currency,
        currentPrice: price,
        recommendationMean: round(1.6 + rand(e.m.s, 80) * 1.4, 3),
        recommendation: "buy",
        analystCount: trend[0].strongBuy + trend[0].buy + trend[0].hold + trend[0].sell + trend[0].strongSell,
        targetMean: round(mean),
        targetMedian: round(mean * 1.01),
        targetHigh: round(mean * 1.25),
        targetLow: round(mean * 0.72),
        trend,
        actions: Array.from({ length: 10 }, (_, i) => {
          const target = round(mean * (0.9 + rand(e.m.s, 90 + i) * 0.25), 4);
          return {
            date: new Date(deps.now() - (i * 6 + 1) * DAY).toISOString(),
            firm: `Broker ${String.fromCharCode(65 + i)}`,
            action: actions[Math.floor(rand(e.m.s, 100 + i) * actions.length)],
            fromGrade: grades[Math.floor(rand(e.m.s, 110 + i) * grades.length)],
            toGrade: grades[Math.floor(rand(e.m.s, 120 + i) * grades.length)],
            target,
            priorTarget: round(target * (0.93 + rand(e.m.s, 130 + i) * 0.1), 4),
          };
        }),
        source: SOURCE,
      };
    },

    async holders(security) {
      const e = equity(security);
      if (!e) return null;
      const price = e.q.last!;
      const list = (prefix: string, base: number, seed: number) =>
        Array.from({ length: 10 }, (_, i) => {
          const heldPct = round(base / (i + 1.3), 4);
          const shares = Math.round((e.m.shares * heldPct) / 100);
          return {
            name: `${prefix} ${String.fromCharCode(65 + i)}`,
            reportDate: new Date(deps.now() - 90 * DAY).toISOString(),
            heldPct,
            shares,
            value: Math.round(shares * price),
            changePct: round((rand(e.m.s, seed + i) - 0.5) * 8, 3),
          };
        });
      return {
        security: e.security,
        insidersPct: round(0.3 + rand(e.m.s, 140) * 4, 3),
        institutionsPct: round(55 + rand(e.m.s, 141) * 25, 3),
        institutionsFloatPct: round(57 + rand(e.m.s, 142) * 25, 3),
        institutionCount: 2000 + Math.floor(rand(e.m.s, 143) * 5000),
        institutions: list("Institution", 9, 150),
        funds: list("Fund", 3.5, 170),
        insiders: ["Chief Executive Officer", "Chief Financial Officer", "Director", "Director", "General Counsel"].map((relation, i) => ({
          name: `Insider ${String.fromCharCode(65 + i)}`,
          relation,
          shares: Math.round(10_000 + rand(e.m.s, 190 + i) * 3_000_000),
          lastTransaction: rand(e.m.s, 200 + i) > 0.5 ? "Sale" : "Stock Award",
          date: new Date(deps.now() - (20 + i * 30) * DAY).toISOString(),
        })),
        source: SOURCE,
      };
    },

    async events(security) {
      const q = deps.quote(security);
      if (!q) return null;
      const e = equity(security);
      const now = new Date(deps.now());
      const dividends: { date: string; amount: number }[] = [];
      if (e?.m.payer) {
        const quarterlyNow = (q.last! * e.m.yieldPct) / 100 / 4;
        for (let back = 39; back >= 0; back--) {
          const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back * 3 - 1, 10, 13, 30));
          if (d.getTime() > deps.now()) continue;
          dividends.push({ date: d.toISOString(), amount: round(quarterlyNow * Math.pow(1.06, -back / 4), 4) });
        }
      }
      return {
        security: q.security,
        currency: q.currency,
        dividendRate: e?.m.payer ? round((q.last! * e.m.yieldPct) / 100, 4) : null,
        dividendYieldPct: e?.m.payer ? round(e.m.yieldPct, 3) : null,
        payoutRatioPct: e?.m.payer ? round(e.m.yieldPct * e.m.pe, 3) : null,
        exDividendDate: dividends.at(-1)?.date ?? null,
        payDate: dividends.length ? new Date(Date.parse(dividends.at(-1)!.date) + 3 * DAY).toISOString() : null,
        dividends,
        splits: [],
        source: SOURCE,
      };
    },

    async options(security, expiration) {
      const e = equity(security);
      if (!e) return null;
      const spot = e.q.last!;
      const expirations = fridays(deps.now(), 8);
      const exp = expiration && expirations.includes(expiration) ? expiration : expirations[0];
      const t = Math.max((Date.parse(exp) + 20 * 3_600_000 - deps.now()) / (365 * DAY), 1 / 365);
      const step = strikeStep(spot);
      const atm = Math.round(spot / step) * step;
      const strikes = Array.from({ length: 21 }, (_, i) => round(atm + (i - 10) * step, 6)).filter((k) => k > 0);
      const quote = (kind: "call" | "put", strike: number, i: number): OptionQuote => {
        const vol = 0.24 + 0.08 * Math.abs(Math.log(strike / spot)) * 5;
        const v = blackScholes(kind, { spot, strike, t, vol, rate: 0.04, carry: (e.m.yieldPct || 0) / 100 });
        const price = Math.max(v.price, 0.01);
        const code = `${e.security.split(" ")[0]}${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${kind === "call" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
        return {
          contract: code,
          strike,
          last: round(price, 4),
          bid: round(price * 0.98, 4),
          ask: round(price * 1.02, 4),
          change: round(price * (rand(e.m.s, 300 + i) - 0.5) * 0.2, 4),
          volume: Math.floor(rand(e.m.s, 400 + i) * 5000),
          openInterest: Math.floor(rand(e.m.s, 500 + i) * 20000),
          iv: round(vol, 4),
          itm: kind === "call" ? strike < spot : strike > spot,
        };
      };
      return {
        security: e.security,
        underlying: spot,
        expirations,
        expiration: exp,
        calls: strikes.map((k, i) => quote("call", k, i)),
        puts: strikes.map((k, i) => quote("put", k, i + 50)),
        source: SOURCE,
      };
    },

    async related(security) {
      const key = normalizeSecurity(security);
      return deps.equities.filter((e) => e.security !== key).slice(0, 6).map((e) => e.security);
    },

    async valuations(securities): Promise<Valuation[]> {
      return securities.flatMap((s) => {
        const q = deps.quote(s);
        if (!q) return [];
        const e = equity(s);
        return [
          {
            security: q.security,
            name: q.name,
            currency: q.currency,
            last: q.last,
            changePct: q.changePct,
            marketCap: e ? round(e.m.marketCap) : null,
            pe: e ? round(e.m.pe, 4) : null,
            forwardPe: e ? round(e.m.pe * 0.9, 4) : null,
            priceToBook: e ? round(3 + rand(hash(q.security), 2) * 20, 4) : null,
            eps: e ? round(e.m.eps, 4) : null,
            dividendYieldPct: e?.m.payer ? round(e.m.yieldPct, 3) : null,
          },
        ];
      });
    },

    async futuresChain(security) {
      const key = normalizeSecurity(security);
      const contracts = futuresContracts(security, new Date(deps.now()), 12).flatMap((c) => {
        const q = deps.quote(c.security);
        if (!q) return [];
        return [
          {
            security: c.security,
            name: q.name,
            month: c.month,
            last: q.last,
            change: q.change,
            changePct: q.changePct,
            volume: q.volume,
            openInterest: q.volume !== null ? Math.round(q.volume * 3.5) : null,
            expiry: null,
          },
        ];
      });
      return key && contracts.length ? { security: key, contracts, source: SOURCE } : null;
    },

    async companyNews(security) {
      const q = deps.quote(security);
      return q ? headlines(HEADLINES, q.name, 12, deps.now(), `cn|${q.security}`) : [];
    },

    async news(query) {
      return headlines(HEADLINES, query, 15, deps.now(), `n|${query}`);
    },

    async topNews() {
      return headlines(MARKET_HEADLINES, null, 15, deps.now(), "top");
    },

    async screen(id): Promise<ScreenRow[]> {
      if (!(id in SCREENS)) return [];
      const rows = deps.equities.flatMap((e) => {
        const q = deps.quote(e.security);
        if (!q) return [];
        const m = q.last ? model(e.security, q.last) : null;
        return [
          {
            security: q.security,
            name: q.name,
            last: q.last,
            change: q.change,
            changePct: q.changePct,
            volume: q.volume,
            marketCap: m ? round(m.marketCap) : null,
            currency: q.currency,
          },
        ];
      });
      const by = (f: (r: ScreenRow) => number) => rows.sort((a, b) => f(b) - f(a));
      if (id === "most_actives") return by((r) => r.volume ?? 0);
      if (id === "day_losers") return by((r) => -(r.changePct ?? 0));
      if (id === "day_gainers") return by((r) => r.changePct ?? 0);
      const s = hash(id);
      return by((r) => rand(s, hash(r.security)));
    },

    async yieldCurve() {
      return mockCurve("US Treasury Actives", 0);
    },

    async sovereignCurves() {
      return [mockCurve("Euro Area AAA Govt (ECB)", -1.1), mockCurve("Japan Govt Bonds (MOF)", -1.9), mockCurve("Canada Govt Benchmarks (BoC)", -0.6), mockCurve("UK Gilts, Zero Coupon (BoE)", 0.7)];
    },

    async moneyMarkets() {
      const date = new Date(deps.now() - DAY).toISOString().slice(0, 10);
      return {
        rates: [
          { name: "Fed Funds Target (Upper)", ratePct: 4.0, date, note: "Range 3.75-4.00" },
          { name: "Effective Fed Funds (EFFR)", ratePct: 3.88, date, note: null },
          { name: "Overnight Bank Funding (OBFR)", ratePct: 3.88, date, note: null },
          { name: "SOFR", ratePct: 3.88, date, note: null },
        ],
        source: SOURCE,
      };
    },

    async econStats(): Promise<EconStats> {
      const indicators = [
        { id: "NY.GDP.MKTP.KD.ZG", name: "GDP Growth %", lo: -1, hi: 7 },
        { id: "FP.CPI.TOTL.ZG", name: "CPI Inflation %", lo: 0.5, hi: 8 },
        { id: "SL.UEM.TOTL.ZS", name: "Unemployment %", lo: 2.5, hi: 12 },
        { id: "BN.CAB.XOKA.GD.ZS", name: "Current Acct % GDP", lo: -4, hi: 6 },
        { id: "NY.GDP.MKTP.CD", name: "GDP (USD)", lo: 0.8e12, hi: 28e12 },
      ];
      return {
        indicators: indicators.map(({ id, name }) => ({ id, name })),
        countries: Object.entries(ECON_NAMES).map(([code, name]) => ({
          code,
          name,
          values: Object.fromEntries(
            indicators.map((ind) => [ind.id, { value: round(ind.lo + rand(hash(`${code}|${ind.id}`), 0) * (ind.hi - ind.lo), 4), year: "2025" }]),
          ),
        })),
        source: SOURCE,
      };
    },

    async econCalendar() {
      const start = new Date(deps.now());
      start.setUTCHours(0, 0, 0, 0);
      return RELEASES.map((name, i) => ({
        date: new Date(start.getTime() + (1 + i * 3) * DAY).toISOString().slice(0, 10),
        name,
        source: SOURCE,
      }));
    },
  };
}

