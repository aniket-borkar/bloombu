import { KvCache } from "../cache/kv.js";
import type { Config } from "../config.js";
import { createKrakenProvider } from "./kraken.js";
import { createCoinbaseProvider } from "./coinbase.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { createFinnhubProvider } from "./finnhub.js";
import { createMockProvider } from "./mock.js";
import { createPublicProvider } from "./public.js";
import { createYahooProvider } from "./yahoo.js";

interface PluginFactory {
  requiresKey?: string;
  create(config: Config): ProviderPlugin;
}

export const PLUGIN_FACTORIES: Record<string, PluginFactory> = {
  kraken: { create: () => createKrakenProvider() },
  coinbase: { create: () => createCoinbaseProvider() },
  yahoo: { create: () => createYahooProvider() },
  finnhub: { requiresKey: "FINNHUB_API_KEY", create: (c) => createFinnhubProvider(c.keys.FINNHUB_API_KEY!) },
  public: { create: (c) => createPublicProvider({ fredApiKey: c.keys.FRED_API_KEY, cache: new KvCache(c.cacheDb), contact: c.contact }) },
  mock: { create: () => createMockProvider() },
};

/**
 * Instantiate providers in PROVIDERS priority order, skipping any whose API key
 * is missing. Providers added by plugins take their place in PROVIDERS when
 * listed there and otherwise follow the configured ones as fallbacks.
 */
export function createPlugins(
  config: Config,
  factories: Record<string, PluginFactory> = PLUGIN_FACTORIES,
  warn: (msg: string) => void = console.warn,
  extra: ProviderPlugin[] = [],
): ProviderPlugin[] {
  const unlisted = new Map(extra.map((p) => [p.id, p]));
  const plugins: ProviderPlugin[] = [];
  for (const id of config.providers) {
    const fromPlugin = unlisted.get(id);
    if (fromPlugin) {
      plugins.push(fromPlugin);
      unlisted.delete(id);
      continue;
    }
    const factory = factories[id];
    if (!factory) {
      throw new Error(`Unknown provider "${id}" in PROVIDERS. Known: ${[...Object.keys(factories), ...extra.map((p) => p.id)].join(", ")}`);
    }
    if (factory.requiresKey && !config.keys[factory.requiresKey]) {
      warn(`Provider "${id}" skipped: ${factory.requiresKey} is not set`);
      continue;
    }
    plugins.push(factory.create(config));
  }
  if (!plugins.length) throw new Error("No data providers are usable. Check PROVIDERS and API keys.");
  plugins.push(...unlisted.values());
  return plugins;
}
