import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { sourcesReport } from "../research/sources.js";
import type { Quote } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { createMockProvider } from "./mock.js";
import { ProviderRouter } from "./router.js";
import { RateLimited, UsageMeter } from "./usage.js";

describe("UsageMeter", () => {
  it("reserves pending requests atomically and does not count denied requests as outgoing", async () => {
    const meter = new UsageMeter();
    let complete!: () => void;
    let dispatched = 0;
    const request = meter.run("x", { perMinute: 1 }, () => {
      dispatched++;
      return new Promise<void>((resolve) => { complete = resolve; });
    });
    await expect(meter.run("x", { perMinute: 1 }, async () => { dispatched++; })).rejects.toBeInstanceOf(RateLimited);
    expect(dispatched).toBe(1);
    expect(meter.usage("x")).toMatchObject({ lastMinute: 1, throttled: 1, errors24h: 0, avgMs: null });
    complete();
    await request;
    expect(meter.usage("x").avgMs).not.toBeNull();
  });

  it("uses rolling windows across minute and day boundaries", async () => {
    let now = 59_900;
    const meter = new UsageMeter(() => now);
    await meter.run("x", { perMinute: 1, perDay: 1 }, async () => {});
    now = 60_100;
    expect(meter.allow("x", { perMinute: 1 })).toBe(false);
    now = 119_901;
    expect(meter.allow("x", { perMinute: 1 })).toBe(true);
    now = 86_400_100;
    expect(meter.allow("x", { perDay: 1 })).toBe(false);
    now = 86_459_901;
    expect(meter.allow("x", { perDay: 1 })).toBe(true);
  });

  it("keeps failed requests charged to their dispatch time across a minute boundary", async () => {
    let now = 59_900;
    const meter = new UsageMeter(() => now);
    let fail!: (error: Error) => void;
    const request = meter.run("x", { perMinute: 1 }, () => new Promise<void>((_, reject) => { fail = reject; }));
    const rejected = expect(request).rejects.toThrow("unavailable");
    now = 60_100;
    fail(new Error("unavailable"));
    await rejected;
    expect(meter.usage("x")).toMatchObject({ lastMinute: 1, errors24h: 1, avgMs: 200 });
    await expect(meter.run("x", { perMinute: 1 }, async () => {})).rejects.toBeInstanceOf(RateLimited);
    expect(meter.usage("x")).toMatchObject({ lastMinute: 1, errors24h: 1, throttled: 1 });
    now = 119_901;
    expect(meter.usage("x").lastMinute).toBe(0);
  });

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
  it("falls back for simultaneous requests once the pending request reserves the limit", async () => {
    let calls = 0;
    let finish!: () => void;
    const limited: ProviderPlugin = {
      id: "limited", sectors: ["Equity"], rateLimit: { perMinute: 1 },
      quotes: async (securities) => {
        calls++;
        await new Promise<void>((resolve) => { finish = resolve; });
        return securities.map((security) => ({ security, last: 1, source: "limited" }) as Quote);
      },
    };
    const router = new ProviderRouter([limited, createMockProvider()], () => {});
    const first = router.quote("AAPL US Equity");
    const second = await router.quote("MSFT US Equity");
    expect(second?.source).toBe("Mock");
    expect(calls).toBe(1);
    finish();
    expect((await first)?.source).toBe("limited");
    expect(router.usage()[0]).toMatchObject({ lastMinute: 1, throttled: 1 });
  });

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
    expect(report.suggestions.map((s) => s.name)).toEqual(["Kraken (no key)", "Ollama (free, local)", "SEC EDGAR plugin", "Sign-in"]);
    expect(report.delivery).toEqual({ pollingIntervalMs: 5000, nativeSilenceFallbackMs: 15000, stockStreamProviders: [], directCrypto: false });
    expect(report.signIn).toBe(false);
  });
});
