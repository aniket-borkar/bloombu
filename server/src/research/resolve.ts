import type express from "express";
import type { ProviderRouter } from "../providers/router.js";
import { fromYahoo, isExchangeCode, normalizeSecurity, tickerOf } from "../symbology.js";
import type { SearchResult } from "../types.js";

const MAX_INPUTS = 500;
const MAX_SEARCHES = 25;

/** True for a 12-character ISIN with a valid check digit, e.g. US0378331005. */
export function isIsin(raw: string): boolean {
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s)) return false;
  const digits = [...s].map((c) => (c >= "A" ? String(c.charCodeAt(0) - 55) : c)).join("");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d *= 2;
    sum += d > 9 ? d - 9 : d;
  }
  return sum % 10 === 0;
}

/**
 * Best-effort mapping of a pasted identifier to a Bloomberg-style security:
 * full securities ("AAPL US Equity"), tickers with or without an exchange
 * code ("AAPL", "VOD LN"), Yahoo symbols ("VOD.L", "^GSPC", "EURUSD=X",
 * "CL=F", "BTC-USD") and US Reuters codes ("AAPL.O", "IBM.N"). Returns null
 * when the text is not ticker-shaped.
 */
export function guessSecurity(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!text) return null;
  const full = normalizeSecurity(text);
  if (full) return full;
  const up = text.toUpperCase();
  if (up.startsWith("^")) return fromYahoo(up, "INDEX");
  if (up.endsWith("=X")) return fromYahoo(up, "CURRENCY");
  if (up.endsWith("=F")) return fromYahoo(up, "FUTURE");
  if (/^[A-Z]{2,5}-[A-Z]{3}$/.test(up)) return fromYahoo(up, "CRYPTOCURRENCY");
  const ric = up.match(/^([A-Z0-9-]{1,10})\.(O|OQ|N)$/);
  if (ric) return `${ric[1]} US Equity`;
  if (/^[A-Z0-9-]{1,10}\.[A-Z]{1,3}$/.test(up)) return fromYahoo(up, "EQUITY");
  const withExchange = up.match(/^([A-Z0-9/.-]{1,10}) ([A-Z0-9]{2})$/);
  if (withExchange && isExchangeCode(withExchange[2])) return `${withExchange[1]} ${withExchange[2]} Equity`;
  if (/^[A-Z0-9][A-Z0-9/.-]{0,9}$/.test(up)) return `${up} US Equity`;
  return null;
}

export interface Resolution {
  input: string;
  security: string | null;
  name: string | null;
  /** ok: priced as typed; search: picked by name search; unresolved: needs a choice; empty: blank input. */
  status: "ok" | "search" | "unresolved" | "empty";
  candidates: SearchResult[];
}

const looksLikeName = (s: string) => /[a-z]/.test(s) || /\s/.test(s.trim());

export async function resolveIdentifiers(router: ProviderRouter, inputs: string[]): Promise<Resolution[]> {
  const guesses = inputs.map(guessSecurity);
  const unique = [...new Set(guesses.filter((g): g is string => !!g))];
  const quotes = unique.length ? await router.quotes(unique).catch(() => []) : [];
  const priced = new Map(quotes.map((q) => [q.security, q.name]));

  const out: Resolution[] = inputs.map((input, i) => {
    if (!input.trim()) return { input, security: null, name: null, status: "empty", candidates: [] };
    const g = guesses[i];
    if (g && priced.has(g)) return { input, security: g, name: priced.get(g) ?? null, status: "ok", candidates: [] };
    return { input, security: null, name: null, status: "unresolved", candidates: [] };
  });

  const pending = out.filter((r) => r.status === "unresolved");
  const queries = [...new Set(pending.map((r) => r.input.trim()))].slice(0, MAX_SEARCHES);
  const results = new Map<string, SearchResult[]>();
  await Promise.all(
    queries.map(async (q) => {
      results.set(q, (await router.search(q).catch(() => [])).slice(0, 5));
    }),
  );
  for (const r of pending) {
    const candidates = results.get(r.input.trim()) ?? [];
    r.candidates = candidates;
    const exact = candidates.find((c) => tickerOf(c.security).split(" ")[0] === r.input.trim().toUpperCase());
    const pick = exact ?? (looksLikeName(r.input) || isIsin(r.input) ? candidates[0] : undefined);
    if (pick) {
      r.security = pick.security;
      r.name = pick.name;
      r.status = "search";
    }
  }
  return out;
}

export function registerResolveRoute(app: express.Express, router: ProviderRouter): void {
  app.post("/api/resolve", async (req, res) => {
    const inputs = (req.body as { inputs?: unknown })?.inputs;
    if (!Array.isArray(inputs) || inputs.length > MAX_INPUTS || !inputs.every((s) => typeof s === "string")) {
      res.status(400).json({ error: `inputs must be a list of up to ${MAX_INPUTS} strings` });
      return;
    }
    try {
      res.json(await resolveIdentifiers(router, inputs));
    } catch (err) {
      console.error("resolve", err);
      res.status(502).json({ error: "RESOLVER UNAVAILABLE" });
    }
  });
}
