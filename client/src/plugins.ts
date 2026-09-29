import type { PluginFunctionInfo } from "../../server/src/plugins/spec";
import { api } from "./api";
import { SCREEN_REGISTRY } from "./screens";
import { PluginScreen } from "./screens/PluginScreen";
import { FUNCTION_LIST, FUNCTIONS, SECURITY_MENUS } from "./terminal/functions";
import { PLUGIN_FUNCTIONS } from "./terminal/pluginFunctions";
import type { Sector } from "./terminal/sectors";

/**
 * Add plugin functions to the command line, security menus, HELP and the
 * command palette. Codes the terminal already uses are skipped.
 */
export function registerPluginFunctions(list: PluginFunctionInfo[], warn: (msg: string) => void = console.warn): string[] {
  const added: string[] = [];
  for (const f of list) {
    if (PLUGIN_FUNCTIONS.has(f.code)) continue;
    if (FUNCTIONS[f.code]) {
      warn(`Plugin function ${f.code} from "${f.plugin}" skipped: the terminal already has ${f.code}`);
      continue;
    }
    PLUGIN_FUNCTIONS.set(f.code, f);
    const def = { code: f.code, name: f.name, security: f.security };
    FUNCTIONS[f.code] = def;
    const help = FUNCTION_LIST.findIndex((d) => d.code === "HELP");
    FUNCTION_LIST.splice(help < 0 ? FUNCTION_LIST.length : help, 0, def);
    const sectors = (f.sectors ?? null) as Sector[] | null;
    SCREEN_REGISTRY[f.code] = { component: PluginScreen, sectors: sectors ?? undefined };
    if (f.security) {
      for (const sector of sectors ?? (Object.keys(SECURITY_MENUS) as Sector[])) SECURITY_MENUS[sector].push(f.code);
    }
    added.push(f.code);
  }
  return added;
}

/** Fetch and register plugin functions; the terminal starts without them if the server is slow or down. */
export async function loadPluginFunctions(timeoutMs = 2000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    registerPluginFunctions((await api.plugins(ctrl.signal)).functions);
  } catch {
    // No plugins this session.
  } finally {
    clearTimeout(timer);
  }
}
