import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { KvCache } from "../cache/kv.js";
import { createPublicProvider } from "../providers/public.js";
import { NEWS_FEEDS } from "../providers/newsFeeds.js";
import { ProviderRouter } from "../providers/router.js";
import { registerResearchRoutes } from "./routes.js";

describe("headline freshness", () => {
  it("refreshes public feeds through the API after a minute while keeping company news cached", async () => {
    let now = Date.parse("2026-10-26T16:00:00Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const nativeFetch = globalThis.fetch;
    let generation = 1;
    let feedRequests = 0;
    let base = "";
    const companyNews = vi.fn(async () => [{ id: "company", title: "Company report", source: "Company publisher", time: null, url: null }]);
    vi.stubGlobal("fetch", vi.fn((url: string | URL | Request, options?: RequestInit) => {
      if (String(url).startsWith(base) && base) return nativeFetch(url, options);
      feedRequests++;
      const host = new URL(String(url)).host;
      return Promise.resolve(new Response(`<rss><channel><item><title>Update ${generation} from ${host}</title><link>https://${host}/story</link><pubDate>${new Date(now).toUTCString()}</pubDate></item></channel></rss>`));
    }));
    const cache = new KvCache(":memory:");
    let server: Server | undefined;
    try {
      const router = new ProviderRouter([createPublicProvider({ cache }), { id: "company", sectors: ["Equity"], companyNews }], () => {});
      const app = express();
      registerResearchRoutes(app, router);
      server = app.listen(0);
      await new Promise<void>((resolve) => server!.once("listening", resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const get = async (path: string) => {
        const response = await fetch(base + path);
        expect(response.status).toBe(200);
        return response.json();
      };
      const companyPath = `/api/news/company/${encodeURIComponent("AAPL US Equity")}`;
      const first = await get("/api/news/top");
      expect(first).toHaveLength(NEWS_FEEDS.length);
      expect(first.some((item: { source: string }) => item.source === "Federal Reserve")).toBe(true);
      expect(first.every((item: { title: string }) => item.title.startsWith("Update 1"))).toBe(true);
      await get(companyPath);
      generation = 2;
      now += 30_000;
      expect((await get("/api/news/top"))[0].title).toContain("Update 1");
      expect(feedRequests).toBe(NEWS_FEEDS.length);
      now += 30_001;
      const refreshed = await get("/api/news/top");
      expect(refreshed.every((item: { title: string }) => item.title.startsWith("Update 2"))).toBe(true);
      expect(feedRequests).toBe(NEWS_FEEDS.length * 2);
      await get(companyPath);
      expect(companyNews).toHaveBeenCalledOnce();
      now += 240_000;
      await get(companyPath);
      expect(companyNews).toHaveBeenCalledTimes(2);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      cache.close();
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
