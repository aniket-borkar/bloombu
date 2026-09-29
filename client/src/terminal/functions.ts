import type { Sector } from "./sectors";

export interface FunctionDef {
  code: string;
  name: string;
  /** Security-level functions operate on the panel's loaded security. */
  security: boolean;
}

const defs: FunctionDef[] = [
  { code: "DES", name: "Description", security: true },
  { code: "GP", name: "Price Graph", security: true },
  { code: "GIP", name: "Intraday Price Graph", security: true },
  { code: "GPO", name: "Bar Chart", security: true },
  { code: "HP", name: "Historical Price Table", security: true },
  { code: "BQ", name: "Bloomberg Quote", security: true },
  { code: "CN", name: "Company News", security: true },
  { code: "FA", name: "Financial Analysis", security: true },
  { code: "EE", name: "Earnings & Estimates", security: true },
  { code: "ERN", name: "Earnings History", security: true },
  { code: "ANR", name: "Analyst Recommendations", security: true },
  { code: "HDS", name: "Holdings: Holders", security: true },
  { code: "DVD", name: "Dividend/Split Summary", security: true },
  { code: "RV", name: "Relative Valuation", security: true },
  { code: "OMON", name: "Option Monitor", security: true },
  { code: "MGMT", name: "Management", security: true },
  { code: "SPLC", name: "Supply Chain", security: true },
  { code: "RELS", name: "Related Securities", security: true },
  { code: "BETA", name: "Historical Beta", security: true },
  { code: "TRA", name: "Total Return Analysis", security: true },
  { code: "MEMB", name: "Index Members", security: true },
  { code: "FRD", name: "Forward Rates", security: true },
  { code: "OVML", name: "Option Valuation", security: true },
  { code: "CT", name: "Contract Table", security: true },
  { code: "YAS", name: "Yield & Spread Analysis", security: true },
  { code: "QR", name: "Trade Recap", security: true },
  { code: "BTST", name: "Strategy Backtester", security: true },
  { code: "WEI", name: "World Equity Indices", security: false },
  { code: "W", name: "World Indices", security: false },
  { code: "WB", name: "World Bond Markets", security: false },
  { code: "WCRS", name: "World Currency Ranker", security: false },
  { code: "FXC", name: "FX Cross Rates", security: false },
  { code: "GC", name: "Curves & Surfaces", security: false },
  { code: "BTMM", name: "Treasury & Money Markets", security: false },
  { code: "GLCO", name: "Global Commodity Prices", security: false },
  { code: "TOP", name: "Top News", security: false },
  { code: "N", name: "News", security: false },
  { code: "MOST", name: "Most Active", security: false },
  { code: "IMAP", name: "Intraday Market Map", security: false },
  { code: "ECO", name: "Economic Calendar", security: false },
  { code: "ECST", name: "World Economic Statistics", security: false },
  { code: "WIRP", name: "World Interest Rate Probability", security: false },
  { code: "EQS", name: "Equity Screening", security: false },
  { code: "MSG", name: "Message System", security: false },
  { code: "IB", name: "Instant Bloomberg", security: false },
  { code: "BLP", name: "Launchpad", security: false },
  { code: "ASK", name: "AI Analyst", security: false },
  { code: "ALRT", name: "Alerts", security: false },
  { code: "LAYOUT", name: "Layouts & Workspaces", security: false },
  { code: "FLDS", name: "Field Search", security: false },
  { code: "SHEET", name: "Live Spreadsheet", security: false },
  { code: "BQL", name: "Query Language", security: false },
  { code: "PORT", name: "Portfolio & Risk Analytics", security: false },
  { code: "PRTU", name: "Portfolio Administration", security: false },
  { code: "TRADE", name: "Paper Trading", security: false },
  { code: "SRC", name: "Data Sources & Usage", security: false },
  { code: "BRIEF", name: "Personal Briefing", security: false },
  { code: "HELP", name: "Help", security: false },
];

export const FUNCTIONS: Record<string, FunctionDef> = Object.fromEntries(defs.map((d) => [d.code, d]));

export const FUNCTION_LIST = defs;

export function isFunction(code: string): boolean {
  return code.toUpperCase() in FUNCTIONS;
}

/** Numbered security menu shown after a security is loaded, per sector. */
export const SECURITY_MENUS: Record<Sector, string[]> = {
  Equity: ["DES", "GP", "GIP", "BQ", "CN", "FA", "EE", "ERN", "ANR", "HDS", "DVD", "RV", "OMON", "MGMT", "SPLC", "RELS", "BETA", "TRA", "HP", "QR", "BTST"],
  Index: ["DES", "GP", "GIP", "MEMB", "IMAP", "WEI", "CN", "HP", "TRA", "BTST"],
  Curncy: ["DES", "GP", "GIP", "QR", "FXC", "FRD", "OVML", "WCRS", "HP", "BTST"],
  Comdty: ["DES", "GP", "GIP", "CT", "GLCO", "HP", "BTST"],
  Govt: ["DES", "GP", "GIP", "YAS", "GC", "WB", "HP"],
  Corp: ["DES", "GP", "YAS", "HP"],
  Mtge: ["DES", "GP", "YAS", "HP"],
  "M-Mkt": ["DES", "GP", "BTMM", "HP"],
  Muni: ["DES", "GP", "YAS", "HP"],
  Pfd: ["DES", "GP", "DVD", "HP"],
};

/** Page size used by paged screens (security menus, help). */
export const PAGE_SIZE = 12;

export type HistoryInterval = "1m" | "5m" | "1h" | "1d" | "1wk";
export type HistoryRange = "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y";

export interface ChartOption {
  label: string;
  interval: HistoryInterval;
  range: HistoryRange;
}

/** Numbered range choices on chart screens, selected with `<n> <GO>`. */
export const CHART_OPTIONS: Record<string, { options: ChartOption[]; defaultIndex: number }> = {
  GP: {
    defaultIndex: 5,
    options: [
      { label: "1D", interval: "5m", range: "1d" },
      { label: "5D", interval: "5m", range: "5d" },
      { label: "1M", interval: "1h", range: "1mo" },
      { label: "3M", interval: "1d", range: "3mo" },
      { label: "6M", interval: "1d", range: "6mo" },
      { label: "1Y", interval: "1d", range: "1y" },
      { label: "5Y", interval: "1wk", range: "5y" },
    ],
  },
  GIP: {
    defaultIndex: 0,
    options: [
      { label: "1D", interval: "1m", range: "1d" },
      { label: "5D", interval: "5m", range: "5d" },
    ],
  },
  GPO: {
    defaultIndex: 3,
    options: [
      { label: "1D", interval: "5m", range: "1d" },
      { label: "5D", interval: "1h", range: "5d" },
      { label: "1M", interval: "1d", range: "1mo" },
      { label: "3M", interval: "1d", range: "3mo" },
      { label: "6M", interval: "1d", range: "6mo" },
      { label: "1Y", interval: "1wk", range: "1y" },
      { label: "5Y", interval: "1wk", range: "5y" },
    ],
  },
};
