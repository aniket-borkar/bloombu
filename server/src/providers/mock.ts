import type { ProviderPlugin } from "./DataProvider.js";
import { ALL_SECTORS } from "./DataProvider.js";
import { SECTOR_OF_TICKER, createMockResearch } from "./mockResearch.js";
import { gauss, hash, rand, round } from "./mockRandom.js";
import { INTERVAL_MS, type Bar, type Interval, type Quote, type SearchResult } from "../types.js";
import { normalizeSecurity, parseContract, sectorOf, tickerOf } from "../symbology.js";

interface MockSecurity {
  security: string;
  name: string;
  price: number;
  currency: string | null;
  exchange: string;
  /** Daily log-return standard deviation. */
  vol: number;
  /** Average daily volume; null where volume is not meaningful (spot FX, yields). */
  volume: number | null;
}

const m = (
  security: string,
  name: string,
  price: number,
  currency: string | null,
  exchange: string,
  vol: number,
  volume: number | null,
): MockSecurity => ({ security, name, price, currency, exchange, vol, volume });

export const MOCK_CATALOG: MockSecurity[] = [
  m("AAPL US Equity", "Apple Inc.", 340, "USD", "NasdaqGS", 0.018, 55e6),
  m("MSFT US Equity", "Microsoft Corporation", 520, "USD", "NasdaqGS", 0.016, 22e6),
  m("NVDA US Equity", "NVIDIA Corporation", 190, "USD", "NasdaqGS", 0.028, 180e6),
  m("AMZN US Equity", "Amazon.com, Inc.", 230, "USD", "NasdaqGS", 0.02, 40e6),
  m("GOOGL US Equity", "Alphabet Inc.", 250, "USD", "NasdaqGS", 0.019, 30e6),
  m("META US Equity", "Meta Platforms, Inc.", 740, "USD", "NasdaqGS", 0.022, 12e6),
  m("TSLA US Equity", "Tesla, Inc.", 420, "USD", "NasdaqGS", 0.035, 95e6),
  m("IBM US Equity", "International Business Machines Corporation", 280, "USD", "NYSE", 0.014, 4e6),
  m("JPM US Equity", "JPMorgan Chase & Co.", 310, "USD", "NYSE", 0.015, 9e6),
  m("VOD LN Equity", "Vodafone Group Plc", 95, "GBp", "London", 0.015, 60e6),
  m("SAP GY Equity", "SAP SE", 240, "EUR", "XETRA", 0.016, 2e6),
  m("7203 JT Equity", "Toyota Motor Corporation", 2900, "JPY", "Tokyo", 0.016, 25e6),
  m("XLK US Equity", "Technology Select Sector ETF", 280, "USD", "NYSEArca", 0.014, 8e6),
  m("XLF US Equity", "Financial Select Sector ETF", 52, "USD", "NYSEArca", 0.012, 40e6),
  m("XLV US Equity", "Health Care Select Sector ETF", 140, "USD", "NYSEArca", 0.01, 9e6),
  m("XLY US Equity", "Consumer Discretionary Select Sector ETF", 230, "USD", "NYSEArca", 0.013, 4e6),
  m("XLP US Equity", "Consumer Staples Select Sector ETF", 80, "USD", "NYSEArca", 0.008, 10e6),
  m("XLE US Equity", "Energy Select Sector ETF", 90, "USD", "NYSEArca", 0.016, 15e6),
  m("XLI US Equity", "Industrial Select Sector ETF", 150, "USD", "NYSEArca", 0.011, 9e6),
  m("XLB US Equity", "Materials Select Sector ETF", 90, "USD", "NYSEArca", 0.012, 5e6),
  m("XLU US Equity", "Utilities Select Sector ETF", 85, "USD", "NYSEArca", 0.009, 12e6),
  m("XLRE US Equity", "Real Estate Select Sector ETF", 42, "USD", "NYSEArca", 0.011, 6e6),
  m("XLC US Equity", "Communication Services Select Sector ETF", 110, "USD", "NYSEArca", 0.013, 5e6),
  m("INDU Index", "Dow Jones Industrial Average", 51800, "USD", "DJI", 0.009, 400e6),
  m("SPX Index", "S&P 500", 7740, "USD", "SNP", 0.01, 2.5e9),
  m("CCMP Index", "NASDAQ Composite", 27000, "USD", "Nasdaq GIDS", 0.013, 7e9),
  m("NDX Index", "Nasdaq 100", 24500, "USD", "Nasdaq GIDS", 0.013, null),
  m("RTY Index", "Russell 2000", 2840, "USD", "Russell", 0.014, null),
  m("VIX Index", "CBOE Volatility Index", 15, "USD", "CBOE", 0.06, null),
  m("SPTSX Index", "S&P/TSX Composite", 35800, "CAD", "Toronto", 0.008, null),
  m("MEXBOL Index", "S&P/BMV IPC", 58000, "MXN", "Mexico", 0.01, null),
  m("IBOV Index", "IBOVESPA", 140000, "BRL", "Sao Paulo", 0.012, null),
  m("UKX Index", "FTSE 100", 10700, "GBP", "FTSE", 0.009, null),
  m("DAX Index", "DAX Performance Index", 25400, "EUR", "XETRA", 0.011, null),
  m("CAC Index", "CAC 40", 8200, "EUR", "Paris", 0.011, null),
  m("SX5E Index", "EURO STOXX 50", 5600, "EUR", "STOXX", 0.011, null),
  m("SXXP Index", "STOXX Europe 600", 560, "EUR", "STOXX", 0.009, null),
  m("IBEX Index", "IBEX 35", 15500, "EUR", "Madrid", 0.011, null),
  m("AEX Index", "AEX Index", 950, "EUR", "Amsterdam", 0.01, null),
  m("SMI Index", "Swiss Market Index", 12500, "CHF", "Swiss", 0.009, null),
  m("NKY Index", "Nikkei 225", 48000, "JPY", "Osaka", 0.013, null),
  m("HSI Index", "Hang Seng Index", 26500, "HKD", "HKSE", 0.015, null),
  m("SHCOMP Index", "SSE Composite Index", 3900, "CNY", "Shanghai", 0.012, null),
  m("KOSPI Index", "KOSPI Composite", 3400, "KRW", "KSE", 0.012, null),
  m("TWSE Index", "TSEC Weighted Index", 25000, "TWD", "Taiwan", 0.012, null),
  m("AS51 Index", "S&P/ASX 200", 9000, "AUD", "ASX", 0.008, null),
  m("SENSEX Index", "S&P BSE SENSEX", 82000, "INR", "BSE", 0.009, null),
  m("NIFTY Index", "NIFTY 50", 25000, "INR", "NSE", 0.009, null),
  m("STI Index", "Straits Times Index", 4300, "SGD", "SES", 0.008, null),
  m("DXY Index", "US Dollar Index", 97, "USD", "ICE", 0.004, null),
  m("USGG3M Index", "US 13 Week Treasury Bill Yield", 4.24, null, "ICE", 0.01, null),
  m("USGG5YR Index", "US 5 Year Treasury Yield", 4.98, null, "ICE", 0.02, null),
  m("USGG10YR Index", "US 10 Year Treasury Yield", 4.2, null, "ICE", 0.02, null),
  m("USGG30YR Index", "US 30 Year Treasury Yield", 5.49, null, "ICE", 0.015, null),
  m("CT3M Govt", "US Treasury 3 Month Yield", 4.24, null, "ICE", 0.01, null),
  m("CT5 Govt", "US Treasury 5 Year Yield", 4.98, null, "ICE", 0.02, null),
  m("CT10 Govt", "US Treasury 10 Year Yield", 4.2, null, "ICE", 0.02, null),
  m("CT30 Govt", "US Treasury 30 Year Yield", 5.49, null, "ICE", 0.015, null),
  m("EURUSD Curncy", "Euro / US Dollar", 1.14, "USD", "CCY", 0.005, null),
  m("USDJPY Curncy", "US Dollar / Japanese Yen", 147, "JPY", "CCY", 0.006, null),
  m("GBPUSD Curncy", "British Pound / US Dollar", 1.34, "USD", "CCY", 0.005, null),
  m("USDCHF Curncy", "US Dollar / Swiss Franc", 0.79, "CHF", "CCY", 0.005, null),
  m("USDCAD Curncy", "US Dollar / Canadian Dollar", 1.38, "CAD", "CCY", 0.004, null),
  m("AUDUSD Curncy", "Australian Dollar / US Dollar", 0.66, "USD", "CCY", 0.006, null),
  m("NZDUSD Curncy", "New Zealand Dollar / US Dollar", 0.59, "USD", "CCY", 0.006, null),
  m("USDSEK Curncy", "US Dollar / Swedish Krona", 9.3, "SEK", "CCY", 0.006, null),
  m("USDNOK Curncy", "US Dollar / Norwegian Krone", 10.0, "NOK", "CCY", 0.006, null),
  m("USDCNY Curncy", "US Dollar / Chinese Yuan", 6.7, "CNY", "CCY", 0.002, null),
  m("USDHKD Curncy", "US Dollar / Hong Kong Dollar", 7.78, "HKD", "CCY", 0.0005, null),
  m("USDSGD Curncy", "US Dollar / Singapore Dollar", 1.28, "SGD", "CCY", 0.003, null),
  m("USDINR Curncy", "US Dollar / Indian Rupee", 88, "INR", "CCY", 0.003, null),
  m("USDKRW Curncy", "US Dollar / South Korean Won", 1390, "KRW", "CCY", 0.005, null),
  m("USDBRL Curncy", "US Dollar / Brazilian Real", 5.19, "BRL", "CCY", 0.009, null),
  m("USDMXN Curncy", "US Dollar / Mexican Peso", 18.4, "MXN", "CCY", 0.008, null),
  m("USDZAR Curncy", "US Dollar / South African Rand", 17.4, "ZAR", "CCY", 0.009, null),
  m("USDTRY Curncy", "US Dollar / Turkish Lira", 41, "TRY", "CCY", 0.004, null),
  m("USDPLN Curncy", "US Dollar / Polish Zloty", 3.6, "PLN", "CCY", 0.006, null),
  m("XBTUSD Curncy", "Bitcoin / US Dollar", 110000, "USD", "CCC", 0.03, null),
  m("XETUSD Curncy", "Ethereum / US Dollar", 4200, "USD", "CCC", 0.04, null),
  m("CL1 Comdty", "WTI Crude Oil Generic 1st", 92, "USD", "NY Mercantile", 0.022, 300e3),
  m("CO1 Comdty", "Brent Crude Oil Generic 1st", 97, "USD", "NY Mercantile", 0.02, 200e3),
  m("NG1 Comdty", "Natural Gas Generic 1st", 3.2, "USD", "NY Mercantile", 0.035, 150e3),
  m("HO1 Comdty", "NY Harbor ULSD Generic 1st", 4.46, "USD", "NY Mercantile", 0.02, 60e3),
  m("XB1 Comdty", "RBOB Gasoline Generic 1st", 3.19, "USD", "NY Mercantile", 0.022, 60e3),
  m("GC1 Comdty", "Gold Generic 1st", 3700, "USD", "COMEX", 0.012, 200e3),
  m("SI1 Comdty", "Silver Generic 1st", 64.8, "USD", "COMEX", 0.02, 70e3),
  m("HG1 Comdty", "Copper Generic 1st", 6.77, "USD", "COMEX", 0.015, 50e3),
  m("PL1 Comdty", "Platinum Generic 1st", 1800, "USD", "NY Mercantile", 0.018, 20e3),
  m("PA1 Comdty", "Palladium Generic 1st", 1276, "USD", "NY Mercantile", 0.022, 5e3),
  m("C 1 Comdty", "Corn Generic 1st", 528, "USD", "CBOT", 0.014, 200e3),
  m("W 1 Comdty", "Wheat Generic 1st", 703, "USD", "CBOT", 0.017, 80e3),
  m("S 1 Comdty", "Soybeans Generic 1st", 1319, "USD", "CBOT", 0.012, 120e3),
  m("KC1 Comdty", "Coffee Generic 1st", 278, "USD", "ICE US", 0.02, 25e3),
  m("SB1 Comdty", "Sugar No. 11 Generic 1st", 18.5, "USD", "ICE US", 0.018, 60e3),
  m("CC1 Comdty", "Cocoa Generic 1st", 5600, "USD", "ICE US", 0.025, 15e3),
  m("CT1 Comdty", "Cotton Generic 1st", 82.6, "USD", "ICE US", 0.014, 20e3),
  m("LC1 Comdty", "Live Cattle Generic 1st", 222, "USD", "CME", 0.009, 30e3),
  m("ES1 Comdty", "E-Mini S&P 500 Generic 1st", 7800, "USD", "CME", 0.01, 1.5e6),
  m("NQ1 Comdty", "E-Mini Nasdaq 100 Generic 1st", 30900, "USD", "CME", 0.013, 500e3),
  m("DM1 Comdty", "E-Mini Dow Generic 1st", 52100, "USD", "CBOT", 0.009, 100e3),
  m("TU1 Comdty", "US 2Y Note Future Generic 1st", 101.7, "USD", "CBOT", 0.001, 400e3),
  m("FV1 Comdty", "US 5Y Note Future Generic 1st", 103.6, "USD", "CBOT", 0.002, 700e3),
  m("TY1 Comdty", "US 10Y Note Future Generic 1st", 105, "USD", "CBOT", 0.003, 1.2e6),
  m("FF1 Comdty", "30 Day Fed Funds Future Generic 1st", 96.12, "USD", "CBOT", 0.0002, 2e5),
  m("US1 Comdty", "US Long Bond Future Generic 1st", 104.6, "USD", "CBOT", 0.005, 300e3),
];

const BY_SECURITY = new Map(MOCK_CATALOG.map((s) => [s.security, s]));

const DAY = 86_400_000;
const EPOCH = Date.UTC(2020, 0, 1);
/** Mean reversion per day, keeping prices within a realistic band around the anchor. */
const REVERSION = 0.01;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Deterministic simulated price path for one security. */
class PricePath {
  private seed: number;
  private logCloses: number[] = [0];

  constructor(private sec: MockSecurity) {
    this.seed = hash(sec.security);
  }

  /** Log deviation from the anchor price at the close of day index `d`. */
  private logClose(d: number): number {
    if (d < 0) return 0;
    while (this.logCloses.length <= d) {
      const i = this.logCloses.length;
      const prev = this.logCloses[i - 1];
      this.logCloses.push(prev * (1 - REVERSION) + this.sec.vol * gauss(this.seed, i));
    }
    return this.logCloses[d];
  }

  close(d: number): number {
    return this.sec.price * Math.exp(this.logClose(d));
  }

  /** Price at time `t` (ms): interpolates between daily closes with smooth intraday noise. */
  at(t: number): number {
    const elapsed = Math.max(t - EPOCH, 0);
    const d = Math.floor(elapsed / DAY);
    const frac = (elapsed % DAY) / DAY;
    const base = this.logClose(d - 1) * (1 - frac) + this.logClose(d) * frac;
    const knot = 15 * 60_000;
    const k = Math.floor(t / knot);
    const w = (1 - Math.cos(((t % knot) / knot) * Math.PI)) / 2;
    const smooth = gauss(this.seed ^ 0x5bd1e995, k) * (1 - w) + gauss(this.seed ^ 0x5bd1e995, k + 1) * w;
    const tick = gauss(this.seed ^ 0x27d4eb2f, Math.floor(t / 5000));
    const noise = this.sec.vol * (0.6 * Math.sin(Math.PI * frac) * smooth + 0.03 * tick);
    return this.sec.price * Math.exp(base + noise);
  }

  range(start: number, end: number): { o: number; h: number; l: number; c: number } {
    const o = this.at(start);
    const c = this.at(end);
    let h = Math.max(o, c);
    let l = Math.min(o, c);
    const steps = 8;
    for (let i = 1; i < steps; i++) {
      const p = this.at(start + ((end - start) * i) / steps);
      h = Math.max(h, p);
      l = Math.min(l, p);
    }
    return { o, h, l, c };
  }

  volumeFor(start: number, span: number): number | null {
    if (this.sec.volume === null) return null;
    return Math.round(this.sec.volume * (span / DAY) * (0.5 + rand(this.seed ^ 0x1b873593, Math.floor(start / span))));
  }
}

function barStart(t: number, interval: Interval): number {
  if (interval === "1wk") {
    const day = Math.floor(t / DAY) * DAY;
    const dow = new Date(day).getUTCDay();
    return day - ((dow + 6) % 7) * DAY;
  }
  const step = INTERVAL_MS[interval];
  return Math.floor(t / step) * step;
}

const MAX_BARS = 5000;

const MOCK_INDICES: Record<string, { name: string; exchange: string; weighting: "cap" | "price" }> = {
  "SPX Index": { name: "S&P 500", exchange: "US", weighting: "cap" },
  "NDX Index": { name: "Nasdaq-100", exchange: "US", weighting: "cap" },
  "INDU Index": { name: "Dow Jones Industrial Average", exchange: "US", weighting: "price" },
  "UKX Index": { name: "FTSE 100", exchange: "LN", weighting: "cap" },
};

export function createMockProvider(now: () => number = Date.now): ProviderPlugin {
  const paths = new Map<string, PricePath>();
  const derived = new Map<string, MockSecurity | null>();

  /** Specific futures months (e.g. "CLZ6 Comdty") derive from their generic with a small contango. */
  function contractSecurity(key: string): MockSecurity | null {
    if (derived.has(key)) return derived.get(key)!;
    const c = sectorOf(key) === "Comdty" ? parseContract(tickerOf(key), new Date(now())) : null;
    const base = c ? BY_SECURITY.get(`${c.root.length === 1 ? `${c.root} ` : c.root}1 Comdty`) : undefined;
    let sec: MockSecurity | null = null;
    if (c && base) {
      const today = new Date(now());
      const ahead = c.year * 12 + c.month - (today.getUTCFullYear() * 12 + today.getUTCMonth());
      if (ahead >= 0) {
        sec = {
          ...base,
          security: key,
          name: `${base.name.replace(/ Generic 1st$/, "")} ${MONTHS[c.month]} ${String(c.year % 100).padStart(2, "0")}`,
          // Fed funds futures quote 100 minus the rate: a gently rising strip prices gradual cuts.
          price: c.root === "FF" ? base.price + 0.05 * ahead : base.price * (1 + 0.004 * ahead),
          volume: base.volume !== null ? base.volume / (1 + ahead) : null,
        };
      }
    }
    derived.set(key, sec);
    return sec;
  }

  const pathFor = (security: string) => {
    const key = normalizeSecurity(security);
    if (!key) return null;
    const sec = BY_SECURITY.get(key) ?? contractSecurity(key);
    if (!sec) return null;
    let p = paths.get(sec.security);
    if (!p) paths.set(sec.security, (p = new PricePath(sec)));
    return { sec, path: p };
  };

  function quote(security: string): Quote | null {
    const found = pathFor(security);
    if (!found) return null;
    const { sec, path } = found;
    const t = now();
    const dayStart = Math.floor(t / DAY) * DAY;
    const d = Math.floor((dayStart - EPOCH) / DAY);
    const last = round(path.at(t));
    const prevClose = round(path.close(d - 1));
    const day = path.range(dayStart, t);
    const spread = last * 0.0001;
    const sized = sectorOf(sec.security) === "Equity";
    const change = round(last - prevClose);
    const dayVolume = path.volumeFor(dayStart, DAY);
    return {
      security: sec.security,
      name: sec.name,
      last,
      change,
      changePct: round((change / prevClose) * 100),
      bid: round(last - spread),
      ask: round(last + spread),
      bidSize: sized ? 1 + Math.floor(rand(hash(sec.security), Math.floor(t / 5000)) * 9) : null,
      askSize: sized ? 1 + Math.floor(rand(hash(sec.security) ^ 1, Math.floor(t / 5000)) * 9) : null,
      open: round(day.o),
      high: Math.max(round(day.h), last),
      low: Math.min(round(day.l), last),
      prevClose,
      volume: dayVolume === null ? null : Math.round(dayVolume * ((t - dayStart) / DAY)),
      currency: sec.currency,
      exchange: sec.exchange,
      marketState: "REGULAR",
      time: new Date(Math.floor(t / 1000) * 1000).toISOString(),
      delayMinutes: 0,
      source: "Mock",
    };
  }

  const research = createMockResearch({
    equities: MOCK_CATALOG.filter((s) => sectorOf(s.security) === "Equity" && !/^XL[A-Z]{1,2} /.test(s.security)),
    quote,
    now,
  });

  return {
    id: "mock",
    sectors: ALL_SECTORS,

    async quotes(securities) {
      return securities.map(quote).filter((q): q is Quote => !!q);
    },

    async search(query) {
      const q = query.trim().toUpperCase();
      if (!q) return [];
      return MOCK_CATALOG.filter(
        (s) => tickerOf(s.security).toUpperCase().startsWith(q) || s.name.toUpperCase().includes(q),
      )
        .slice(0, 10)
        .map((s): SearchResult => ({
          security: s.security,
          name: s.name,
          sector: sectorOf(s.security)!,
          exchange: s.exchange,
        }));
    },

    async history(security, interval, from, to) {
      const found = pathFor(security);
      if (!found) return [];
      const t = now();
      const end = Math.min(to.getTime(), t);
      const bars: Bar[] = [];
      const step = INTERVAL_MS[interval];
      const first = Math.max(from.getTime(), EPOCH, end - MAX_BARS * step);
      let s = barStart(first, interval);
      if (s < first) s = barStart(s + step + 1, interval);
      while (s <= end) {
        const next = s + step;
        const r = found.path.range(s, Math.min(next, t));
        bars.push({ t: s, o: round(r.o), h: round(r.h), l: round(r.l), c: round(r.c), v: found.path.volumeFor(s, next - s) });
        s = next;
      }
      return bars.slice(-MAX_BARS);
    },

    async overnightRates() {
      const date = new Date(now() - DAY).toISOString().slice(0, 10);
      const r = (currency: string, name: string, ratePct: number) => ({ currency, name, ratePct, date, source: "Mock" });
      return [r("USD", "SOFR", 3.88), r("EUR", "€STR", 2.44), r("GBP", "SONIA", 3.73), r("JPY", "TONA", 0.98), r("CHF", "SARON", -0.04), r("CAD", "CORRA", 2.26), r("AUD", "Interbank overnight cash rate", 4.35)];
    },

    async fomcCalendar() {
      const first = Math.floor(now() / DAY) * DAY + 12 * DAY;
      return Array.from({ length: 8 }, (_, k) => ({ date: new Date(first + k * 42 * DAY).toISOString().slice(0, 10), sep: k % 2 === 0 }));
    },

    async indexMembers(security) {
      const key = normalizeSecurity(security);
      const index = key ? MOCK_INDICES[key] : undefined;
      if (!key || !index) return null;
      const members = MOCK_CATALOG.filter((s) => s.security.endsWith(` ${index.exchange} Equity`) && !/^XL[A-Z]{1,2} /.test(s.security)).map((s) => ({
        security: s.security,
        name: s.name,
        sector: SECTOR_OF_TICKER[s.security.split(" ")[0]]?.[0] ?? null,
      }));
      return members.length ? { index: key, name: index.name, weighting: index.weighting, source: "Mock", sourceUrl: null, members } : null;
    },

    subscribeTrades(security, onTrade) {
      const found = pathFor(security);
      if (!found) return () => {};
      let seq = 0;
      const seed = hash(found.sec.security);
      const timer = setInterval(() => {
        const t = now();
        const r = rand(seed, t + seq++);
        const last = found.path.at(t);
        onTrade({
          time: new Date(t).toISOString(),
          price: round(last * (1 + (r - 0.5) * 0.0004)),
          size: sectorOf(found.sec.security) === "Equity" ? (1 + Math.floor(r * 20)) * 100 : Number((r * 2).toFixed(4)),
          side: r >= 0.5 ? "buy" : "sell",
          venue: "Mock",
        });
      }, 400);
      return () => clearInterval(timer);
    },

    ...research,
  };
}
