import type { KvCache } from "../cache/kv.js";
import { fromYahoo, normalizeSecurity, tickerOf } from "../symbology.js";
import type { IndexMember, IndexMembers } from "../types.js";

/** Wikipedia pages whose constituents tables list each index's members (CC BY-SA 4.0). */
interface IndexSource {
  page: string;
  name: string;
  weighting: "cap" | "price";
  /** Exchange code for plain tickers; tickers with a Yahoo suffix (ADS.DE) carry their own. */
  exchange: string;
  ticker: RegExp;
  company: RegExp;
  sector?: RegExp;
}

export const INDEX_SOURCES: Record<string, IndexSource> = {
  SPX: { page: "List_of_S&P_500_companies", name: "S&P 500", weighting: "cap", exchange: "US", ticker: /^symbol$/i, company: /^security$/i, sector: /^gics sector$/i },
  INDU: { page: "List_of_Dow_Jones_Industrial_Average_companies", name: "Dow Jones Industrial Average", weighting: "price", exchange: "US", ticker: /^symbol$/i, company: /^company$/i, sector: /^(industry|sector)$/i },
  UKX: { page: "FTSE_100_Index", name: "FTSE 100", weighting: "cap", exchange: "LN", ticker: /^(ticker|epic)$/i, company: /^company$/i, sector: /sector/i },
  DAX: { page: "DAX", name: "DAX", weighting: "cap", exchange: "GY", ticker: /^ticker$/i, company: /^company$/i, sector: /sector/i },
  CAC: { page: "CAC_40", name: "CAC 40", weighting: "cap", exchange: "FP", ticker: /^ticker$/i, company: /^company$/i, sector: /^sector$/i },
  SX5E: { page: "EURO_STOXX_50", name: "EURO STOXX 50", weighting: "cap", exchange: "GY", ticker: /^ticker$/i, company: /^name$/i, sector: /^sector$/i },
  HSI: { page: "Hang_Seng_Index", name: "Hang Seng Index", weighting: "cap", exchange: "HK", ticker: /^ticker$/i, company: /^name$/i, sector: /sub-index/i },
  AS51: { page: "S&P/ASX_200", name: "S&P/ASX 200", weighting: "cap", exchange: "AU", ticker: /^code$/i, company: /^company$/i, sector: /^sector$/i },
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function cellText(html: string): string {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/g, "")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every table in the page (nested ones separately) as rows of cell text, header row first. */
export function htmlTables(html: string): { id: string | null; rows: string[][] }[] {
  const ranges: { start: number; bodyStart: number; bodyEnd: number; end: number; attrs: string }[] = [];
  const stack: { start: number; bodyStart: number; attrs: string }[] = [];
  for (const tag of html.matchAll(/<(\/?)table\b([^>]*)>/g)) {
    if (!tag[1]) stack.push({ start: tag.index, bodyStart: tag.index + tag[0].length, attrs: tag[2] });
    else {
      const open = stack.pop();
      if (open) ranges.push({ ...open, bodyEnd: tag.index, end: tag.index + tag[0].length });
    }
  }
  return ranges
    .sort((a, b) => a.start - b.start)
    .map((t) => {
      let body = "";
      let pos = t.bodyStart;
      for (const inner of ranges.filter((r) => r.start > t.start && r.end < t.end && !ranges.some((o) => o !== r && o.start > t.start && o.start < r.start && o.end > r.end))) {
        body += html.slice(pos, inner.start);
        pos = inner.end;
      }
      body += html.slice(pos, t.bodyEnd);
      return {
        id: t.attrs.match(/\bid="([^"]+)"/)?.[1] ?? null,
        rows: [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => cellText(c[1]))),
      };
    });
}

/** Map a listed ticker to a Bloomberg-style security for the index's exchange. */
export function memberSecurity(rawTicker: string, exchange: string): string | null {
  const t = rawTicker.replace(/^[A-Z]+:\s*/, "").trim().toUpperCase();
  if (!t) return null;
  if (exchange !== "US" && exchange !== "LN" && /^[A-Z0-9-]+\.[A-Z]{1,3}$/.test(t)) return fromYahoo(t, "EQUITY");
  const ticker = exchange === "US" || exchange === "LN" ? t.replace(/\.$/, "").replace(/\./g, "/") : t;
  return normalizeSecurity(`${ticker} ${exchange} Equity`);
}

/** Members from the first table that has the source's ticker and company columns. */
export function parseMembers(html: string, source: IndexSource): IndexMember[] {
  const tables = htmlTables(html).sort((a, b) => Number(b.id === "constituents") - Number(a.id === "constituents"));
  for (const table of tables) {
    const header = table.rows[0] ?? [];
    const ti = header.findIndex((h) => source.ticker.test(h));
    const ci = header.findIndex((h) => source.company.test(h));
    if (ti < 0 || ci < 0 || table.rows.length < 11) continue;
    const si = source.sector ? header.findIndex((h) => source.sector!.test(h)) : -1;
    const seen = new Set<string>();
    const members: IndexMember[] = [];
    for (const row of table.rows.slice(1)) {
      const security = row[ti] ? memberSecurity(row[ti], source.exchange) : null;
      if (!security || seen.has(security)) continue;
      seen.add(security);
      members.push({ security, name: row[ci] || tickerOf(security), sector: si >= 0 ? row[si] || null : null });
    }
    if (members.length >= 10) return members;
  }
  return [];
}

const TTL_MS = 24 * 3_600_000;

/** The Nasdaq-100 list from nasdaq.com's public quote-list endpoint (Wikipedia no longer lists it). */
async function nasdaq100(): Promise<IndexMembers> {
  const res = await fetch("https://api.nasdaq.com/api/quote/list-type/nasdaq100", {
    headers: { accept: "application/json", "user-agent": "Mozilla/5.0 (compatible; BLMBU Terminal)" },
  });
  if (!res.ok) throw new Error(`nasdaq.com ${res.status}`);
  const body = (await res.json()) as { data?: { data?: { rows?: { symbol: string; companyName: string }[] } } };
  const members = (body.data?.data?.rows ?? []).flatMap((r) => {
    const security = memberSecurity(r.symbol, "US");
    const name = r.companyName.replace(/\s+(Class [A-Z] )?(Common Stock|Capital Stock|Ordinary Shares|American Depositary Shares).*$/i, "");
    return security ? [{ security, name, sector: null }] : [];
  });
  if (members.length < 50) throw new Error("nasdaq.com returned an incomplete Nasdaq-100 list");
  return { index: "NDX Index", name: "Nasdaq-100", weighting: "cap", source: "Nasdaq.com", sourceUrl: "https://www.nasdaq.com/market-activity/quotes/nasdaq-ndx-index", members };
}

/**
 * Index member lists from free sources, fetched at most once a day per index:
 * Wikipedia constituents tables (its API asks clients to cache) and nasdaq.com.
 */
export function freeIndexMembers(cache: KvCache, userAgent: string) {
  return async (security: string): Promise<IndexMembers | null> => {
    const key = normalizeSecurity(security);
    const code = key?.endsWith(" Index") ? tickerOf(key) : null;
    if (code === "NDX") return cache.wrap("nasdaq:members:NDX", TTL_MS, nasdaq100);
    const source = code ? INDEX_SOURCES[code] : undefined;
    if (!key || !source) return null;
    return cache.wrap(`wikipedia:members:${key}`, TTL_MS, async () => {
      const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(source.page)}&prop=text&format=json&formatversion=2&redirects=1`;
      const res = await fetch(url, { headers: { "user-agent": userAgent } });
      if (!res.ok) throw new Error(`wikipedia ${res.status}`);
      const html = ((await res.json()) as { parse?: { text?: string } }).parse?.text ?? "";
      const members = parseMembers(html, source);
      if (!members.length) throw new Error(`wikipedia: no member table found on ${source.page}`);
      return {
        index: key,
        name: source.name,
        weighting: source.weighting,
        source: "Wikipedia (CC BY-SA 4.0)",
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(source.page)}`,
        members,
      };
    });
  };
}
