import type express from "express";
import type { ChatService } from "../chat/chat.js";
import { normalizeUser } from "../chat/chat.js";
import { TtlCache } from "../providers/cache.js";
import { mergeHeadlines } from "../providers/newsFeeds.js";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity } from "../symbology.js";
import { SCREENS, type ScreenId, type Statement, type StatementPeriod } from "../types.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const MAX_BATCH = 100;

type Res = express.Response;

const empty = (v: unknown) => v === null || v === undefined || (Array.isArray(v) && v.length === 0);

/** Send `load()` as JSON: 404 with `notFound` when empty, 502 when the source fails. */
async function send(res: Res, label: string, load: () => Promise<unknown>, notFound = "NO DATA AVAILABLE"): Promise<void> {
  try {
    const value = await load();
    if (empty(value)) {
      res.status(404).json({ error: notFound });
      return;
    }
    res.json(value);
  } catch (err) {
    console.error(label, err);
    res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
  }
}

function securityParam(req: express.Request, res: Res): string | null {
  const security = normalizeSecurity(String(req.params.security ?? ""));
  if (!security) res.status(404).json({ error: "UNKNOWN SECURITY" });
  return security;
}

function listParam(req: express.Request, res: Res): string[] | null {
  const list = [
    ...new Set(
      String(req.query.s ?? "")
        .split(",")
        .map((s) => normalizeSecurity(s))
        .filter((s): s is string => !!s),
    ),
  ];
  if (!list.length || list.length > MAX_BATCH) {
    res.status(400).json({ error: `s must list 1-${MAX_BATCH} securities, comma-separated` });
    return null;
  }
  return list;
}

const ISSUER_SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|plc|public limited company|ltd|limited|sa|ag|se|nv|spa|holdings?)\b\.?/g;

/** Loose issuer-name key used to group listings of the same company. */
export function issuerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,&']/g, " ")
    .replace(ISSUER_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerResearchRoutes(app: express.Express, router: ProviderRouter, chat?: ChatService): void {
  const cache = <T>(ttl: number) => new TtlCache<T>(ttl);
  const c = {
    quotes: cache<unknown>(15_000),
    profile: cache<unknown>(HOUR),
    financials: cache<unknown>(6 * HOUR),
    earnings: cache<unknown>(HOUR),
    analysts: cache<unknown>(HOUR),
    holders: cache<unknown>(6 * HOUR),
    events: cache<unknown>(6 * HOUR),
    options: cache<unknown>(MIN),
    related: cache<unknown>(HOUR),
    valuations: cache<unknown>(MIN),
    listings: cache<unknown>(HOUR),
    futures: cache<unknown>(MIN),
    news: cache<unknown>(5 * MIN),
    screens: cache<unknown>(MIN),
    curve: cache<unknown>(HOUR),
    money: cache<unknown>(HOUR),
    econ: cache<unknown>(24 * HOUR),
    calendar: cache<unknown>(6 * HOUR),
  };

  app.get("/api/quotes", (req, res) => {
    const list = listParam(req, res);
    if (list) void send(res, "quotes", () => c.quotes.get(list.join("|"), () => router.quotes(list)));
  });

  app.get("/api/valuations", (req, res) => {
    const list = listParam(req, res);
    if (list) void send(res, "valuations", () => c.valuations.get(list.join("|"), () => router.valuations(list)));
  });

  const bySecurity = (
    route: string,
    capability: Parameters<ProviderRouter["first"]>[0],
    store: TtlCache<unknown>,
    call: (s: string) => (p: NonNullable<ProviderRouter["plugins"][number]>) => Promise<unknown>,
  ) =>
    app.get(route, (req, res) => {
      const security = securityParam(req, res);
      if (security) void send(res, capability, () => store.get(security, () => router.first(capability, security, call(security))));
    });

  bySecurity("/api/profile/:security", "profile", c.profile, (s) => (p) => p.profile!(s));
  bySecurity("/api/earnings/:security", "earnings", c.earnings, (s) => (p) => p.earnings!(s));
  bySecurity("/api/analysts/:security", "analysts", c.analysts, (s) => (p) => p.analysts!(s));
  bySecurity("/api/holders/:security", "holders", c.holders, (s) => (p) => p.holders!(s));
  bySecurity("/api/events/:security", "events", c.events, (s) => (p) => p.events!(s));
  bySecurity("/api/related/:security", "related", c.related, (s) => (p) => p.related!(s));
  bySecurity("/api/futures/:security", "futuresChain", c.futures, (s) => (p) => p.futuresChain!(s));
  bySecurity("/api/news/company/:security", "companyNews", c.news, (s) => (p) => p.companyNews!(s));

  app.get("/api/financials/:security", (req, res) => {
    const security = securityParam(req, res);
    if (!security) return;
    const statement = String(req.query.statement ?? "income") as Statement;
    const period = String(req.query.period ?? "annual") as StatementPeriod;
    if (!["income", "balance", "cashflow"].includes(statement) || !["annual", "quarterly"].includes(period)) {
      res.status(400).json({ error: "statement must be income|balance|cashflow and period annual|quarterly" });
      return;
    }
    void send(res, "financials", () =>
      c.financials.get(`${security}|${statement}|${period}`, () =>
        router.first("financials", security, (p) => p.financials!(security, statement, period)),
      ),
    );
  });

  app.get("/api/options/:security", (req, res) => {
    const security = securityParam(req, res);
    if (!security) return;
    const expiration = typeof req.query.expiration === "string" && req.query.expiration ? req.query.expiration : null;
    if (expiration && Number.isNaN(Date.parse(expiration))) {
      res.status(400).json({ error: "expiration must be an ISO date" });
      return;
    }
    void send(res, "options", () =>
      c.options.get(`${security}|${expiration ?? ""}`, () => router.first("options", security, (p) => p.options!(security, expiration))),
    );
  });

  app.get("/api/listings/:security", (req, res) => {
    const security = securityParam(req, res);
    if (!security) return;
    void send(res, "listings", () =>
      c.listings.get(security, async () => {
        const q = await router.quote(security);
        if (!q) return null;
        const key = issuerKey(q.name);
        const results = await router.search(q.name);
        const same = results.filter((r) => issuerKey(r.name) === key);
        return same.some((r) => r.security === security) ? same : [{ security, name: q.name, sector: "Equity", exchange: q.exchange }, ...same];
      }),
    );
  });

  app.get("/api/news/top", (_req, res) => {
    void send(res, "topNews", () =>
      c.news.get("__top__", async () => {
        const lists = await router.all("topNews", null, (p) => p.topNews!());
        return lists.length ? mergeHeadlines(lists) : null;
      }),
    );
  });

  app.get("/api/news", (req, res) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }
    void send(res, "news", () => c.news.get(`q|${q.toLowerCase()}`, () => router.first("news", null, (p) => p.news!(q))));
  });

  app.get("/api/screens/:id", (req, res) => {
    const id = req.params.id as ScreenId;
    if (!(id in SCREENS)) {
      res.status(404).json({ error: "UNKNOWN SCREEN" });
      return;
    }
    void send(res, "screen", () => c.screens.get(id, () => router.first("screen", null, (p) => p.screen!(id))));
  });

  app.get("/api/curve", (_req, res) => {
    void send(res, "yieldCurve", () => c.curve.get("us", () => router.first("yieldCurve", null, (p) => p.yieldCurve!())));
  });

  app.get("/api/curves", async (_req, res) => {
    const [us, others] = await Promise.all([
      c.curve.get("us", () => router.first("yieldCurve", null, (p) => p.yieldCurve!())).catch(() => null),
      router.first("sovereignCurves", null, (p) => p.sovereignCurves!()).catch(() => null),
    ]);
    const curves = [us, ...(others ?? [])].filter((x) => !!x);
    if (curves.length) res.json(curves);
    else res.status(502).json({ error: "CURVE DATA SOURCE UNAVAILABLE" });
  });

  app.get("/api/money-markets", (_req, res) => {
    void send(res, "moneyMarkets", () => c.money.get("us", () => router.first("moneyMarkets", null, (p) => p.moneyMarkets!())));
  });

  app.get("/api/econ/stats", (_req, res) => {
    void send(res, "econStats", () => c.econ.get("wb", () => router.first("econStats", null, (p) => p.econStats!())));
  });

  app.get("/api/econ/calendar", (_req, res) => {
    if (!router.has("econCalendar")) {
      res.status(404).json({ error: "ECONOMIC CALENDAR NEEDS A FRED_API_KEY (FREE AT FRED.STLOUISFED.ORG)" });
      return;
    }
    void send(res, "econCalendar", () => c.calendar.get("cal", () => router.first("econCalendar", null, (p) => p.econCalendar!())));
  });

  app.get("/api/chat/rooms", (req, res) => {
    const user = normalizeUser(req.query.user);
    if (!chat || !user) {
      res.status(400).json({ error: "user is required" });
      return;
    }
    res.json(chat.rooms(user));
  });
}
