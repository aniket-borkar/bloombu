import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import { RANGE_MS, type Range } from "../history/ranges.js";
import { normalizeSecurity } from "../symbology.js";
import { PORTFOLIO_RANGES, type PortfolioService } from "./service.js";
import { ValidationError, validatePortfolio, type PortfolioStore } from "./store.js";

type Req = express.Request;
type Res = express.Response;

function userOf(req: Req, res: Res): string | null {
  const user = normalizeUser((req.body as { user?: unknown } | undefined)?.user ?? req.query.user);
  if (!user) res.status(400).json({ error: "user is required (your login name)" });
  return user;
}

function idOf(req: Req, res: Res): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
    return null;
  }
  return id;
}

function analyticsParams(q: Record<string, unknown>, res: Res): { range: Range; benchmark: string } | null {
  const range = String(q.range ?? "1y") as Range;
  if (!(PORTFOLIO_RANGES as readonly string[]).includes(range) || !(range in RANGE_MS)) {
    res.status(400).json({ error: `range must be one of ${PORTFOLIO_RANGES.join(", ")}` });
    return null;
  }
  const benchmark = normalizeSecurity(String(q.benchmark ?? "SPX Index"));
  if (!benchmark) {
    res.status(400).json({ error: "benchmark must be a security, e.g. SPX Index" });
    return null;
  }
  return { range, benchmark };
}

function fail(res: Res, err: unknown, label: string): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  console.error(label, err);
  res.status(502).json({ error: "PORTFOLIO ANALYTICS UNAVAILABLE" });
}

export function registerPortfolioRoutes(app: express.Express, store: PortfolioStore, service: PortfolioService): void {
  app.get("/api/portfolios", (req, res) => {
    const user = userOf(req, res);
    if (user) res.json(store.list(user));
  });

  app.post("/api/portfolios", (req, res) => {
    const user = userOf(req, res);
    if (!user) return;
    try {
      res.status(201).json(store.create(user, validatePortfolio(req.body)));
    } catch (err) {
      fail(res, err, "portfolio create");
    }
  });

  /** Analytics for an unsaved portfolio, e.g. a draft or a what-if. */
  app.post("/api/portfolios/analytics", async (req, res) => {
    const params = analyticsParams({ ...req.query, ...(req.body ?? {}) }, res);
    if (!params) return;
    try {
      const p = validatePortfolio((req.body as { portfolio?: unknown })?.portfolio);
      res.json(await service.analyze(p, params.range, params.benchmark));
    } catch (err) {
      fail(res, err, "portfolio analytics");
    }
  });

  app.get("/api/portfolios/:id", (req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    const p = store.get(user, id);
    if (p) res.json(p);
    else res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
  });

  app.put("/api/portfolios/:id", (req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    try {
      const p = store.update(user, id, validatePortfolio(req.body));
      if (p) res.json(p);
      else res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
    } catch (err) {
      fail(res, err, "portfolio update");
    }
  });

  app.delete("/api/portfolios/:id", (req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    if (!user || !id) return;
    if (store.remove(user, id)) res.status(204).end();
    else res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
  });

  app.get("/api/portfolios/:id/analytics", async (req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    const params = id ? analyticsParams(req.query, res) : null;
    if (!user || !id || !params) return;
    const p = store.get(user, id);
    if (!p) {
      res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
      return;
    }
    try {
      res.json(await service.analyze(p, params.range, params.benchmark));
    } catch (err) {
      fail(res, err, "portfolio analytics");
    }
  });

  /** Compare the saved portfolio with an edited set of holdings. */
  app.post("/api/portfolios/:id/whatif", async (req, res) => {
    const user = userOf(req, res);
    const id = user && idOf(req, res);
    const params = id ? analyticsParams({ ...req.query, ...(req.body ?? {}) }, res) : null;
    if (!user || !id || !params) return;
    const p = store.get(user, id);
    if (!p) {
      res.status(404).json({ error: "PORTFOLIO NOT FOUND" });
      return;
    }
    try {
      const proposed = validatePortfolio({ ...p, name: `${p.name} (what-if)`, holdings: (req.body as { holdings?: unknown })?.holdings });
      const [current, whatIf] = await Promise.all([
        service.analyze(p, params.range, params.benchmark),
        service.analyze(proposed, params.range, params.benchmark),
      ]);
      res.json({ current, proposed: whatIf });
    } catch (err) {
      fail(res, err, "portfolio what-if");
    }
  });
}
