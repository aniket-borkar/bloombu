import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { registerAuth, type AuthService } from "./auth/auth.js";
import type { ChatService } from "./chat/chat.js";
import type { HistoryCache } from "./history/cache.js";
import { registerResolveRoute } from "./research/resolve.js";
import { registerResearchRoutes } from "./research/routes.js";
import { parseHistoryQuery, RANGE_MS } from "./history/ranges.js";
import { QUOTE_SNAPSHOT_TTL_MS, TtlCache } from "./providers/cache.js";
import type { ProviderRouter } from "./providers/router.js";
import { normalizeSecurity } from "./symbology.js";
import type { Quote, SearchResult } from "./types.js";

export const TICKER_TAPE = [
  "INDU Index",
  "SPX Index",
  "CCMP Index",
  "RTY Index",
  "VIX Index",
  "SPTSX Index",
  "UKX Index",
  "DAX Index",
  "CAC Index",
  "SX5E Index",
  "NKY Index",
  "HSI Index",
  "AS51 Index",
  "USGG10YR Index",
  "EURUSD Curncy",
  "USDJPY Curncy",
  "GBPUSD Curncy",
  "CL1 Comdty",
  "GC1 Comdty",
  "XBTUSD Curncy",
];

/** When a window has no bars (weekend, holiday), look back this much further for the latest session. */
const SESSION_GAP_MS = 4 * 86_400_000;

export interface AppDeps {
  router: ProviderRouter;
  history: HistoryCache;
  chat?: ChatService;
  now?: () => number;
  /** Built client to serve at `/`, when present. */
  staticDir?: string;
  /** Additional route registrars (portfolios, alerts, AI, plugins). */
  routes?: ((app: express.Express) => void)[];
  /** Sign-in gate for /api (AUTH=password); null leaves the API open. */
  auth?: AuthService | null;
}

export function createApp({ router, history, chat, now = Date.now, staticDir, routes = [], auth = null }: AppDeps): express.Express {
  const quoteCache = new TtlCache<Quote | null>(QUOTE_SNAPSHOT_TTL_MS);
  const tapeCache = new TtlCache<Quote[]>(QUOTE_SNAPSHOT_TTL_MS);
  const searchCache = new TtlCache<SearchResult[]>(60_000);

  const app = express();
  app.use("/api", express.json({ limit: "1mb" }), express.text({ type: "text/*", limit: "1mb" }));
  registerAuth(app, auth);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, providers: router.plugins.map((p) => p.id) });
  });

  app.get("/api/providers", (_req, res) => {
    res.json(router.describe());
  });

  app.get("/api/stream/routes", (req, res) => {
    res.set("Cache-Control", "no-store");
    const input = typeof req.query.s === "string" ? req.query.s.split(",") : [];
    if (!input.length || input.length > 200) {
      res.status(400).json({ error: "s must list 1-200 valid securities, comma-separated" });
      return;
    }
    const normalized = input.map(normalizeSecurity);
    if (normalized.some((security) => !security)) {
      res.status(400).json({ error: "s must list 1-200 valid securities, comma-separated" });
      return;
    }
    const securities = [...new Set(normalized as string[])];
    res.json({
      routes: securities.map((security) => {
        const provider = router.streamingPlugin(security)?.id;
        return { security, provider: provider === "yahoo" || provider === "kraken" ? provider : null };
      }),
    });
  });

  app.get("/api/quote/:security", async (req, res) => {
    const security = normalizeSecurity(req.params.security);
    if (!security) {
      res.status(404).json({ error: "UNKNOWN SECURITY" });
      return;
    }
    try {
      const q = await quoteCache.get(security, () => router.quote(security));
      if (!q || q.last === null) {
        res.status(404).json({ error: "UNKNOWN SECURITY" });
        return;
      }
      res.json(q);
    } catch (err) {
      console.error("quote", security, err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });

  app.get("/api/history/:security", async (req, res) => {
    const security = normalizeSecurity(req.params.security);
    const query = parseHistoryQuery(req.query);
    if ("error" in query) {
      res.status(400).json({ error: query.error });
      return;
    }
    if (!security) {
      res.status(404).json({ error: "UNKNOWN SECURITY" });
      return;
    }
    const to = now();
    const span = RANGE_MS[query.range];
    try {
      let bars = await history.get(security, query.interval, to - span, to);
      if (!bars.length) {
        const wider = await history.get(security, query.interval, to - span - SESSION_GAP_MS, to);
        const last = wider.at(-1);
        bars = last ? wider.filter((b) => b.t > last.t - span) : [];
      }
      if (!bars.length) {
        res.status(404).json({ error: "NO HISTORY" });
        return;
      }
      res.json({ security, interval: query.interval, range: query.range, bars });
    } catch (err) {
      console.error("history", security, err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });

  app.get("/api/search", async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.json([]);
      return;
    }
    try {
      res.json(await searchCache.get(q.toUpperCase(), () => router.search(q)));
    } catch (err) {
      console.error("search", q, err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });

  app.get("/api/indices", async (_req, res) => {
    try {
      res.json(await tapeCache.get("tape", () => router.quotes(TICKER_TAPE)));
    } catch (err) {
      console.error("indices", err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });

  registerResearchRoutes(app, router, chat);
  registerResolveRoute(app, router);
  for (const register of routes) register(app);

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "NOT FOUND" });
  });

  app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === "entity.parse.failed" || err.type === "entity.too.large") {
      res.status(err.status ?? 400).json({ error: err.type === "entity.too.large" ? "REQUEST TOO LARGE" : "INVALID JSON" });
      return;
    }
    console.error("unhandled", err);
    res.status(500).json({ error: "INTERNAL ERROR" });
  });

  if (staticDir && existsSync(path.join(staticDir, "index.html"))) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get(/.*/, (_req, res) => {
      res.sendFile("index.html", { root: staticDir });
    });
  }

  return app;
}
