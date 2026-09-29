import type express from "express";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity, sectorOf } from "../symbology.js";
import type { IndexMembers, MemberRow, MembersAnalysis, Quote, Valuation } from "../types.js";

/** "Alphabet Inc. (Class A)" and "Alphabet Inc. (Class C)" name the same company. */
export function companyOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/\(?\bclass [a-z]\b\)?/g, " ")
    .replace(/\b((common|capital|ordinary|voting|non-voting) (stock|shares)|american depositary shares|ads)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Weights and point contributions estimated from live data. Index providers
 * weight by free-float market cap, so cap weights here are approximations.
 */
export function analyzeMembers(m: IndexMembers, quotes: Quote[], valuations: Valuation[], index: Quote | null): MembersAnalysis {
  const q = new Map(quotes.map((x) => [x.security, x]));
  const v = new Map(valuations.map((x) => [x.security, x]));
  // Share classes of one company (GOOGL/GOOG) each report a company-wide market cap; split it between them.
  const caps = new Map<string, number[]>();
  for (const x of m.members) {
    const cap = v.get(x.security)?.marketCap;
    if (cap) caps.set(companyOf(x.name), [...(caps.get(companyOf(x.name)) ?? []), cap]);
  }
  const classesOf = (name: string) => {
    const list = caps.get(companyOf(name)) ?? [];
    return list.length > 1 && Math.max(...list) <= Math.min(...list) * 1.1 ? list.length : 1;
  };
  const names = new Map(m.members.map((x) => [x.security, x.name]));
  const size = (sec: string, current: boolean) => {
    const quote = q.get(sec);
    const pct = quote?.changePct ?? 0;
    const cap = v.get(sec)?.marketCap ?? null;
    const base = m.weighting === "price" ? quote?.last : cap !== null ? cap / classesOf(names.get(sec) ?? sec) : null;
    if (base === null || base === undefined || !(base > 0)) return null;
    return current ? base : base / (1 + pct / 100);
  };
  const totalNow = m.members.reduce((s, x) => s + (size(x.security, true) ?? 0), 0);
  const totalPrev = m.members.reduce((s, x) => s + (size(x.security, false) ?? 0), 0);
  const prevLevel = index?.prevClose ?? (index?.last !== null && index?.last !== undefined && index.change !== null ? index.last - index.change : null);
  const rows: MemberRow[] = m.members.map((x) => {
    const quote = q.get(x.security);
    const now = size(x.security, true);
    const prev = size(x.security, false);
    const weightPct = now !== null && totalNow > 0 ? (now / totalNow) * 100 : null;
    const points =
      prev !== null && totalPrev > 0 && prevLevel !== null && quote?.changePct !== null && quote?.changePct !== undefined
        ? (prev / totalPrev) * (quote.changePct / 100) * prevLevel
        : null;
    return {
      security: x.security,
      name: quote?.name || x.name,
      sector: x.sector,
      last: quote?.last ?? null,
      change: quote?.change ?? null,
      changePct: quote?.changePct ?? null,
      currency: quote?.currency ?? null,
      marketCap: v.get(x.security)?.marketCap ?? null,
      weightPct,
      points,
    };
  });
  const bySector = new Map<string, { weightPct: number; points: number; count: number }>();
  for (const r of rows) {
    const key = r.sector ?? "Other";
    const s = bySector.get(key) ?? { weightPct: 0, points: 0, count: 0 };
    s.weightPct += r.weightPct ?? 0;
    s.points += r.points ?? 0;
    s.count++;
    bySector.set(key, s);
  }
  const priced = rows.filter((r) => r.last !== null);
  return {
    index: m.index,
    name: m.name,
    weighting: m.weighting,
    source: m.source,
    sourceUrl: m.sourceUrl,
    level: index?.last ?? null,
    change: index?.change ?? null,
    changePct: index?.changePct ?? null,
    total: rows.length,
    priced: priced.length,
    advancers: priced.filter((r) => (r.changePct ?? 0) > 0).length,
    decliners: priced.filter((r) => (r.changePct ?? 0) < 0).length,
    members: rows.sort((a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1)),
    sectors: [...bySector.entries()].map(([sector, s]) => ({ sector, ...s })).sort((a, b) => b.weightPct - a.weightPct),
  };
}

export async function membersFor(router: ProviderRouter, security: string): Promise<MembersAnalysis | null> {
  const m = await router.indexMembers(security);
  if (!m) return null;
  const secs = m.members.map((x) => x.security);
  const [quotes, valuations, index] = await Promise.all([
    router.quotes(secs).catch(() => []),
    m.weighting === "cap" ? router.valuations(secs).catch(() => []) : Promise.resolve([]),
    router.quote(m.index).catch(() => null),
  ]);
  return analyzeMembers(m, quotes, valuations, index);
}

export function registerMembersRoute(app: express.Express, router: ProviderRouter): void {
  app.get("/api/members/:security", async (req, res) => {
    const security = normalizeSecurity(String(req.params.security));
    if (!security || sectorOf(security) !== "Index") {
      res.status(400).json({ error: "MEMB NEEDS AN INDEX, E.G. SPX Index" });
      return;
    }
    try {
      const result = await membersFor(router, security);
      if (result) res.json(result);
      else res.status(404).json({ error: `NO MEMBER LIST FOR ${security.toUpperCase()}. COVERED: SPX INDU NDX UKX DAX CAC SX5E HSI AS51` });
    } catch (err) {
      console.error("members", err);
      res.status(502).json({ error: "MEMBER DATA SOURCE UNAVAILABLE" });
    }
  });
}
