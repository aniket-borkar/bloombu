import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { sourcesReport } from "../research/sources.js";
import type { Quote } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { createMockProvider } from "./mock.js";
import { ProviderRouter } from "./router.js";
import { UsageMeter } from "./usage.js";

describe("UsageMeter", () => {
  it("counts calls per minute and day and enforces limits", () => {
    let t = 0;
    const meter = new UsageMeter(() => t);
    for (let i = 0; i < 3; i++) meter.record("x", i < 2, 100);
    expect(meter.allow("x", { perMinute: 3 })).toBe(false);
    expect(meter.allow("x", { perMinute: 4 })).toBe(true);
    expect(meter.allow("x")).toBe(true);
    t += 61_000;
    expect(meter.allow("x", { perMinute: 3 })).toBe(true);
    expect(meter.allow("x", { perDay: 3 })).toBe(false);
    expect(meter.usage("x", { perDay: 3 })).toMatchObject({ lastMinute: 0, lastHour: 3, last24h: 3, errors24h: 1, avgMs: 100, throttled: 2 });
    t += 86_400_000;
    expect(meter.usage("x")).toMatchObject({ last24h: 0, avgMs: null });
  });
});

describe("router free-tier guard", () => {
  it("skips a provider at its limit and falls back to the next one", async () => {
    let calls = 0;
    const limited: ProviderPlugin = {
      id: "limited",
      sectors: ["Equity"],
      rateLimit: { perMinute: 2 },
      quotes: async (secs) => {
        calls++;
        return secs.map((security) => ({ security, last: 1, source: "limited" }) as Quote);
      },
    };
    const logs: string[] = [];
    const router = new ProviderRouter([limited, createMockProvider()], (m) => logs.push(m));
    for (let i = 0; i < 4; i++) await router.quotes(["AAPL US Equity"]);
    expect(calls).toBe(2);
    expect((await router.quotes(["AAPL US Equity"]))[0].source).toBe("Mock");
    expect(router.usage()[0]).toMatchObject({ id: "limited", lastMinute: 2, throttled: 3 });
    expect(logs).toEqual([]);
    await expect(new ProviderRouter([limited], () => {}).first("quotes", "AAPL US Equity", (p) => p.quotes!(["AAPL US Equity"]))).resolves.toBeTruthy();
  });

  it("reports sources and the free upgrades still available", () => {
    const router = new ProviderRouter([createMockProvider()], () => {});
    const report = sourcesReport({ router, config: loadConfig({ PROVIDERS: "mock" }), llm: null, plugins: [] });
    expect(report.providers[0]).toMatchObject({ id: "mock", note: expect.stringContaining("Simulated") });
    expect(report.suggestions.map((s) => s.name)).toEqual(["Finnhub (free key)", "FRED (free key)", "Ollama (free, local)", "SEC EDGAR plugin", "Sign-in"]);
    expect(report.signIn).toBe(false);
  });
});
