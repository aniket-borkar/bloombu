import type { PluginFunctionInfo } from "../../../server/src/plugins/spec";

/** Functions added by server plugins, keyed by code. */
export const PLUGIN_FUNCTIONS = new Map<string, PluginFunctionInfo>();
