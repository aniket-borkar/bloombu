import path from "node:path";

export const KNOWN_PROVIDERS = ["coinbase", "yahoo", "finnhub", "public", "mock"] as const;
export type ProviderId = (typeof KNOWN_PROVIDERS)[number];

export const AI_PROVIDERS = ["openai", "anthropic", "ollama", "mock"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider | null;
  apiKey: string | undefined;
  model: string | undefined;
  /** Model for deep research questions (?? on the command line); AI_MODEL when unset. */
  deepModel: string | undefined;
  baseUrl: string | undefined;
}

export interface Config {
  /** Provider ids in priority order: built-ins, or ids added by PLUGINS. */
  providers: string[];
  keys: Record<string, string | undefined>;
  port: number;
  cacheDb: string;
  streamIntervalMs: number;
  staticDir: string;
  ai: AiConfig;
  /** Plugin module paths or package names (PLUGINS, comma-separated). */
  plugins: string[];
  /** Name and email sent in the User-Agent that public APIs (Wikipedia, SEC) ask clients to identify with. */
  contact: string | undefined;
  /** AUTH=password requires signing in; unset leaves the terminal open to anyone who can reach it. */
  auth: "password" | null;
  /** AUTH_SIGNUP=closed stops new accounts once the first one exists. */
  authSignupOpen: boolean;
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

function loadAi(env: NodeJS.ProcessEnv): AiConfig {
  const raw = (env.AI_PROVIDER ?? "").trim().toLowerCase();
  const ai: AiConfig = {
    provider: null,
    apiKey: env.AI_API_KEY || undefined,
    model: env.AI_MODEL || undefined,
    deepModel: env.AI_MODEL_DEEP || undefined,
    baseUrl: env.AI_BASE_URL || undefined,
  };
  if (!raw) return ai;
  if (!(AI_PROVIDERS as readonly string[]).includes(raw)) {
    throw new Error(`Unknown AI_PROVIDER "${raw}". Use one of: ${AI_PROVIDERS.join(", ")}`);
  }
  ai.provider = raw as AiProvider;
  if ((ai.provider === "openai" || ai.provider === "anthropic") && !ai.apiKey) {
    throw new Error(`AI_PROVIDER=${ai.provider} requires AI_API_KEY`);
  }
  if (ai.provider !== "mock" && !ai.model) {
    throw new Error(`AI_PROVIDER=${ai.provider} requires AI_MODEL (the model name your provider offers)`);
  }
  return ai;
}

function authMode(raw: string | undefined): "password" | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v || v === "off" || v === "none") return null;
  if (v === "password") return "password";
  throw new Error(`Unknown AUTH "${raw}". Use AUTH=password, or leave it unset for an open terminal`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const providers = (env.PROVIDERS ?? "coinbase,yahoo,public")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!providers.length) throw new Error("PROVIDERS must list at least one provider");
  const plugins = (env.PLUGINS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Ids that plugins add are checked once the plugins have loaded.
  if (!plugins.length) {
    for (const p of providers) {
      if (!(KNOWN_PROVIDERS as readonly string[]).includes(p)) {
        throw new Error(`Unknown provider "${p}" in PROVIDERS. Known: ${KNOWN_PROVIDERS.join(", ")}`);
      }
    }
  }
  const cacheDb = env.CACHE_DB || path.join(REPO_ROOT, "data", "cache.db");
  return {
    providers: [...new Set(providers)],
    keys: { FINNHUB_API_KEY: env.FINNHUB_API_KEY || undefined, FRED_API_KEY: env.FRED_API_KEY || undefined },
    port: int(env, "PORT", 8787, 1),
    cacheDb: cacheDb === ":memory:" ? cacheDb : path.resolve(cacheDb),
    streamIntervalMs: int(env, "STREAM_INTERVAL_MS", 5000, 500),
    staticDir: env.STATIC_DIR || path.join(REPO_ROOT, "client", "dist"),
    ai: loadAi(env),
    plugins,
    contact: env.CONTACT || env.SEC_USER_AGENT || undefined,
    auth: authMode(env.AUTH),
    authSignupOpen: (env.AUTH_SIGNUP ?? "open").trim().toLowerCase() !== "closed",
  };
}
