import type { Sector } from "./types.js";

const SECTORS: Record<string, Sector> = {
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

/** Bloomberg exchange code -> Yahoo suffix. */
const EXCHANGE_SUFFIX: Record<string, string> = {
  US: "",
  UN: "",
  UW: "",
  UQ: "",
  UA: "",
  UP: "",
  LN: ".L",
  GY: ".DE",
  GR: ".F",
  FP: ".PA",
  NA: ".AS",
  BB: ".BR",
  IM: ".MI",
  SM: ".MC",
  SW: ".SW",
  SS: ".ST",
  DC: ".CO",
  NO: ".OL",
  FH: ".HE",
  ID: ".IR",
  PL: ".LS",
  AV: ".VI",
  JT: ".T",
  JP: ".T",
  HK: ".HK",
  AU: ".AX",
  AT: ".AX",
  CN: ".TO",
  CT: ".TO",
  KS: ".KS",
  TT: ".TW",
  IN: ".NS",
  IB: ".BO",
  SP: ".SI",
  BZ: ".SA",
  MM: ".MX",
  CH: ".SS",
  C1: ".SS",
  C2: ".SZ",
};

export function isExchangeCode(code: string): boolean {
  return code in EXCHANGE_SUFFIX;
}

const SUFFIX_EXCHANGE: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_SUFFIX)
    .filter(([code]) => !["UN", "UW", "UQ", "UA", "UP", "GR", "JP", "AT", "CT", "IB", "C1"].includes(code))
    .map(([code, suffix]) => [suffix, code]),
);

export const INDEX_MAP: Record<string, string> = {
  SPX: "^GSPC",
  INDU: "^DJI",
  CCMP: "^IXIC",
  NDX: "^NDX",
  RTY: "^RUT",
  VIX: "^VIX",
  SPTSX: "^GSPTSE",
  MEXBOL: "^MXX",
  IBOV: "^BVSP",
  UKX: "^FTSE",
  DAX: "^GDAXI",
  CAC: "^FCHI",
  SX5E: "^STOXX50E",
  SXXP: "^STOXX",
  AEX: "^AEX",
  IBEX: "^IBEX",
  SMI: "^SSMI",
  NKY: "^N225",
  HSI: "^HSI",
  SHCOMP: "000001.SS",
  KOSPI: "^KS11",
  TWSE: "^TWII",
  AS51: "^AXJO",
  SENSEX: "^BSESN",
  NIFTY: "^NSEI",
  STI: "^STI",
  DXY: "DX-Y.NYB",
  USGG3M: "^IRX",
  USGG5YR: "^FVX",
  USGG10YR: "^TNX",
  USGG30YR: "^TYX",
};

const GOVT_MAP: Record<string, string> = {
  CT3M: "^IRX",
  CB3: "^IRX",
  CT5: "^FVX",
  CT10: "^TNX",
  CT30: "^TYX",
};

/** Bloomberg generic futures root (without the "1") -> Yahoo continuous contract. */
const COMDTY_MAP: Record<string, string> = {
  CL: "CL=F",
  CO: "BZ=F",
  NG: "NG=F",
  HO: "HO=F",
  XB: "RB=F",
  GC: "GC=F",
  SI: "SI=F",
  HG: "HG=F",
  PL: "PL=F",
  PA: "PA=F",
  C: "ZC=F",
  W: "ZW=F",
  S: "ZS=F",
  KC: "KC=F",
  SB: "SB=F",
  CC: "CC=F",
  CT: "CT=F",
  LC: "LE=F",
  ES: "ES=F",
  NQ: "NQ=F",
  DM: "YM=F",
  TY: "ZN=F",
  US: "ZB=F",
  FV: "ZF=F",
  TU: "ZT=F",
  FF: "ZQ=F",
};

/** Bloomberg futures root -> Yahoo root and exchange suffix for specific contract months. */
export const FUTURES_ROOTS: Record<string, { yahoo: string; exchange: string }> = {
  CL: { yahoo: "CL", exchange: "NYM" },
  CO: { yahoo: "BZ", exchange: "NYM" },
  NG: { yahoo: "NG", exchange: "NYM" },
  HO: { yahoo: "HO", exchange: "NYM" },
  XB: { yahoo: "RB", exchange: "NYM" },
  GC: { yahoo: "GC", exchange: "CMX" },
  SI: { yahoo: "SI", exchange: "CMX" },
  HG: { yahoo: "HG", exchange: "CMX" },
  PL: { yahoo: "PL", exchange: "NYM" },
  PA: { yahoo: "PA", exchange: "NYM" },
  C: { yahoo: "ZC", exchange: "CBT" },
  W: { yahoo: "ZW", exchange: "CBT" },
  S: { yahoo: "ZS", exchange: "CBT" },
  KC: { yahoo: "KC", exchange: "NYB" },
  SB: { yahoo: "SB", exchange: "NYB" },
  CC: { yahoo: "CC", exchange: "NYB" },
  CT: { yahoo: "CT", exchange: "NYB" },
  LC: { yahoo: "LE", exchange: "CME" },
  ES: { yahoo: "ES", exchange: "CME" },
  NQ: { yahoo: "NQ", exchange: "CME" },
  DM: { yahoo: "YM", exchange: "CBT" },
  TY: { yahoo: "ZN", exchange: "CBT" },
  US: { yahoo: "ZB", exchange: "CBT" },
  FV: { yahoo: "ZF", exchange: "CBT" },
  TU: { yahoo: "ZT", exchange: "CBT" },
  FF: { yahoo: "ZQ", exchange: "CBT" },
};

const MONTH_CODES = "FGHJKMNQUVXZ";
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");
const padRoot = (root: string) => (root.length === 1 ? `${root} ` : root);

/** Resolve a single-digit contract year to the nearest year from last year onward. */
function contractYear(digit: number, now: Date): number {
  const base = now.getUTCFullYear() - 1;
  return base + ((digit - (base % 10) + 10) % 10);
}

export interface ParsedContract {
  root: string;
  month: number;
  year: number;
}

/** Parse a specific futures contract such as "CLZ6" or "C Z6". */
export function parseContract(ticker: string, now = new Date()): ParsedContract | null {
  const m = ticker.match(/^([A-Z]{1,2})\s?([FGHJKMNQUVXZ])(\d)$/);
  if (!m || !FUTURES_ROOTS[m[1]]) return null;
  return { root: m[1], month: MONTH_CODES.indexOf(m[2]), year: contractYear(Number(m[3]), now) };
}

export interface ContractCandidate {
  security: string;
  yahoo: string;
  month: string;
}

/** The next `count` monthly contracts for a generic future such as "CL1 Comdty", nearest first. */
export function futuresContracts(security: string, now: Date, count: number): ContractCandidate[] {
  const p = parseSecurity(security);
  const root = p?.sector === "Comdty" ? p.ticker.match(/^([A-Z]{1,2})\s?\d$/)?.[1] : undefined;
  const info = root ? FUTURES_ROOTS[root] : undefined;
  if (!root || !info) return [];
  const out: ContractCandidate[] = [];
  for (let i = 0; i < count; i++) {
    const m = (now.getUTCMonth() + i) % 12;
    const y = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + i) / 12);
    const code = MONTH_CODES[m];
    out.push({
      security: `${padRoot(root)}${code}${y % 10} Comdty`,
      yahoo: `${info.yahoo}${code}${pad2(y % 100)}.${info.exchange}`,
      month: `${MONTH_NAMES[m]} ${pad2(y % 100)}`,
    });
  }
  return out;
}

const CRYPTO_MAP: Record<string, string> = {
  XBT: "BTC",
  XET: "ETH",
  XSO: "SOL",
};

/** Exchange product id ("BTC-USD") for a crypto pair such as "XBTUSD Curncy", else null. */
export function cryptoPair(security: string): string | null {
  const p = parseSecurity(security);
  if (p?.sector !== "Curncy") return null;
  const code = p.ticker.replace(/\s/g, "");
  const base = code.slice(0, 3);
  if (!CRYPTO_MAP[base]) return null;
  if (code.length === 3) return `${CRYPTO_MAP[base]}-USD`;
  return /^[A-Z]{6}$/.test(code) ? `${CRYPTO_MAP[base]}-${code.slice(3)}` : null;
}

/** Currencies quoted as XXXUSD by market convention; everything else is USDXXX. */
const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD", "XAU", "XAG"]);

export interface ParsedSecurity {
  ticker: string;
  exchange: string | null;
  sector: Sector;
}

export function parseSecurity(input: string): ParsedSecurity | null {
  const tokens = input.trim().toUpperCase().replace(/[<>]/g, " ").split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const sector = SECTORS[tokens[tokens.length - 1]];
  if (!sector) return null;
  const body = tokens.slice(0, -1);
  if (sector === "Equity" && body.length >= 2) {
    return { ticker: body.slice(0, -1).join(" "), exchange: body[body.length - 1], sector };
  }
  return { ticker: body.join(" "), exchange: null, sector };
}

export function formatSecurity(p: ParsedSecurity): string {
  return [p.ticker, p.exchange, p.sector].filter(Boolean).join(" ");
}

/** Canonical form used as a key everywhere, e.g. "aapl us <equity>" -> "AAPL US Equity". */
export function normalizeSecurity(security: string): string | null {
  const p = parseSecurity(security);
  return p ? formatSecurity(p) : null;
}

export function sectorOf(security: string): Sector | null {
  return parseSecurity(security)?.sector ?? null;
}

/** Ticker portion without the sector, e.g. "AAPL US" for "AAPL US Equity". */
export function tickerOf(security: string): string {
  return security.trim().split(/\s+/).slice(0, -1).join(" ");
}

/** Map a Bloomberg-style security string to a Yahoo Finance symbol. */
export function toYahoo(input: string): string | null {
  const p = parseSecurity(input);
  if (!p) return null;
  const t = p.ticker.replace(/\s+/g, " ");
  switch (p.sector) {
    case "Equity": {
      const suffix = p.exchange ? EXCHANGE_SUFFIX[p.exchange] : "";
      if (suffix === undefined) return null;
      let sym = t.replace(/\//g, "-").replace(/ /g, "-");
      if (suffix === ".HK") sym = sym.padStart(4, "0");
      return sym + suffix;
    }
    case "Index":
      return INDEX_MAP[t] ?? null;
    case "Govt":
      return GOVT_MAP[t] ?? null;
    case "Comdty": {
      const generic = t.match(/^([A-Z]{1,2})\s?\d$/);
      if (generic && COMDTY_MAP[generic[1]]) return COMDTY_MAP[generic[1]];
      const c = parseContract(t);
      if (!c) return null;
      const info = FUTURES_ROOTS[c.root];
      return `${info.yahoo}${MONTH_CODES[c.month]}${pad2(c.year % 100)}.${info.exchange}`;
    }
    case "Curncy": {
      const code = t.replace(/\s/g, "");
      if (/^[A-Z]{6}$/.test(code)) {
        const base = code.slice(0, 3);
        const quote = code.slice(3);
        if (CRYPTO_MAP[base]) return `${CRYPTO_MAP[base]}-${quote}`;
        return `${code}=X`;
      }
      if (/^[A-Z]{3}$/.test(code)) {
        if (CRYPTO_MAP[code]) return `${CRYPTO_MAP[code]}-USD`;
        if (code === "USD") return null;
        return USD_QUOTED.has(code) ? `${code}USD=X` : `USD${code}=X`;
      }
      return null;
    }
    default:
      return null;
  }
}

const REVERSE_INDEX = Object.fromEntries(Object.entries(INDEX_MAP).map(([k, v]) => [v, k]));
const REVERSE_COMDTY = Object.fromEntries(Object.entries(COMDTY_MAP).map(([k, v]) => [v, k]));

/** Map a Yahoo symbol + quote type back to a Bloomberg-style security string. */
export function fromYahoo(symbol: string, quoteType: string | undefined): string | null {
  const type = (quoteType ?? "").toUpperCase();
  if (type === "INDEX") {
    const bb = REVERSE_INDEX[symbol];
    return bb ? `${bb} Index` : null;
  }
  if (type === "FUTURE") {
    const root = REVERSE_COMDTY[symbol];
    if (root) return `${padRoot(root)}1 Comdty`;
    const m = symbol.match(/^([A-Z]{1,2})([FGHJKMNQUVXZ])(\d{2})\.([A-Z]{3})$/);
    if (!m) return null;
    const bb = Object.entries(FUTURES_ROOTS).find(([, v]) => v.yahoo === m[1] && v.exchange === m[4])?.[0];
    return bb ? `${padRoot(bb)}${m[2]}${Number(m[3]) % 10} Comdty` : null;
  }
  if (type === "CURRENCY") {
    const m = symbol.match(/^([A-Z]{6})=X$/);
    return m ? `${m[1]} Curncy` : null;
  }
  if (type === "CRYPTOCURRENCY") {
    const m = symbol.match(/^([A-Z]+)-([A-Z]{3})$/);
    if (!m) return null;
    const bb = Object.entries(CRYPTO_MAP).find(([, v]) => v === m[1])?.[0];
    return bb ? `${bb}${m[2]} Curncy` : null;
  }
  if (type === "EQUITY" || type === "ETF" || type === "MUTUALFUND") {
    const dot = symbol.lastIndexOf(".");
    const suffix = dot > 0 ? symbol.slice(dot) : "";
    const exch = SUFFIX_EXCHANGE[suffix];
    if (exch === undefined) return null;
    let base = dot > 0 ? symbol.slice(0, dot) : symbol;
    if (exch === "HK") base = base.replace(/^0+/, "");
    return `${base.replace(/-/g, "/")} ${exch} Equity`;
  }
  return null;
}
