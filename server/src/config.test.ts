import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults to keyless exchange feeds and public data before Yahoo", () => {
    const c = loadConfig({});
    expect(c.providers).toEqual(["kraken", "coinbase", "public", "yahoo"]);
    expect(c.port).toBe(8787);
    expect(c.streamIntervalMs).toBe(5000);
    expect(c.cacheDb).toMatch(/data[/\\]cache\.db$/);
  });

  it("parses a priority list, trimming and de-duplicating", () => {
    expect(loadConfig({ PROVIDERS: " Finnhub, yahoo ,finnhub" }).providers).toEqual(["finnhub", "yahoo"]);
  });

  it("rejects unknown providers", () => {
    expect(() => loadConfig({ PROVIDERS: "yahoo,bloomberg" })).toThrow(/Unknown provider "bloomberg"/);
  });

  it("rejects an empty provider list", () => {
    expect(() => loadConfig({ PROVIDERS: " , " })).toThrow(/at least one/);
  });

  it("validates numeric settings", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ STREAM_INTERVAL_MS: "100" })).toThrow(/STREAM_INTERVAL_MS/);
    expect(loadConfig({ STREAM_INTERVAL_MS: "1000" }).streamIntervalMs).toBe(1000);
  });

  it("keeps :memory: for the cache", () => {
    expect(loadConfig({ CACHE_DB: ":memory:" }).cacheDb).toBe(":memory:");
  });
});
