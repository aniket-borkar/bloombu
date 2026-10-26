import { afterEach, describe, expect, it, vi } from "vitest";
import type { Headline } from "../types.js";
import { createMockProvider } from "./mock.js";
import { NEWS_FEEDS, fetchNewsFeeds, mergeHeadlines } from "./newsFeeds.js";
import { ProviderRouter } from "./router.js";
import { topNews } from "./yahooResearch.js";

afterEach(() => vi.unstubAllGlobals());

const h = (title: string, source: string, time: string | null): Headline => ({ id: title, title, source, time, url: null });

describe("news aggregation", () => {
  it("lets public headlines finish when Yahoo RSS times out", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("finance.yahoo.com")) return new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
      });
      return Promise.resolve(new Response("<rss><channel><item><title>Official release</title></item></channel></rss>"));
    }));
    const results = await Promise.allSettled([topNews(10), fetchNewsFeeds("test", 10)]);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("fulfilled");
    if (results[1].status === "fulfilled") expect(results[1].value).toHaveLength(NEWS_FEEDS.length);
  });

  it("merges sources, drops repeated stories and sorts newest first", () => {
    const merged = mergeHeadlines([
      [h("Fed holds rates steady", "Yahoo", "2026-09-25T18:00:00Z"), h("Oil jumps 3%", "Yahoo", "2026-09-25T12:00:00Z")],
      [h("Fed Holds Rates Steady!", "CNBC", "2026-09-25T18:05:00Z"), h("ECB publishes minutes", "ECB", "2026-09-25T19:00:00Z"), h("Undated", "SEC", null)],
    ]);
    expect(merged.map((x) => [x.title, x.source])).toEqual([
      ["ECB publishes minutes", "ECB"],
      ["Fed holds rates steady", "Yahoo"],
      ["Oil jumps 3%", "Yahoo"],
      ["Undated", "SEC"],
    ]);
  });

  it("labels each feed and skips feeds that fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("cnbc")
          ? new Response("", { status: 503 })
          : new Response(`<rss><channel><item><title><![CDATA[Story from ${new URL(url).host}]]></title><link>https://x/${new URL(url).host}</link><pubDate>Fri, 25 Sep 2026 18:00:00 GMT</pubDate></item></channel></rss>`),
      ),
    );
    const items = await fetchNewsFeeds("test");
    expect(items).toHaveLength(NEWS_FEEDS.length - 1);
    expect(items.find((i) => i.source === "Federal Reserve")).toMatchObject({ title: "Story from www.federalreserve.gov", time: "2026-09-25T18:00:00.000Z" });
    expect(items.some((i) => i.source === "CNBC")).toBe(false);
  });

  it("still returns responding publishers when another feed never answers before its deadline", async () => {
    let aborted = false;
    vi.stubGlobal("fetch", vi.fn((url: string, options: RequestInit) => {
      if (url.includes("federalreserve")) {
        return new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => {
            aborted = true;
            reject(options.signal!.reason);
          }, { once: true });
        });
      }
      return Promise.resolve(new Response(`<rss><channel><item><title>Story from ${new URL(url).host}</title><link>https://example.com/story</link></item></channel></rss>`));
    }));
    const items = await fetchNewsFeeds("test", 20);
    expect(aborted).toBe(true);
    expect(items).toHaveLength(NEWS_FEEDS.length - 1);
    expect(items.some((item) => item.source === "ECB")).toBe(true);
    expect(items.some((item) => item.source === "Federal Reserve")).toBe(false);
  });

  it("collects a capability from every provider", async () => {
    const router = new ProviderRouter([createMockProvider(), { id: "extra", sectors: [], topNews: async () => [h("Extra story", "Extra", null)] }, { id: "bad", sectors: [], topNews: async () => Promise.reject(new Error("down")) }], () => {});
    const lists = await router.all("topNews", null, (p) => p.topNews!());
    expect(lists).toHaveLength(2);
    expect(lists[1][0].source).toBe("Extra");
  });
});
