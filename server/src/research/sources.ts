import type express from "express";
import type { LlmClient } from "../ai/llm.js";
import type { Config } from "../config.js";
import type { LoadedPlugin } from "../plugins/loader.js";
import type { ProviderRouter } from "../providers/router.js";
import { DEFAULT_NATIVE_STALE_MS } from "../stream/hub.js";
import type { SourceSuggestion, SourcesReport } from "../types.js";

const NOTES: Record<string, string> = {
  coinbase: "Real-time crypto prices and trades from Coinbase public market data (no key).",
  kraken: "Real-time crypto quotes and trades from Kraken public market data. No account, API key or trading access. Prices reflect Kraken's venue, not a consolidated crypto price.",
  yahoo: "Stocks, indices, FX, futures and fundamentals. Many exchanges are delayed about 15 minutes. Personal use only.",
  finnhub: "Real-time US stock trades and quotes (free key, 60 requests a minute).",
  public: "Official and open data: US Treasury, New York Fed, ECB, BoE, BoJ, SNB, BoC, RBA, Japan MOF, World Bank, Fed/ECB/SEC press releases, CNBC and MarketWatch headlines, index members from Wikipedia and Nasdaq.",
  mock: "Simulated data for demos, development and tests.",
};

export interface SourcesDeps {
  router: ProviderRouter;
  config: Pick<Config, "providers" | "keys" | "plugins" | "auth" | "streamIntervalMs">;
  llm: LlmClient | null;
  plugins: LoadedPlugin[];
}

/** What powers the terminal, how hard each source is being used, and which free upgrades are still available. */
export function sourcesReport({ router, config, llm, plugins }: SourcesDeps): SourcesReport {
  const usage = new Map(router.usage().map((u) => [u.id, u]));
  const active = new Set(router.plugins.map((p) => p.id));
  const pluginNote = (id: string) => plugins.find((p) => p.providers.includes(id));
  const suggestions: SourceSuggestion[] = [];
  if (!active.has("kraken")) {
    suggestions.push({
      name: "Kraken (no key)",
      unlocks: "Independent crypto quotes and trades over a public stream",
      how: "Include kraken before coinbase and yahoo in PROVIDERS. No sign-up or API key is needed.",
    });
  }
  if (!llm) {
    suggestions.push({
      name: "Ollama (free, local)",
      unlocks: "ASK AI analyst that runs privately on your machine",
      how: "Install from https://ollama.com, run `ollama pull llama3.1`, then set AI_PROVIDER=ollama and AI_MODEL=llama3.1",
    });
  }
  if (!plugins.some((p) => p.functions.includes("CF"))) {
    suggestions.push({ name: "SEC EDGAR plugin", unlocks: "CF company filings for US-listed companies", how: "Set PLUGINS=./plugins/edgar and SEC_USER_AGENT to your name and email" });
  }
  if (!config.auth) {
    suggestions.push({ name: "Sign-in", unlocks: "Private portfolios, sheets, alerts and paper accounts per person", how: "Set AUTH=password (AUTH_SIGNUP=closed after creating accounts)" });
  }
  return {
    delivery: {
      pollingIntervalMs: config.streamIntervalMs,
      nativeSilenceFallbackMs: DEFAULT_NATIVE_STALE_MS,
      stockStreamProviders: router.plugins.filter((p) => p.subscribe && p.sectors.includes("Equity") && p.id !== "mock").map((p) => p.id),
    },
    providers: router.describe().map((p) => ({
      id: p.id,
      note: NOTES[p.id] ?? (pluginNote(p.id) ? `Added by the ${pluginNote(p.id)!.name} plugin.` : ""),
      capabilities: p.capabilities,
      sectors: p.sectors,
      usage: usage.get(p.id)!,
    })),
    ai: llm ? { provider: llm.name, model: llm.model } : null,
    plugins: plugins.map((p) => ({ name: p.name, functions: p.functions, providers: p.providers })),
    signIn: !!config.auth,
    suggestions,
  };
}

export function registerSourcesRoute(app: express.Express, deps: SourcesDeps): void {
  app.get("/api/sources", (_req, res) => {
    res.json(sourcesReport(deps));
  });
}
