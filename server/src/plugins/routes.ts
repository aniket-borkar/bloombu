import type { Express } from "express";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity, sectorOf } from "../symbology.js";
import { isSectorSupported, type PluginRegistry } from "./loader.js";
import { sanitizeSpec, SpecError, type PluginFunctionInfo } from "./spec.js";

class Timeout extends Error {}

export function registerPluginRoutes(app: Express, registry: PluginRegistry, router: ProviderRouter, timeoutMs = 20_000): void {
  app.get("/api/plugins", (_req, res) => {
    const functions: PluginFunctionInfo[] = [...registry.functions.entries()].map(([code, { plugin, fn }]) => ({
      code,
      name: fn.name,
      security: fn.security,
      sectors: fn.sectors ?? null,
      options: fn.options ?? [],
      plugin,
    }));
    res.json({ plugins: registry.plugins, functions });
  });

  app.get("/api/plugins/run/:code", async (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const entry = registry.functions.get(code);
    if (!entry) {
      res.status(404).json({ error: `UNKNOWN PLUGIN FUNCTION ${code}` });
      return;
    }
    const { fn } = entry;
    let security: string | null = null;
    if (fn.security) {
      security = normalizeSecurity(String(req.query.security ?? ""));
      if (!security) {
        res.status(400).json({ error: `${code} NEEDS A SECURITY` });
        return;
      }
      if (!isSectorSupported(fn, sectorOf(security))) {
        res.status(400).json({ error: `${code} IS AVAILABLE FOR ${fn.sectors!.join(", ").toUpperCase()} SECURITIES ONLY` });
        return;
      }
    }
    const optionCount = fn.options?.length ?? 0;
    const requested = Number.parseInt(String(req.query.option ?? "0"), 10);
    const option = optionCount && Number.isInteger(requested) ? Math.min(Math.max(requested, 0), optionCount - 1) : 0;

    const ctrl = new AbortController();
    const onClose = () => ctrl.abort();
    res.on("close", onClose);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new Timeout());
      }, timeoutMs);
    });
    try {
      const raw = await Promise.race([Promise.resolve().then(() => fn.run({ security, option, router, signal: ctrl.signal })), timeout]);
      res.json(sanitizeSpec(raw));
    } catch (err) {
      if (res.headersSent || res.destroyed) return;
      if (err instanceof Timeout) res.status(504).json({ error: `${code} TIMED OUT` });
      else if (err instanceof SpecError) res.status(502).json({ error: `${code} RETURNED AN INVALID SCREEN: ${err.message}` });
      else res.status(502).json({ error: (err as Error).message || `${code} FAILED` });
    } finally {
      clearTimeout(timer);
      res.off("close", onClose);
    }
  });
}
