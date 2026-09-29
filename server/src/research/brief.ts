import type express from "express";
import { describeAlert, type AlertService } from "../alerts/alerts.js";
import { normalizeUser } from "../chat/chat.js";
import type { PortfolioService } from "../portfolio/service.js";
import type { PortfolioStore } from "../portfolio/store.js";
import { mergeHeadlines } from "../providers/newsFeeds.js";
import type { ProviderRouter } from "../providers/router.js";
import type { Brief } from "../types.js";
import { rateProbabilities } from "./wirp.js";

export const BRIEF_MARKETS = [
  "SPX Index",
  "CCMP Index",
  "INDU Index",
  "RTY Index",
  "VIX Index",
  "UKX Index",
  "DAX Index",
  "NKY Index",
  "USGG10YR Index",
  "EURUSD Curncy",
  "USDJPY Curncy",
  "CL1 Comdty",
  "GC1 Comdty",
  "XBTUSD Curncy",
];

const MAX_PORTFOLIOS = 3;

export interface BriefDeps {
  router: ProviderRouter;
  portfolios: PortfolioStore;
  portfolioService: PortfolioService;
  alerts: AlertService;
  now?: () => number;
}

/** Everything a morning look needs on one screen; each section degrades to empty on its own. */
export async function buildBrief(deps: BriefDeps, user: string | null): Promise<Brief> {
  const now = deps.now?.() ?? Date.now();
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  const [quotes, gainers, losers, news, rates, curve] = await Promise.all([
    safe(deps.router.quotes(BRIEF_MARKETS), []),
    safe(deps.router.first("screen", null, (p) => p.screen!("day_gainers")), null),
    safe(deps.router.first("screen", null, (p) => p.screen!("day_losers")), null),
    safe(deps.router.all("topNews", null, (p) => p.topNews!()), []),
    safe(rateProbabilities(deps.router, new Date(now)), null),
    safe(deps.router.first("yieldCurve", null, (p) => p.yieldCurve!()), null),
  ]);

  const portfolios: Brief["portfolios"] = [];
  for (const summary of user ? deps.portfolios.list(user).slice(0, MAX_PORTFOLIOS) : []) {
    const p = deps.portfolios.get(user!, summary.id);
    if (!p) continue;
    const a = await deps.portfolioService.analyze(p, "3mo", "SPX Index").catch(() => null);
    if (!a) continue;
    const moves = a.holdings.filter((h) => h.dayPnl !== null).sort((x, y) => y.dayPnl! - x.dayPnl!);
    const prev = a.totals.marketValue - a.totals.dayPnl;
    portfolios.push({
      id: p.id,
      name: p.name,
      baseCurrency: p.baseCurrency,
      marketValue: a.totals.marketValue,
      dayPnl: a.totals.dayPnl,
      dayPct: prev > 0 ? (a.totals.dayPnl / prev) * 100 : null,
      best: moves[0] ? { security: moves[0].security, dayPnl: moves[0].dayPnl! } : null,
      worst: moves.length > 1 ? { security: moves.at(-1)!.security, dayPnl: moves.at(-1)!.dayPnl! } : null,
    });
  }

  const dayStart = now - (now % 86_400_000);
  const alertList = user ? deps.alerts.list(user) : { active: [], triggered: [] };
  const next = rates?.meetings.find((m) => m.stepBp !== null) ?? null;
  const at = (tenor: string) => curve?.points.find((p) => p.tenor === tenor)?.yieldPct ?? null;
  const two = at("2Y");
  const ten = at("10Y");
  return {
    asOf: new Date(now).toISOString(),
    markets: quotes.map((q) => ({ security: q.security, name: q.name, last: q.last, change: q.change, changePct: q.changePct })),
    gainers: (gainers ?? []).slice(0, 5),
    losers: (losers ?? []).slice(0, 5),
    portfolios,
    alerts: {
      active: alertList.active.length,
      triggeredToday: alertList.triggered
        .filter((a) => (a.triggeredAt ?? 0) >= dayStart)
        .slice(0, 5)
        .map((a) => ({ security: a.security, description: describeAlert(a), at: a.triggeredAt! })),
    },
    nextFomc: next ? { date: next.date, impliedChangeBp: next.stepBp, direction: next.direction } : null,
    curve: curve ? { twoYear: two, tenYear: ten, spreadBp: two !== null && ten !== null ? (ten - two) * 100 : null } : null,
    headlines: mergeHeadlines(news, 8),
  };
}

export function registerBriefRoute(app: express.Express, deps: BriefDeps): void {
  app.get("/api/brief", async (req, res) => {
    res.json(await buildBrief(deps, normalizeUser(req.query.user)));
  });
}
