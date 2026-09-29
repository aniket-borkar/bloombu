import type { CurvePoint, YieldCurve } from "../types.js";
import { dmy } from "./centralBanks.js";

/** Government yield curves from official, free publishers (ECB, Japan MOF, Bank of Canada, Bank of England). */

type Series = Map<string, Map<string, number>>; // date -> tenor -> yield

const DAY = 86_400_000;

function tenorYears(tenor: string): number {
  if (tenor === "Long") return 30;
  const m = tenor.match(/^(\d+)([MY])$/);
  return m ? Number(m[1]) / (m[2] === "M" ? 12 : 1) : Number.NaN;
}

/** Latest curve plus the curves about one week and one month earlier. */
export function curveFromSeries(name: string, source: string, tenors: string[], series: Series): YieldCurve | null {
  const dates = [...series.keys()].filter((d) => series.get(d)!.size >= Math.ceil(tenors.length / 2)).sort();
  const latest = dates.at(-1);
  if (!latest) return null;
  const pointsOn = (date: string): CurvePoint[] => tenors.map((tenor) => ({ tenor, years: tenorYears(tenor), yieldPct: series.get(date)?.get(tenor) ?? null }));
  const onOrBefore = (days: number) => {
    const cutoff = new Date(Date.parse(latest) - days * DAY).toISOString().slice(0, 10);
    return dates.filter((d) => d <= cutoff).at(-1);
  };
  const history = (
    [
      ["1W Ago", onOrBefore(7)],
      ["1M Ago", onOrBefore(30)],
    ] as const
  ).flatMap(([label, date]) => (date ? [{ label, date, points: pointsOn(date) }] : []));
  return { name, date: latest, points: pointsOn(latest), history, source };
}

function put(series: Series, date: string, tenor: string, value: number) {
  if (!Number.isFinite(value)) return;
  let row = series.get(date);
  if (!row) series.set(date, (row = new Map()));
  row.set(tenor, value);
}

const ECB_TENORS = ["3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"];

export function parseEcbCurveCsv(text: string): Series {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const [ki, di, vi] = ["KEY", "TIME_PERIOD", "OBS_VALUE"].map((h) => header.indexOf(h));
  const series: Series = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const tenor = c[ki]?.match(/SR_(\d+[MY])$/)?.[1];
    if (tenor && c[vi]) put(series, c[di], tenor, Number(c[vi]));
  }
  return series;
}

const MOF_TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y", "40Y"];

export function parseMofCsv(text: string, series: Series = new Map()): Series {
  const lines = text.trim().split(/\r?\n/);
  const header = lines.find((l) => l.startsWith("Date,"))?.split(",") ?? [];
  for (const line of lines) {
    const c = line.split(",");
    const m = c[0].match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    header.forEach((h, i) => {
      if (MOF_TENORS.includes(h) && c[i] && c[i] !== "-") put(series, date, h, Number(c[i]));
    });
  }
  return series;
}

const BOC_SERIES: Record<string, string> = {
  "BD.CDN.2YR.DQ.YLD": "2Y",
  "BD.CDN.3YR.DQ.YLD": "3Y",
  "BD.CDN.5YR.DQ.YLD": "5Y",
  "BD.CDN.7YR.DQ.YLD": "7Y",
  "BD.CDN.10YR.DQ.YLD": "10Y",
  "BD.CDN.LONG.DQ.YLD": "Long",
};

export function parseBocCurve(body: unknown): Series {
  const series: Series = new Map();
  for (const o of (body as { observations?: Record<string, { v?: string } | string>[] }).observations ?? []) {
    for (const [code, tenor] of Object.entries(BOC_SERIES)) {
      const v = (o[code] as { v?: string } | undefined)?.v;
      if (v) put(series, String(o.d), tenor, Number(v));
    }
  }
  return series;
}

const BOE_SERIES: Record<string, string> = { IUDSNZC: "5Y", IUDMNZC: "10Y", IUDLNZC: "20Y" };

export function parseBoeCurveCsv(text: string): Series {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(",");
  const series: Series = new Map();
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const date = dmy(c[0]);
    if (!date) continue;
    header.forEach((h, i) => {
      if (BOE_SERIES[h] && c[i]) put(series, date, BOE_SERIES[h], Number(c[i]));
    });
  }
  return series;
}

async function text(url: string, userAgent: string): Promise<string> {
  const res = await fetch(url, { headers: { "user-agent": userAgent } });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.text();
}

/** Every curve whose publisher answers; one outage does not hide the others. */
export async function fetchSovereignCurves(userAgent: string, now = new Date()): Promise<YieldCurve[]> {
  const from = new Date(now.getTime() - 45 * DAY);
  const iso = from.toISOString().slice(0, 10);
  const boeFrom = `${String(from.getUTCDate()).padStart(2, "0")}/${from.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}/${from.getUTCFullYear()}`;
  const jobs: Promise<YieldCurve | null>[] = [
    text(
      `https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.${ECB_TENORS.map((t) => `SR_${t}`).join("+")}?format=csvdata&startPeriod=${iso}`,
      userAgent,
    ).then((t) => curveFromSeries("Euro Area AAA Govt (ECB)", "European Central Bank", ECB_TENORS, parseEcbCurveCsv(t))),
    Promise.all([
      text("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv", userAgent),
      text("https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv", userAgent),
    ]).then(([all, current]) => {
      const recent = all.trim().split(/\r?\n/);
      const series = parseMofCsv([recent[1] ?? "", ...recent.slice(-60)].join("\n"));
      return curveFromSeries("Japan Govt Bonds (MOF)", "Ministry of Finance Japan", MOF_TENORS, parseMofCsv(current, series));
    }),
    fetch(`https://www.bankofcanada.ca/valet/observations/${Object.keys(BOC_SERIES).join(",")}/json?recent=35`, { headers: { "user-agent": userAgent } })
      .then((r) => {
        if (!r.ok) throw new Error(`bankofcanada.ca ${r.status}`);
        return r.json();
      })
      .then((b) => curveFromSeries("Canada Govt Benchmarks (BoC)", "Bank of Canada", Object.values(BOC_SERIES), parseBocCurve(b))),
    text(
      `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${boeFrom}&Dateto=now&SeriesCodes=${Object.keys(BOE_SERIES).join(",")}&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`,
      userAgent,
    ).then((t) => curveFromSeries("UK Gilts, Zero Coupon (BoE)", "Bank of England", Object.values(BOE_SERIES), parseBoeCurveCsv(t))),
  ];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((s) => (s.status === "fulfilled" && s.value ? [s.value] : []));
}
