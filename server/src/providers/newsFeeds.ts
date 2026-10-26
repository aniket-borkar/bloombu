import type { Headline } from "../types.js";
import { parseRss } from "./yahooResearch.js";

export const NEWS_REFRESH_MS = 60_000;
export const NEWS_FEED_TIMEOUT_MS = 5_000;

/** Free RSS feeds: official press releases plus major financial news outlets. */
export const NEWS_FEEDS: { source: string; url: string }[] = [
  { source: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { source: "ECB", url: "https://www.ecb.europa.eu/rss/press.html" },
  { source: "SEC", url: "https://www.sec.gov/news/pressreleases.rss" },
  { source: "CNBC", url: "https://www.cnbc.com/id/100003114/device/rss/rss.html" },
  { source: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
];

/** Every feed that answers, parsed; a failing feed is skipped. */
export async function fetchNewsFeeds(userAgent: string, timeoutMs = NEWS_FEED_TIMEOUT_MS): Promise<Headline[]> {
  const settled = await Promise.allSettled(
    NEWS_FEEDS.map(async (f) => {
      const res = await fetch(f.url, {
        headers: { "user-agent": userAgent, accept: "application/rss+xml, application/xml, text/xml" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`${f.source} ${res.status}`);
      return parseRss(await res.text(), f.source).map((h) => ({ ...h, source: f.source }));
    }),
  );
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}

const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

/** Merge headline lists, dropping repeats of the same story and sorting newest first. */
export function mergeHeadlines(lists: Headline[][], limit = 150): Headline[] {
  const seen = new Set<string>();
  const out: Headline[] = [];
  for (const h of lists.flat()) {
    const key = titleKey(h.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  const t = (h: Headline) => (h.time ? Date.parse(h.time) || 0 : 0);
  return out.sort((a, b) => t(b) - t(a)).slice(0, limit);
}
