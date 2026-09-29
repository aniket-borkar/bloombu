import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ALL_SECTORS, CAPABILITIES, type ProviderPlugin } from "../providers/DataProvider.js";
import type { Sector } from "../types.js";
import type { PluginAiTool, PluginContext, PluginFunction, TerminalPlugin } from "./sdk.js";

const CODE_RE = /^[A-Z][A-Z0-9]{0,7}$/;
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_OPTIONS = 9;

export interface LoadedPlugin {
  name: string;
  version: string | null;
  source: string;
  providers: string[];
  functions: string[];
  aiTools: string[];
}

export interface PluginRegistry {
  plugins: LoadedPlugin[];
  providers: ProviderPlugin[];
  functions: Map<string, { plugin: string; fn: PluginFunction }>;
  aiTools: { plugin: string; tool: PluginAiTool }[];
}

export const emptyRegistry = (): PluginRegistry => ({ plugins: [], providers: [], functions: new Map(), aiTools: [] });

/**
 * Turn a PLUGINS entry into an import specifier. Paths (starting with "." or
 * "/") resolve against baseDir and may name a file or a directory with a
 * package.json "main" or an index.mjs/index.js; anything else is a package name.
 */
export function pluginSpecifier(spec: string, baseDir: string): string {
  if (!spec.startsWith(".") && !path.isAbsolute(spec)) return spec;
  let file = path.resolve(baseDir, spec);
  if (!existsSync(file)) throw new Error(`Plugin "${spec}" not found at ${file}`);
  if (statSync(file).isDirectory()) {
    const pkgFile = path.join(file, "package.json");
    const main = existsSync(pkgFile) ? (JSON.parse(readFileSync(pkgFile, "utf8")) as { main?: unknown }).main : undefined;
    const found = [typeof main === "string" ? main : null, "index.mjs", "index.js"]
      .filter((c): c is string => !!c)
      .map((c) => path.join(file, c))
      .find((c) => existsSync(c));
    if (!found) throw new Error(`Plugin directory ${file} has no package.json "main", index.mjs or index.js`);
    file = found;
  }
  return pathToFileURL(file).href;
}

function fail(where: string, message: string): never {
  throw new Error(`Plugin ${where}: ${message}`);
}

function validateFunction(raw: unknown, where: string): PluginFunction {
  const f = raw as Partial<PluginFunction> | null;
  if (!f || typeof f !== "object") fail(where, "each function must be an object");
  if (typeof f.code !== "string" || !CODE_RE.test(f.code)) fail(where, `function code "${String(f.code)}" must be 1-8 characters A-Z/0-9 starting with a letter`);
  const at = `${where} ${f.code}`;
  if (typeof f.name !== "string" || !f.name.trim()) fail(at, "needs a name");
  if (typeof f.security !== "boolean") fail(at, "needs security: true or false");
  if (typeof f.run !== "function") fail(at, "needs a run(args) function");
  if (f.sectors !== undefined) {
    if (!Array.isArray(f.sectors) || !f.sectors.length || f.sectors.some((s) => !(ALL_SECTORS as readonly string[]).includes(s))) {
      fail(at, `sectors must be a non-empty list of ${ALL_SECTORS.join(", ")}`);
    }
    if (!f.security) fail(at, "sectors only apply to security functions");
  }
  if (f.options !== undefined) {
    if (!Array.isArray(f.options) || f.options.length > MAX_OPTIONS || f.options.some((o) => typeof o !== "string" || !o.trim())) {
      fail(at, `options must be a list of at most ${MAX_OPTIONS} labels`);
    }
  }
  return f as PluginFunction;
}

function validateProvider(raw: unknown, where: string): ProviderPlugin {
  const p = raw as Partial<ProviderPlugin> | null;
  if (!p || typeof p !== "object") fail(where, "each provider must be an object");
  if (typeof p.id !== "string" || !/^[a-z][a-z0-9_-]*$/.test(p.id)) fail(where, `provider id "${String(p.id)}" must be lowercase letters, digits, - or _`);
  if (!Array.isArray(p.sectors) || p.sectors.some((s) => !(ALL_SECTORS as readonly string[]).includes(s))) {
    fail(`${where} ${p.id}`, `sectors must list any of ${ALL_SECTORS.join(", ")}`);
  }
  if (!CAPABILITIES.some((c) => typeof p[c] === "function")) fail(`${where} ${p.id}`, `implements none of: ${CAPABILITIES.join(", ")}`);
  return p as ProviderPlugin;
}

function validateAiTool(raw: unknown, where: string): PluginAiTool {
  const t = raw as Partial<PluginAiTool> | null;
  if (!t || typeof t !== "object" || !t.spec || typeof t.spec !== "object") fail(where, "each AI tool must be an object with a spec");
  const { name, description, parameters } = t.spec;
  if (typeof name !== "string" || !TOOL_NAME_RE.test(name)) fail(where, `AI tool name "${String(name)}" must be lowercase letters, digits and _ (starting with a letter)`);
  const at = `${where} AI tool ${name}`;
  if (typeof description !== "string" || !description.trim()) fail(at, "needs a description telling the model when to use it");
  if (!parameters || typeof parameters !== "object" || (parameters as { type?: unknown }).type !== "object") fail(at, 'parameters must be a JSON Schema with type "object"');
  if (typeof t.run !== "function") fail(at, "needs a run(args, ctx) function");
  return t as PluginAiTool;
}

function validatePlugin(raw: unknown, spec: string): TerminalPlugin {
  const p = raw as Partial<TerminalPlugin> | null;
  if (!p || typeof p !== "object") fail(`"${spec}"`, "must export a plugin object or a function returning one");
  if (typeof p.name !== "string" || !p.name.trim()) fail(`"${spec}"`, "needs a name");
  const where = `"${p.name}"`;
  if (p.providers !== undefined && !Array.isArray(p.providers)) fail(where, "providers must be an array");
  if (p.functions !== undefined && !Array.isArray(p.functions)) fail(where, "functions must be an array");
  if (p.aiTools !== undefined && !Array.isArray(p.aiTools)) fail(where, "aiTools must be an array");
  if (!p.providers?.length && !p.functions?.length && !p.aiTools?.length) fail(where, "adds no providers, functions or AI tools");
  return {
    name: p.name,
    version: typeof p.version === "string" ? p.version : undefined,
    providers: (p.providers ?? []).map((x) => validateProvider(x, where)),
    functions: (p.functions ?? []).map((x) => validateFunction(x, where)),
    aiTools: (p.aiTools ?? []).map((x) => validateAiTool(x, where)),
  };
}

export interface LoadOptions {
  baseDir: string;
  /** Provider ids already taken by the built-in providers. */
  reservedProviders?: readonly string[];
  /** AI tool names already taken by the analyst's built-in tools. */
  reservedTools?: readonly string[];
  importer?: (specifier: string) => Promise<unknown>;
}

/** Import, validate and register every plugin. Any problem stops startup with a message naming the plugin. */
export async function loadPlugins(specs: string[], ctx: PluginContext, options: LoadOptions): Promise<PluginRegistry> {
  const registry = emptyRegistry();
  const providerIds = new Set(options.reservedProviders ?? []);
  const reservedTools = new Set(options.reservedTools ?? []);
  const toolOwners = new Map<string, string>();
  const names = new Set<string>();
  const importer = options.importer ?? ((s: string) => import(s));

  for (const spec of specs) {
    const specifier = pluginSpecifier(spec, options.baseDir);
    let mod: unknown;
    try {
      mod = await importer(specifier);
    } catch (err) {
      throw new Error(`Plugin "${spec}" failed to load: ${(err as Error).message}`);
    }
    const exported = (mod as { default?: unknown }).default ?? mod;
    const shared = ctx.cache;
    const pluginCtx: PluginContext = shared ? { ...ctx, cache: { wrap: (key, ttlMs, load) => shared.wrap(`plugin:${spec}:${key}`, ttlMs, load) } } : ctx;
    let raw: unknown;
    try {
      raw = typeof exported === "function" ? await exported(pluginCtx) : exported;
    } catch (err) {
      throw new Error(`Plugin "${spec}" failed to initialize: ${(err as Error).message}`);
    }
    const plugin = validatePlugin(raw, spec);
    if (names.has(plugin.name)) fail(`"${plugin.name}"`, "is loaded twice");
    names.add(plugin.name);

    for (const p of plugin.providers!) {
      if (providerIds.has(p.id)) fail(`"${plugin.name}"`, `provider id "${p.id}" is already in use`);
      providerIds.add(p.id);
      registry.providers.push(p);
    }
    for (const f of plugin.functions!) {
      const taken = registry.functions.get(f.code);
      if (taken) fail(`"${plugin.name}"`, `function ${f.code} is already defined by plugin "${taken.plugin}"`);
      registry.functions.set(f.code, { plugin: plugin.name, fn: f });
    }
    for (const tool of plugin.aiTools!) {
      const name = tool.spec.name;
      if (reservedTools.has(name)) fail(`"${plugin.name}"`, `AI tool ${name} is already a built-in analyst tool`);
      const owner = toolOwners.get(name);
      if (owner) fail(`"${plugin.name}"`, `AI tool ${name} is already defined by plugin "${owner}"`);
      toolOwners.set(name, plugin.name);
      registry.aiTools.push({ plugin: plugin.name, tool });
    }
    registry.plugins.push({
      name: plugin.name,
      version: plugin.version ?? null,
      source: spec,
      providers: plugin.providers!.map((p) => p.id),
      functions: plugin.functions!.map((f) => f.code),
      aiTools: plugin.aiTools!.map((t) => t.spec.name),
    });
    const added = [...plugin.functions!.map((f) => f.code), ...plugin.providers!.map((p) => `provider ${p.id}`), ...plugin.aiTools!.map((t) => `AI tool ${t.spec.name}`)];
    ctx.log(`plugin ${plugin.name} loaded (${added.join(", ")})`);
  }
  return registry;
}

export function isSectorSupported(fn: PluginFunction, sector: Sector | null): boolean {
  return !fn.sectors || (sector !== null && fn.sectors.includes(sector));
}
