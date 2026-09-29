import type { KvCache } from "../cache/kv.js";
import { fetchOvernightRates } from "./centralBanks.js";
import { fetchNewsFeeds } from "./newsFeeds.js";
import { fetchSovereignCurves } from "./sovereign.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { freeIndexMembers } from "./wikipedia.js";
import type { CurvePoint, EconEvent, EconStats, FomcMeeting, MoneyMarkets, YieldCurve } from "../types.js";

const DAY = 86_400_000;
const UA = { "user-agent": "Mozilla/5.0 (compatible; blmbu-terminal)" };

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.text();
}

// ---------- US Treasury daily par yield curve ----------

function treasuryUrl(year: number): string {
  return (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/" +
    `${year}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${year}&page&_format=csv`
  );
}

/** "1 Mo" -> 1M / 1/12 years, "1.5 Month" -> 1.5M, "10 Yr" -> 10Y. */
function parseTenor(header: string): { tenor: string; years: number } | null {
  const m = header.replace(/"/g, "").trim().match(/^([\d.]+)\s*(Mo|Month|Yr|Year)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const monthly = /^mo/i.test(m[2]);
  return { tenor: `${m[1]}${monthly ? "M" : "Y"}`, years: monthly ? n / 12 : n };
}

interface CurveRow {
  date: string;
  points: CurvePoint[];
}

/** Parse Treasury's CSV (newest row first) into curves, newest first. */
export function parseTreasuryCsv(csv: string): CurveRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  const tenors = headers.slice(1).map(parseTenor);
  const rows: CurveRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const [mm, dd, yyyy] = cells[0].replace(/"/g, "").split("/");
    if (!yyyy) continue;
    const points: CurvePoint[] = [];
    tenors.forEach((t, i) => {
      if (!t) return;
      const raw = cells[i + 1]?.trim();
      points.push({ ...t, yieldPct: raw ? Number(raw) : null });
    });
    rows.push({ date: `${yyyy}-${mm}-${dd}`, points });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export function buildCurve(rows: CurveRow[]): YieldCurve | null {
  const latest = rows[0];
  if (!latest) return null;
  const at = (daysBack: number, label: string) => {
    const cutoff = new Date(Date.parse(latest.date) - daysBack * DAY).toISOString().slice(0, 10);
    const row = rows.find((r) => r.date <= cutoff);
    return row ? [{ label, date: row.date, points: row.points }] : [];
  };
  return {
    name: "US Treasury Actives",
    date: latest.date,
    points: latest.points,
    history: [...at(7, "1W Ago"), ...at(30, "1M Ago")],
    source: "U.S. Department of the Treasury",
  };
}

async function yieldCurve(now = new Date()): Promise<YieldCurve | null> {
  const year = now.getUTCFullYear();
  let rows = parseTreasuryCsv(await getText(treasuryUrl(year)));
  if (rows.length < 25) rows = [...rows, ...parseTreasuryCsv(await getText(treasuryUrl(year - 1)))];
  return buildCurve(rows);
}

// ---------- New York Fed reference rates ----------

interface NyFedRate {
  effectiveDate?: string;
  type?: string;
  percentRate?: number;
  targetRateFrom?: number;
  targetRateTo?: number;
}

async function nyFed(path: string): Promise<NyFedRate | null> {
  const body = JSON.parse(await getText(`https://markets.newyorkfed.org/api/rates/${path}/last/1.json`)) as {
    refRates?: NyFedRate[];
  };
  return body.refRates?.[0] ?? null;
}

async function moneyMarkets(): Promise<MoneyMarkets | null> {
  const [effr, obfr, sofr] = await Promise.all([nyFed("unsecured/effr"), nyFed("unsecured/obfr"), nyFed("secured/sofr")]);
  const rates: MoneyMarkets["rates"] = [];
  if (effr?.targetRateTo !== undefined) {
    rates.push({
      name: "Fed Funds Target (Upper)",
      ratePct: effr.targetRateTo,
      date: effr.effectiveDate ?? null,
      note: `Range ${effr.targetRateFrom?.toFixed(2)}-${effr.targetRateTo.toFixed(2)}`,
    });
  }
  const row = (name: string, r: NyFedRate | null) =>
    r && rates.push({ name, ratePct: r.percentRate ?? null, date: r.effectiveDate ?? null, note: null });
  row("Effective Fed Funds (EFFR)", effr);
  row("Overnight Bank Funding (OBFR)", obfr);
  row("SOFR", sofr);
  return rates.length ? { rates, source: "Federal Reserve Bank of New York" } : null;
}

// ---------- World Bank indicators ----------

export const ECON_INDICATORS = [
  { id: "NY.GDP.MKTP.KD.ZG", name: "GDP Growth %" },
  { id: "FP.CPI.TOTL.ZG", name: "CPI Inflation %" },
  { id: "SL.UEM.TOTL.ZS", name: "Unemployment %" },
  { id: "BN.CAB.XOKA.GD.ZS", name: "Current Acct % GDP" },
  { id: "NY.GDP.MKTP.CD", name: "GDP (USD)" },
];

export const ECON_COUNTRIES = [
  "USA", "CHN", "JPN", "DEU", "IND", "GBR", "FRA", "ITA", "BRA", "CAN", "KOR", "AUS", "ESP", "MEX", "IDN", "TUR",
];

interface WbRow {
  countryiso3code?: string;
  country?: { value?: string };
  date?: string;
  value?: number | null;
}

async function econStats(): Promise<EconStats | null> {
  const countries = new Map<string, EconStats["countries"][number]>();
  await Promise.all(
    ECON_INDICATORS.map(async (ind) => {
      const url = `https://api.worldbank.org/v2/country/${ECON_COUNTRIES.join(";")}/indicator/${ind.id}?format=json&mrnev=1&per_page=200`;
      const body = JSON.parse(await getText(url)) as [unknown, WbRow[] | null];
      for (const r of body[1] ?? []) {
        const code = r.countryiso3code;
        if (!code) continue;
        let c = countries.get(code);
        if (!c) countries.set(code, (c = { code, name: r.country?.value ?? code, values: {} }));
        c.values[ind.id] = { value: typeof r.value === "number" ? r.value : null, year: r.date ?? null };
      }
    }),
  );
  if (!countries.size) return null;
  const order = (code: string) => ECON_COUNTRIES.indexOf(code);
  return {
    indicators: ECON_INDICATORS,
    countries: [...countries.values()].sort((a, b) => order(a.code) - order(b.code)),
    source: "World Bank Open Data",
  };
}

// ---------- FRED release calendar (optional key) ----------

export function parseFredReleaseDates(body: unknown): EconEvent[] {
  const dates = (body as { release_dates?: { release_name?: string; date?: string }[] }).release_dates ?? [];
  return dates
    .filter((d) => d.release_name && d.date)
    .map((d) => ({ date: d.date!, name: d.release_name!, source: "FRED, Federal Reserve Bank of St. Louis" }));
}

async function econCalendar(apiKey: string, now = new Date()): Promise<EconEvent[]> {
  const start = now.toISOString().slice(0, 10);
  const end = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
  const url =
    `https://api.stlouisfed.org/fred/releases/dates?api_key=${encodeURIComponent(apiKey)}&file_type=json` +
    `&realtime_start=${start}&realtime_end=${end}&include_release_dates_with_no_data=true` +
    `&order_by=release_date&sort_order=asc&limit=1000`;
  return parseFredReleaseDates(JSON.parse(await getText(url))).filter((e) => e.date >= start && e.date <= end);
}

/**
 * Free public-sector sources: US Treasury yield curve, New York Fed reference
 * rates, World Bank indicators, and (with FRED_API_KEY) the FRED release calendar.
 */
// ---------- FOMC meeting calendar (federalreserve.gov) ----------

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Decision days from the Fed's calendar page; cross-month meetings ("Apr/May 30-1") end in the later month. */
export function parseFomcCalendar(html: string): FomcMeeting[] {
  const heads = [...html.matchAll(/(\d{4}) FOMC Meetings/g)];
  const out: FomcMeeting[] = [];
  heads.forEach((h, i) => {
    const year = Number(h[1]);
    const section = html.slice(h.index, heads[i + 1]?.index ?? html.length);
    for (const m of section.matchAll(/fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g)) {
      const monthText = m[1].trim().toLowerCase().split("/").pop()!;
      const month = MONTHS.findIndex((name) => name.startsWith(monthText.slice(0, 3)));
      const dateText = m[2].trim();
      if (month < 0 || /[a-z(]/i.test(dateText)) continue;
      const day = Number(dateText.replace("*", "").split("-").pop());
      if (!Number.isInteger(day) || day < 1 || day > 31) continue;
      const crossesYear = month === 0 && /dec/.test(m[1].toLowerCase());
      const date = new Date(Date.UTC(year + (crossesYear ? 1 : 0), month, day)).toISOString().slice(0, 10);
      out.push({ date, sep: dateText.includes("*") });
    }
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface PublicOptions {
  fredApiKey?: string;
  cache: KvCache;
  /** Contact for the User-Agent that Wikipedia and other public APIs ask clients to send. */
  contact?: string;
}

export function createPublicProvider(opts: PublicOptions): ProviderPlugin {
  const { fredApiKey, cache } = opts;
  const userAgent = `BLMBU Terminal/1.0 (open-source market terminal${opts.contact ? `; ${opts.contact}` : ""})`;
  return {
    id: "public",
    sectors: ["Index"],
    indexMembers: freeIndexMembers(cache, userAgent),
    fomcCalendar: () =>
      cache.wrap("fed:fomc-calendar", DAY, async () => {
        const meetings = parseFomcCalendar(await getText("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"));
        if (!meetings.length) throw new Error("federalreserve.gov: no FOMC meetings found on the calendar page");
        return meetings;
      }),
    overnightRates: () =>
      cache.wrap("rates:overnight", 6 * 3_600_000, async () => {
        const rates = await fetchOvernightRates(userAgent);
        if (!rates.length) throw new Error("no central bank rate source answered");
        return rates;
      }),
    topNews: () => cache.wrap("news:feeds", 5 * 60_000, () => fetchNewsFeeds(userAgent)),
    sovereignCurves: () =>
      cache.wrap("curves:sovereign", 6 * 3_600_000, async () => {
        const curves = await fetchSovereignCurves(userAgent);
        if (!curves.length) throw new Error("no sovereign curve publisher answered");
        return curves;
      }),
    yieldCurve: () => yieldCurve(),
    moneyMarkets,
    econStats,
    ...(fredApiKey ? { econCalendar: () => econCalendar(fredApiKey) } : {}),
  };
}
