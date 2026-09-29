import type {
  Analysts,
  Bar,
  CorporateEvents,
  Earnings,
  EconEvent,
  EconStats,
  FinancialStatement,
  FomcMeeting,
  FuturesChain,
  Headline,
  Holders,
  IndexMembers,
  Interval,
  MoneyMarkets,
  OptionChain,
  OvernightRate,
  Profile,
  Quote,
  ScreenId,
  ScreenRow,
  SearchResult,
  Sector,
  Statement,
  StatementPeriod,
  Trade,
  Valuation,
  YieldCurve,
} from "../types.js";
import type { RateLimit } from "./usage.js";

export interface ProviderPlugin {
  id: string;
  /** Env var holding this provider's API key; the plugin is skipped when it is unset. */
  requiresKey?: string;
  /** Market sectors this provider can price. Capabilities that take no security ignore this. */
  sectors: readonly Sector[];
  /** Narrower than sectors: when present, only securities it returns true for are routed here. */
  covers?(security: string): boolean;
  /** Free-tier request budget; the router skips this provider rather than exceed it. */
  rateLimit?: RateLimit;

  /** Return quotes for the securities it can price; omit the rest so the router can fall back. */
  quotes?(securities: string[]): Promise<Quote[]>;
  search?(query: string): Promise<SearchResult[]>;
  history?(security: string, interval: Interval, from: Date, to: Date): Promise<Bar[]>;
  /** Native push updates. Returns an unsubscribe function. */
  subscribe?(securities: string[], onQuote: (q: Quote) => void): () => void;
  /** Individual trades as they print (time and sales). Returns an unsubscribe function. */
  subscribeTrades?(security: string, onTrade: (t: Trade) => void): () => void;

  // Security research. Return null (or an empty list) when the security is not covered.
  profile?(security: string): Promise<Profile | null>;
  financials?(security: string, statement: Statement, period: StatementPeriod): Promise<FinancialStatement | null>;
  earnings?(security: string): Promise<Earnings | null>;
  analysts?(security: string): Promise<Analysts | null>;
  holders?(security: string): Promise<Holders | null>;
  events?(security: string): Promise<CorporateEvents | null>;
  options?(security: string, expiration: string | null): Promise<OptionChain | null>;
  related?(security: string): Promise<string[]>;
  valuations?(securities: string[]): Promise<Valuation[]>;
  futuresChain?(security: string): Promise<FuturesChain | null>;
  companyNews?(security: string): Promise<Headline[]>;
  indexMembers?(security: string): Promise<IndexMembers | null>;

  // Market-wide data.
  news?(query: string): Promise<Headline[]>;
  topNews?(): Promise<Headline[]>;
  screen?(id: ScreenId): Promise<ScreenRow[]>;
  yieldCurve?(): Promise<YieldCurve | null>;
  moneyMarkets?(): Promise<MoneyMarkets | null>;
  econStats?(): Promise<EconStats | null>;
  econCalendar?(): Promise<EconEvent[]>;
  fomcCalendar?(): Promise<FomcMeeting[]>;
  overnightRates?(): Promise<OvernightRate[]>;
  /** Government curves other than the US Treasury curve (which is yieldCurve). */
  sovereignCurves?(): Promise<YieldCurve[]>;
}

export const SECURITY_CAPABILITIES = [
  "quotes",
  "history",
  "subscribe",
  "subscribeTrades",
  "profile",
  "financials",
  "earnings",
  "analysts",
  "holders",
  "events",
  "options",
  "related",
  "valuations",
  "futuresChain",
  "companyNews",
  "indexMembers",
] as const;

export const MARKET_CAPABILITIES = [
  "search",
  "news",
  "topNews",
  "screen",
  "yieldCurve",
  "moneyMarkets",
  "econStats",
  "econCalendar",
  "fomcCalendar",
  "overnightRates",
  "sovereignCurves",
] as const;

export type Capability = (typeof SECURITY_CAPABILITIES)[number] | (typeof MARKET_CAPABILITIES)[number];

export const CAPABILITIES: readonly Capability[] = [...SECURITY_CAPABILITIES, ...MARKET_CAPABILITIES];

export const ALL_SECTORS = [
  "Govt",
  "Corp",
  "Mtge",
  "M-Mkt",
  "Muni",
  "Pfd",
  "Equity",
  "Comdty",
  "Index",
  "Curncy",
] as const satisfies readonly Sector[];
