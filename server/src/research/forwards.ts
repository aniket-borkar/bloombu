import type express from "express";
import type { ProviderRouter } from "../providers/router.js";
import { cryptoPair, normalizeSecurity, parseSecurity } from "../symbology.js";
import type { ForwardCurve } from "../types.js";
import { forwardCurve } from "./fxmath.js";

export { FORWARD_TENORS, forwardCurve } from "./fxmath.js";

const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);

/** Base and quote currency of an FX security ("EURUSD Curncy" -> EUR, USD; "JPY Curncy" -> USD, JPY). */
export function fxPair(security: string): { base: string; quote: string } | null {
  const p = parseSecurity(security);
  if (p?.sector !== "Curncy" || cryptoPair(security)) return null;
  const code = p.ticker.replace(/\s/g, "");
  if (/^[A-Z]{6}$/.test(code)) return { base: code.slice(0, 3), quote: code.slice(3) };
  if (/^[A-Z]{3}$/.test(code) && code !== "USD") return USD_QUOTED.has(code) ? { base: code, quote: "USD" } : { base: "USD", quote: code };
  return null;
}

export class ForwardError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function forwardsFor(router: ProviderRouter, raw: string): Promise<ForwardCurve> {
  const security = normalizeSecurity(raw);
  const pair = security ? fxPair(security) : null;
  if (!security || !pair) throw new ForwardError(400, "FRD NEEDS A CURRENCY PAIR, E.G. EURUSD Curncy");
  const [rates, spotQuote] = await Promise.all([router.first("overnightRates", null, (p) => p.overnightRates!()), router.quote(security)]);
  const byCcy = new Map((rates ?? []).map((r) => [r.currency, r]));
  const base = byCcy.get(pair.base);
  const quote = byCcy.get(pair.quote);
  if (!base || !quote) {
    const have = [...byCcy.keys()].join(" ") || "none";
    throw new ForwardError(404, `NO FREE OVERNIGHT RATE FOR ${!base ? pair.base : pair.quote}. AVAILABLE: ${have}`);
  }
  if (spotQuote?.last === null || spotQuote?.last === undefined) throw new ForwardError(404, `NO SPOT RATE FOR ${security.toUpperCase()}`);
  return forwardCurve(security, spotQuote.last, base, quote);
}

export function registerForwardRoutes(app: express.Express, router: ProviderRouter): void {
  app.get("/api/rates/overnight", async (_req, res) => {
    try {
      res.json((await router.first("overnightRates", null, (p) => p.overnightRates!())) ?? []);
    } catch (err) {
      console.error("overnight rates", err);
      res.status(502).json({ error: "RATE DATA SOURCE UNAVAILABLE" });
    }
  });
  app.get("/api/forwards/:security", async (req, res) => {
    try {
      res.json(await forwardsFor(router, String(req.params.security)));
    } catch (err) {
      if (err instanceof ForwardError) res.status(err.status).json({ error: err.message });
      else {
        console.error("forwards", err);
        res.status(502).json({ error: "FORWARD DATA SOURCE UNAVAILABLE" });
      }
    }
  });
}
