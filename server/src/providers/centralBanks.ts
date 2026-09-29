import type { OvernightRate } from "../types.js";

/** Official overnight benchmark rates published free by central banks. */

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** "24-Sep-2026" or "24 Sep 2026" -> "2026-09-24". */
export function dmy(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/);
  const mm = m ? MONTHS[m[2].toLowerCase()] : undefined;
  return m && mm ? `${m[3]}-${mm}-${m[1].padStart(2, "0")}` : null;
}

const csvRows = (text: string, sep = ",") =>
  text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, "")));

const rate = (currency: string, name: string, value: number, date: string | null, source: string): OvernightRate | null =>
  Number.isFinite(value) && date ? { currency, name, ratePct: value, date, source } : null;

/** ECB data portal CSV (e.g. euro short-term rate): the last observation. */
export function parseEcbCsv(text: string): { date: string; value: number } | null {
  const rows = csvRows(text);
  const header = rows[0] ?? [];
  const di = header.indexOf("TIME_PERIOD");
  const vi = header.indexOf("OBS_VALUE");
  const last = rows.slice(1).filter((r) => r[vi]).at(-1);
  return di >= 0 && vi >= 0 && last ? { date: last[di], value: Number(last[vi]) } : null;
}

/** Bank of England database CSV: "DATE,IUDSOIA" then "24 Sep 2026,3.73". */
export function parseBoeCsv(text: string): { date: string; value: number } | null {
  const last = csvRows(text)
    .slice(1)
    .filter((r) => r[1])
    .at(-1);
  const date = last ? dmy(last[0]) : null;
  return last && date ? { date, value: Number(last[1]) } : null;
}

/** SNB data portal CSV (semicolon separated, a few metadata lines first): the last "date;H0;value" row. */
export function parseSnbCsv(text: string): { date: string; value: number } | null {
  const last = csvRows(text, ";")
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r[0]) && r[2])
    .at(-1);
  return last ? { date: last[0], value: Number(last[2]) } : null;
}

/** RBA table F1 CSV: the latest "Interbank Overnight Cash Rate". */
export function parseRbaCsv(text: string): { date: string; value: number } | null {
  const rows = csvRows(text);
  const header = rows.find((r) => r[0] === "Title") ?? [];
  const col = header.indexOf("Interbank Overnight Cash Rate");
  if (col < 0) return null;
  const last = rows.filter((r) => dmy(r[0]) && r[col]).at(-1);
  return last ? { date: dmy(last[0])!, value: Number(last[col]) } : null;
}

/** Bank of Japan statistics API JSON: the latest non-empty value. */
export function parseBojJson(body: unknown): { date: string; value: number } | null {
  const v = (body as { RESULTSET?: { VALUES?: { SURVEY_DATES?: number[]; VALUES?: (number | null)[] } }[] }).RESULTSET?.[0]?.VALUES;
  const dates = v?.SURVEY_DATES ?? [];
  const values = v?.VALUES ?? [];
  for (let i = values.length - 1; i >= 0; i--) {
    const val = values[i];
    if (val !== null && val !== undefined) {
      const d = String(dates[i]);
      return { date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, value: val };
    }
  }
  return null;
}

/** Bank of Canada Valet JSON: the latest observation of one series. */
export function parseBocJson(body: unknown, series: string): { date: string; value: number } | null {
  const obs = (body as { observations?: Record<string, { v?: string } | string>[] }).observations ?? [];
  const last = obs.filter((o) => (o[series] as { v?: string } | undefined)?.v).at(-1);
  return last ? { date: String(last.d), value: Number((last[series] as { v: string }).v) } : null;
}

async function get(url: string, userAgent: string, as: "text" | "json"): Promise<unknown> {
  const res = await fetch(url, { headers: { "user-agent": userAgent, accept: as === "json" ? "application/json" : "text/csv,*/*" } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const boeDate = (d: Date) => `${String(d.getUTCDate()).padStart(2, "0")}/${Object.keys(MONTHS)[d.getUTCMonth()].replace(/^./, (c) => c.toUpperCase())}/${d.getUTCFullYear()}`;

/** Every currency whose source answers; failures are skipped so one outage does not hide the rest. */
export async function fetchOvernightRates(userAgent: string, now = new Date()): Promise<OvernightRate[]> {
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const jobs: Promise<OvernightRate | null>[] = [
    get("https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json", userAgent, "json").then((b) => {
      const r = (b as { refRates?: { effectiveDate?: string; percentRate?: number }[] }).refRates?.[0];
      return r ? rate("USD", "SOFR", Number(r.percentRate), r.effectiveDate ?? null, "Federal Reserve Bank of New York") : null;
    }),
    get("https://data-api.ecb.europa.eu/service/data/EST/B.EU000A2X2A25.WT?format=csvdata&lastNObservations=1", userAgent, "text").then((t) => {
      const p = parseEcbCsv(t as string);
      return p ? rate("EUR", "€STR", p.value, p.date, "European Central Bank") : null;
    }),
    get(
      `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${boeDate(from)}&Dateto=now&SeriesCodes=IUDSOIA&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`,
      userAgent,
      "text",
    ).then((t) => {
      const p = parseBoeCsv(t as string);
      return p ? rate("GBP", "SONIA", p.value, p.date, "Bank of England") : null;
    }),
    get(`https://www.stat-search.boj.or.jp/api/v1/getDataCode?format=json&lang=en&db=FM01&startDate=${ymd(from).slice(0, 7).replace("-", "")}&code=STRDCLUCON`, userAgent, "json").then((b) => {
      const p = parseBojJson(b);
      return p ? rate("JPY", "TONA", p.value, p.date, "Bank of Japan") : null;
    }),
    get(`https://data.snb.ch/api/cube/zirepo/data/csv/en?fromDate=${ymd(from)}&dimSel=D0(H0)`, userAgent, "text").then((t) => {
      const p = parseSnbCsv(t as string);
      return p ? rate("CHF", "SARON", p.value, p.date, "Swiss National Bank") : null;
    }),
    get("https://www.bankofcanada.ca/valet/observations/AVG.INTWO/json?recent=5", userAgent, "json").then((b) => {
      const p = parseBocJson(b, "AVG.INTWO");
      return p ? rate("CAD", "CORRA", p.value, p.date, "Bank of Canada") : null;
    }),
    get("https://www.rba.gov.au/statistics/tables/csv/f1-data.csv", userAgent, "text").then((t) => {
      const p = parseRbaCsv(t as string);
      return p ? rate("AUD", "Interbank overnight cash rate", p.value, p.date, "Reserve Bank of Australia") : null;
    }),
  ];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
}
