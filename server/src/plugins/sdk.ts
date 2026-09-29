/**
 * The contract for BLMBU plugins. A plugin is an ES module whose default export
 * is a TerminalPlugin, or a (possibly async) function that receives the
 * PluginContext and returns one. See PLUGINS.md.
 */
import type { ToolSpec } from "../ai/llm.js";
import type { ProviderPlugin } from "../providers/DataProvider.js";
import type { ProviderRouter } from "../providers/router.js";
import type { Sector } from "../types.js";
import type { ScreenSpec } from "./spec.js";

export type * from "./spec.js";

export interface PluginCache {
  /** Cached JSON value for `key`, loaded once (even for concurrent callers) when missing or older than `ttlMs`. Survives restarts. */
  wrap<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>;
}

export interface PluginContext {
  /** True when PROVIDERS includes mock: return fixture data and make no network calls. */
  mock: boolean;
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  /** The server's persistent cache, with keys private to this plugin. */
  cache?: PluginCache;
}

export interface RunArgs {
  /** The panel's security for security functions (normalized, e.g. "AAPL US Equity"), else null. */
  security: string | null;
  /** Index of the selected entry in `options` (0 when the function has none). */
  option: number;
  /** The terminal's data router: quotes, history, profile, financials and every other capability. */
  router: ProviderRouter;
  /** Aborted when the request times out or the client goes away. */
  signal: AbortSignal;
}

export interface PluginFunction {
  /** Function code typed on the command line: 1-8 characters, A-Z and 0-9, starting with a letter. */
  code: string;
  name: string;
  /** Security functions run on the panel's loaded security. */
  security: boolean;
  /** Sectors a security function supports (default: any), e.g. ["Equity"]. */
  sectors?: Sector[];
  /** Numbered option bar labels (at most 9); the selection arrives as RunArgs.option. */
  options?: string[];
  run(args: RunArgs): ScreenSpec | Promise<ScreenSpec>;
}

export interface AiToolContext {
  /** The terminal's data router. */
  router: ProviderRouter;
  /** Aborted when the call times out (30 s); pass it to fetch. */
  signal: AbortSignal;
  /** The analyst cuts each result off after this many characters of JSON; size pages of text to fit. */
  maxResultChars: number;
}

export interface AiToolOutput {
  /** JSON data for the model. Keep it compact: long results are truncated. */
  result: unknown;
  /** One line shown to the user under the answer, e.g. "Read Item 1A of AAPL's 10-K". */
  summary: string;
  /** Where the data came from, listed under the answer. Links must be http(s). */
  sources?: { label: string; url?: string; asOf?: string }[];
}

export interface PluginAiTool {
  /** `name` is lowercase snake_case and unused by the terminal; `description` and JSON Schema `parameters` tell the model when and how to call it. */
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: AiToolContext): AiToolOutput | Promise<AiToolOutput>;
}

export interface TerminalPlugin {
  name: string;
  version?: string;
  /** Data providers, added to the router after the built-in PROVIDERS unless listed there by id. */
  providers?: ProviderPlugin[];
  functions?: PluginFunction[];
  /** Tools the AI analyst can call, for example to read documents the plugin can fetch. */
  aiTools?: PluginAiTool[];
}

export type PluginModule = TerminalPlugin | ((ctx: PluginContext) => TerminalPlugin | Promise<TerminalPlugin>);
