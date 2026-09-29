import type express from "express";
import type { ProviderRouter } from "../providers/router.js";
import { futuresContracts } from "../symbology.js";
import type { FomcMeeting, MoneyMarkets, RateProbabilities, WirpMeeting } from "../types.js";

const monthKey = (iso: string) => iso.slice(0, 7);
const nextMonth = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
};
const daysIn = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Rate path implied by fed funds futures, meeting by meeting (the CME FedWatch
 * method). A futures contract settles on the month's average rate, so for a
 * meeting on day d of an N-day month: avg = (d/N)·before + ((N−d)/N)·after.
 * When the following month has no meeting, its contract gives `after` directly.
 */
export function impliedPath(meetings: FomcMeeting[], avgByMonth: Map<string, number>, contractByMonth: Map<string, string>, currentRatePct: number): WirpMeeting[] {
  const months = new Set(meetings.map((m) => monthKey(m.date)));
  let before = currentRatePct;
  return meetings.map((mtg) => {
    const key = monthKey(mtg.date);
    const day = Number(mtg.date.slice(8, 10));
    const n = daysIn(key);
    const next = nextMonth(key);
    let after: number | null = null;
    if (!months.has(next) && avgByMonth.has(next)) after = avgByMonth.get(next)!;
    else if (avgByMonth.has(key) && n > day) after = (avgByMonth.get(key)! * n - before * day) / (n - day);
    if (after === null) {
      return { date: mtg.date, sep: mtg.sep, contract: contractByMonth.get(key) ?? null, impliedRatePct: null, stepBp: null, cumulativeBp: null, movesPriced: null, probabilityPct: null, direction: null };
    }
    const stepBp = (after - before) * 100;
    const cumulativeBp = (after - currentRatePct) * 100;
    before = after;
    return {
      date: mtg.date,
      sep: mtg.sep,
      contract: contractByMonth.get(key) ?? null,
      impliedRatePct: after,
      stepBp,
      cumulativeBp,
      movesPriced: cumulativeBp / 25,
      probabilityPct: (Math.abs(stepBp) / 25) * 100,
      direction: stepBp >= 2.5 ? "hike" : stepBp <= -2.5 ? "cut" : "hold",
    };
  });
}

function currentRates(mm: MoneyMarkets | null): { effr: number | null; low: number | null; high: number | null } {
  const effr = mm?.rates.find((r) => r.name.startsWith("Effective Fed Funds"))?.ratePct ?? null;
  const range = mm?.rates.map((r) => r.note?.match(/Range (\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/)).find(Boolean);
  return { effr, low: range ? Number(range[1]) : null, high: range ? Number(range[2]) : null };
}

export async function rateProbabilities(router: ProviderRouter, now = new Date()): Promise<RateProbabilities | null> {
  const contracts = futuresContracts("FF1 Comdty", now, 16);
  const [calendar, mm, quotes] = await Promise.all([
    router.fomcCalendar(),
    router.first("moneyMarkets", null, (p) => p.moneyMarkets!()),
    router.quotes(contracts.map((c) => c.security)),
  ]);
  const { effr, low, high } = currentRates(mm);
  const current = effr ?? (low !== null && high !== null ? (low + high) / 2 : null);
  if (current === null) return null;
  const price = new Map(quotes.map((q) => [q.security, q.last]));
  const avgByMonth = new Map<string, number>();
  const contractByMonth = new Map<string, string>();
  const months = contracts.map((c, i) => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const key = d.toISOString().slice(0, 7);
    const p = price.get(c.security) ?? null;
    contractByMonth.set(key, c.security);
    if (p !== null) avgByMonth.set(key, 100 - p);
    return { month: c.month, contract: c.security, price: p, impliedRatePct: p === null ? null : 100 - p };
  });
  const today = now.toISOString().slice(0, 10);
  const upcoming = calendar.filter((m) => m.date >= today);
  return {
    currentRatePct: current,
    targetLow: low,
    targetHigh: high,
    meetings: impliedPath(upcoming, avgByMonth, contractByMonth, current),
    months,
    source: "Fed funds futures (CBOT) via the configured quote provider; FOMC calendar from federalreserve.gov; EFFR from the New York Fed",
  };
}

export function registerWirpRoute(app: express.Express, router: ProviderRouter): void {
  app.get("/api/wirp", async (_req, res) => {
    try {
      const result = await rateProbabilities(router);
      if (result) res.json(result);
      else res.status(404).json({ error: "NO CURRENT FED FUNDS RATE AVAILABLE" });
    } catch (err) {
      console.error("wirp", err);
      res.status(502).json({ error: "RATE DATA SOURCE UNAVAILABLE" });
    }
  });
}
