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

/** Yellow market-sector keys, in keyboard order. `key` is the label printed on the key. */
export const SECTOR_KEYS: { fkey: string; key: string; sector: Sector }[] = [
  { fkey: "F2", key: "GOVT", sector: "Govt" },
  { fkey: "F3", key: "CORP", sector: "Corp" },
  { fkey: "F4", key: "MTGE", sector: "Mtge" },
  { fkey: "F5", key: "M-MKT", sector: "M-Mkt" },
  { fkey: "F6", key: "MUNI", sector: "Muni" },
  { fkey: "F7", key: "PFD", sector: "Pfd" },
  { fkey: "F8", key: "EQUITY", sector: "Equity" },
  { fkey: "F9", key: "CMDTY", sector: "Comdty" },
  { fkey: "F10", key: "INDEX", sector: "Index" },
  { fkey: "F11", key: "CRNCY", sector: "Curncy" },
];

/** Every spelling accepted on the command line for a sector. */
export const SECTOR_TOKENS: Record<string, Sector> = {
  GOVT: "Govt",
  CORP: "Corp",
  MTGE: "Mtge",
  "M-MKT": "M-Mkt",
  MMKT: "M-Mkt",
  MUNI: "Muni",
  PFD: "Pfd",
  EQUITY: "Equity",
  COMDTY: "Comdty",
  CMDTY: "Comdty",
  INDEX: "Index",
  CURNCY: "Curncy",
  CRNCY: "Curncy",
};

export function sectorOf(security: string | null): Sector | null {
  if (!security) return null;
  const last = security.trim().split(/\s+/).pop()?.toUpperCase() ?? "";
  return SECTOR_TOKENS[last] ?? null;
}

/** The ticker portion of a security string, e.g. "AAPL US" for "AAPL US Equity". */
export function tickerOf(security: string): string {
  return security.trim().split(/\s+/).slice(0, -1).join(" ");
}
