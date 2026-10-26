import type { ProviderUsage } from "./providers/usage.js";

export type Sector =
  | "Govt"
  | "Corp"
  | "Mtge"
  | "M-Mkt"
  | "Muni"
  | "Pfd"
  | "Equity"
  | "Comdty"
  | "Index"
  | "Curncy";

export interface Quote {
  security: string;
  name: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  /** Session supplying last/time/change; OHLC and volume can still be regular-session fields. */
  priceSession?: "regular" | "pre" | "post";
  /** Latest regular-session price, separate from the previous-day reference used by day P&L. */
  regularClose?: number | null;
  time: string | null;
  delayMinutes: number | null;
  source: string;
}

export interface IndexMember {
  security: string;
  name: string;
  sector: string | null;
}

export interface IndexMembers {
  index: string;
  name: string;
  /** How the index provider weights members; weights here are estimated from live prices and market caps. */
  weighting: "cap" | "price";
  source: string;
  sourceUrl: string | null;
  members: IndexMember[];
}

export interface MemberRow {
  security: string;
  name: string;
  sector: string | null;
  last: number | null;
  change: number | null;
  changePct: number | null;
  currency: string | null;
  marketCap: number | null;
  /** Estimated weight in the index, from full market cap (cap-weighted) or price (price-weighted). */
  weightPct: number | null;
  /** Estimated index points contributed by today's move. */
  points: number | null;
}

export interface MembersAnalysis {
  index: string;
  name: string;
  weighting: "cap" | "price";
  source: string;
  sourceUrl: string | null;
  level: number | null;
  change: number | null;
  changePct: number | null;
  total: number;
  priced: number;
  advancers: number;
  decliners: number;
  members: MemberRow[];
  sectors: { sector: string; weightPct: number; points: number; count: number }[];
}

export interface Brief {
  asOf: string;
  markets: { security: string; name: string; last: number | null; change: number | null; changePct: number | null }[];
  gainers: ScreenRow[];
  losers: ScreenRow[];
  portfolios: {
    id: number;
    name: string;
    baseCurrency: string;
    marketValue: number;
    dayPnl: number;
    dayPct: number | null;
    best: { security: string; dayPnl: number } | null;
    worst: { security: string; dayPnl: number } | null;
  }[];
  alerts: { active: number; triggeredToday: { security: string; description: string; at: number }[] };
  nextFomc: { date: string; impliedChangeBp: number | null; direction: "hike" | "cut" | "hold" | null } | null;
  curve: { twoYear: number | null; tenYear: number | null; spreadBp: number | null } | null;
  headlines: Headline[];
}

export interface SourceSuggestion {
  name: string;
  unlocks: string;
  how: string;
}

export interface SourcesReport {
  providers: { id: string; note: string; capabilities: string[]; sectors: readonly string[]; usage: ProviderUsage }[];
  delivery: { pollingIntervalMs: number; nativeSilenceFallbackMs: number; stockStreamProviders: string[]; directCrypto: boolean };
  ai: { provider: string; model: string } | null;
  plugins: { name: string; functions: string[]; providers: string[] }[];
  signIn: boolean;
  suggestions: SourceSuggestion[];
}

export type OrderType = "market" | "limit" | "stop";
export type OrderSide = "buy" | "sell";
export type OrderStatus = "open" | "filled" | "cancelled" | "rejected";

export interface PaperOrder {
  id: number;
  user: string;
  security: string;
  side: OrderSide;
  quantity: number;
  type: OrderType;
  limitPrice: number | null;
  stopPrice: number | null;
  status: OrderStatus;
  created: number;
  filledAt: number | null;
  fillPrice: number | null;
  /** Currency the fill settled in (pence-quoted prices settle in pounds). */
  currency: string | null;
  reason: string | null;
}

export interface PaperPosition {
  security: string;
  quantity: number;
  /** Average cost in the security's quoted units (pence for GBp listings). */
  avgCost: number;
  currency: string;
}

export interface PaperAccount {
  user: string;
  startingCash: number;
  cash: Record<string, number>;
  positions: PaperPosition[];
  orders: PaperOrder[];
}

export interface OvernightRate {
  currency: string;
  name: string;
  ratePct: number;
  date: string;
  source: string;
}

export interface ForwardRow {
  tenor: string;
  days: number;
  outright: number;
  /** Forward minus spot in pips (0.0001; 0.01 for JPY-quoted pairs). */
  points: number;
}

export interface ForwardCurve {
  security: string;
  spot: number;
  base: OvernightRate;
  quote: OvernightRate;
  rows: ForwardRow[];
  method: string;
}

/** A scheduled FOMC meeting; `date` is the decision (second) day. `sep` marks meetings with projections. */
export interface FomcMeeting {
  date: string;
  sep: boolean;
}

export interface WirpMeeting {
  date: string;
  sep: boolean;
  contract: string | null;
  /** Fed funds rate implied after this meeting. */
  impliedRatePct: number | null;
  /** Change priced at this meeting, and since today, in basis points. */
  stepBp: number | null;
  cumulativeBp: number | null;
  /** Cumulative number of 25bp moves priced (negative for cuts). */
  movesPriced: number | null;
  /** Probability of a 25bp move at this meeting; above 100 means more than one move is priced. */
  probabilityPct: number | null;
  direction: "hike" | "cut" | "hold" | null;
}

export interface RateProbabilities {
  currentRatePct: number;
  targetLow: number | null;
  targetHigh: number | null;
  meetings: WirpMeeting[];
  /** Average fed funds rate implied by each monthly futures contract. */
  months: { month: string; contract: string; price: number | null; impliedRatePct: number | null }[];
  source: string;
}

/** One printed trade. `side` is the aggressor (buyer- or seller-initiated) when the source reports it. */
export interface Trade {
  time: string;
  price: number;
  size: number | null;
  side: "buy" | "sell" | null;
  venue: string | null;
}

export type Interval = "1m" | "5m" | "1h" | "1d" | "1wk";

export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "1h": 3_600_000,
  "1d": 86_400_000,
  "1wk": 604_800_000,
};

/** OHLCV bar; `t` is the bar start in Unix milliseconds. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface SearchResult {
  security: string;
  name: string;
  sector: Sector;
  exchange: string | null;
}

// Research data. Every field named `*Pct` is in percent units (1.5 = 1.5%).

export interface Officer {
  name: string;
  title: string;
  age: number | null;
  totalPay: number | null;
}

export interface Profile {
  security: string;
  name: string;
  summary: string | null;
  sector: string | null;
  industry: string | null;
  website: string | null;
  employees: number | null;
  address: string | null;
  currency: string | null;
  exchange: string | null;
  marketCap: number | null;
  enterpriseValue: number | null;
  sharesOutstanding: number | null;
  floatShares: number | null;
  pe: number | null;
  forwardPe: number | null;
  eps: number | null;
  priceToBook: number | null;
  beta: number | null;
  dividendRate: number | null;
  dividendYieldPct: number | null;
  exDividendDate: string | null;
  high52: number | null;
  low52: number | null;
  avgVolume: number | null;
  shortFloatPct: number | null;
  nextEarnings: string | null;
  officers: Officer[];
  source: string;
}

export type Statement = "income" | "balance" | "cashflow";
export type StatementPeriod = "annual" | "quarterly";

export interface FinancialStatement {
  security: string;
  statement: Statement;
  period: StatementPeriod;
  /** Period end dates (ISO), oldest first. */
  columns: string[];
  rows: { key: string; label: string; values: (number | null)[] }[];
  source: string;
}

export interface EarningsEstimate {
  period: string;
  endDate: string | null;
  epsAvg: number | null;
  epsLow: number | null;
  epsHigh: number | null;
  epsYearAgo: number | null;
  epsGrowthPct: number | null;
  revenueAvg: number | null;
  revenueLow: number | null;
  revenueHigh: number | null;
  revenueGrowthPct: number | null;
  analysts: number | null;
}

export interface Earnings {
  security: string;
  currency: string | null;
  nextDate: string | null;
  history: { quarter: string; actual: number | null; estimate: number | null; surprisePct: number | null }[];
  estimates: EarningsEstimate[];
  annual: { year: string; revenue: number | null; earnings: number | null }[];
  source: string;
}

export interface Analysts {
  security: string;
  currency: string | null;
  currentPrice: number | null;
  recommendationMean: number | null;
  recommendation: string | null;
  analystCount: number | null;
  targetMean: number | null;
  targetMedian: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  trend: { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }[];
  actions: {
    date: string;
    firm: string;
    action: string;
    fromGrade: string | null;
    toGrade: string | null;
    target: number | null;
    priorTarget: number | null;
  }[];
  source: string;
}

export interface Holding {
  name: string;
  reportDate: string | null;
  heldPct: number | null;
  shares: number | null;
  value: number | null;
  changePct: number | null;
}

export interface Holders {
  security: string;
  insidersPct: number | null;
  institutionsPct: number | null;
  institutionsFloatPct: number | null;
  institutionCount: number | null;
  institutions: Holding[];
  funds: Holding[];
  insiders: { name: string; relation: string | null; shares: number | null; lastTransaction: string | null; date: string | null }[];
  source: string;
}

export interface CorporateEvents {
  security: string;
  currency: string | null;
  dividendRate: number | null;
  dividendYieldPct: number | null;
  payoutRatioPct: number | null;
  exDividendDate: string | null;
  payDate: string | null;
  dividends: { date: string; amount: number }[];
  splits: { date: string; ratio: string }[];
  source: string;
}

export interface Headline {
  id: string;
  title: string;
  source: string;
  time: string | null;
  url: string | null;
}

export interface OptionQuote {
  contract: string;
  strike: number;
  last: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  volume: number | null;
  openInterest: number | null;
  /** Implied volatility as a fraction (0.25 = 25%). */
  iv: number | null;
  itm: boolean;
}

export interface OptionChain {
  security: string;
  underlying: number | null;
  expirations: string[];
  expiration: string | null;
  calls: OptionQuote[];
  puts: OptionQuote[];
  source: string;
}

export const SCREENS = {
  most_actives: "Most Actives",
  day_gainers: "Day Gainers",
  day_losers: "Day Losers",
  undervalued_large_caps: "Undervalued Large Caps",
  undervalued_growth_stocks: "Undervalued Growth Stocks",
  growth_technology_stocks: "Growth Technology Stocks",
  aggressive_small_caps: "Aggressive Small Caps",
  small_cap_gainers: "Small Caps with Momentum",
  most_shorted_stocks: "Most Shorted Stocks",
  portfolio_anchors: "Portfolio Anchors (Funds)",
} as const;

export type ScreenId = keyof typeof SCREENS;

export interface ScreenRow {
  security: string;
  name: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  marketCap: number | null;
  currency: string | null;
}

export interface Valuation {
  security: string;
  name: string;
  currency: string | null;
  last: number | null;
  changePct: number | null;
  marketCap: number | null;
  pe: number | null;
  forwardPe: number | null;
  priceToBook: number | null;
  eps: number | null;
  dividendYieldPct: number | null;
}

export interface FuturesContract {
  security: string;
  name: string;
  month: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  openInterest: number | null;
  expiry: string | null;
}

export interface FuturesChain {
  security: string;
  contracts: FuturesContract[];
  source: string;
}

export interface CurvePoint {
  tenor: string;
  years: number;
  yieldPct: number | null;
}

export interface YieldCurve {
  name: string;
  date: string;
  points: CurvePoint[];
  /** Earlier curves for comparison, e.g. one week and one month ago. */
  history: { label: string; date: string; points: CurvePoint[] }[];
  source: string;
}

export interface MoneyMarkets {
  rates: { name: string; ratePct: number | null; date: string | null; note: string | null }[];
  source: string;
}

export interface EconStats {
  indicators: { id: string; name: string }[];
  countries: { code: string; name: string; values: Record<string, { value: number | null; year: string | null }> }[];
  source: string;
}

export interface EconEvent {
  date: string;
  name: string;
  source: string;
}

export interface ChatMessage {
  id: number;
  room: string;
  user: string;
  text: string;
  ts: number;
}

// Portfolios. "positions" holds share quantities (a real portfolio); "model" holds
// percentage weights applied to a notional amount (a mock or target portfolio).

export type PortfolioKind = "positions" | "model";

export interface PortfolioHolding {
  security: string;
  /** Shares or units (positions portfolios). Negative for shorts. */
  quantity: number | null;
  /** Percentage weight (model portfolios). */
  weight: number | null;
  /** Cost per share in the instrument's quote currency. */
  cost: number | null;
  /** Acquisition date, YYYY-MM-DD. */
  acquired: string | null;
}

export interface PortfolioInput {
  name: string;
  kind: PortfolioKind;
  baseCurrency: string;
  notional: number | null;
  holdings: PortfolioHolding[];
}

export interface Portfolio extends PortfolioInput {
  id: number;
  user: string;
  created: number;
  updated: number;
}

export interface PortfolioSummary {
  id: number;
  name: string;
  kind: PortfolioKind;
  baseCurrency: string;
  count: number;
  updated: number;
}

export interface HoldingAnalytics {
  security: string;
  name: string;
  assetClass: string;
  sector: string;
  country: string;
  /** Quote currency after converting minor units (GBp -> GBP). */
  currency: string;
  quantity: number | null;
  last: number | null;
  prevClose: number | null;
  /** Multiplier from quoted price to major currency units (0.01 for pence). */
  priceScale: number;
  /** Base-currency units per one unit of `currency`. */
  fxToBase: number | null;
  marketValue: number | null;
  weightPct: number | null;
  dayPnl: number | null;
  costValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPct: number | null;
  periodReturnPct: number | null;
  contributionPct: number | null;
  riskContributionPct: number | null;
  error: string | null;
}

export interface ExposureRow {
  key: string;
  weightPct: number;
}

export interface PortfolioAnalytics {
  name: string;
  kind: PortfolioKind;
  baseCurrency: string;
  asOf: string;
  range: string;
  benchmark: string;
  totals: { marketValue: number; dayPnl: number; costValue: number | null; unrealizedPnl: number | null };
  holdings: HoldingAnalytics[];
  performance: {
    start: string | null;
    points: { t: number; portfolio: number; benchmark: number | null }[];
    totalReturnPct: number | null;
    benchmarkReturnPct: number | null;
    annualizedPct: number | null;
  };
  risk: {
    observations: number;
    volatilityPct: number | null;
    benchmarkVolatilityPct: number | null;
    beta: number | null;
    correlation: number | null;
    trackingErrorPct: number | null;
    informationRatio: number | null;
    sharpe: number | null;
    riskFreePct: number | null;
    maxDrawdownPct: number | null;
    maxDrawdownPeak: string | null;
    maxDrawdownTrough: string | null;
    var95Historical: number | null;
    var95Parametric: number | null;
    cvar95: number | null;
  };
  correlation: { securities: string[]; matrix: (number | null)[][] };
  exposures: { assetClass: ExposureRow[]; sector: ExposureRow[]; country: ExposureRow[]; currency: ExposureRow[] };
  attribution: { bySector: { key: string; weightPct: number; contributionPct: number }[]; totalContributionPct: number | null };
  warnings: string[];
}
