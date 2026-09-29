import type express from "express";
import { TtlCache } from "../providers/cache.js";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity } from "../symbology.js";
import type { Analysts, Profile, Quote, Valuation } from "../types.js";

export type FieldSource = "quote" | "valuation" | "profile" | "analysts";
export type FieldValue = number | string | null;

interface SourceData {
  quote?: Quote;
  valuation?: Valuation;
  profile?: Profile;
  analysts?: Analysts;
}

export interface FieldDef {
  id: string;
  description: string;
  category: string;
  source: FieldSource;
  type: "number" | "string" | "date";
  get: (d: SourceData) => FieldValue;
}

const f = (id: string, description: string, category: string, source: FieldSource, type: FieldDef["type"], get: FieldDef["get"]): FieldDef => ({
  id,
  description,
  category,
  source,
  type,
  get,
});

/** Bloomberg-style field mnemonics mapped onto data the providers already supply. */
export const FIELDS: FieldDef[] = [
  f("NAME", "Security name", "Descriptive", "quote", "string", (d) => d.quote?.name ?? null),
  f("CRNCY", "Quote currency", "Descriptive", "quote", "string", (d) => d.quote?.currency ?? null),
  f("EXCHANGE", "Exchange", "Descriptive", "quote", "string", (d) => d.quote?.exchange ?? null),
  f("PX_LAST", "Last price", "Pricing", "quote", "number", (d) => d.quote?.last ?? null),
  f("PX_OPEN", "Open price", "Pricing", "quote", "number", (d) => d.quote?.open ?? null),
  f("PX_HIGH", "Day high", "Pricing", "quote", "number", (d) => d.quote?.high ?? null),
  f("PX_LOW", "Day low", "Pricing", "quote", "number", (d) => d.quote?.low ?? null),
  f("PX_CLOSE_1D", "Previous close", "Pricing", "quote", "number", (d) => d.quote?.prevClose ?? null),
  f("CHG_NET_1D", "Net change today", "Pricing", "quote", "number", (d) => d.quote?.change ?? null),
  f("CHG_PCT_1D", "Percent change today", "Pricing", "quote", "number", (d) => d.quote?.changePct ?? null),
  f("PX_BID", "Bid price", "Pricing", "quote", "number", (d) => d.quote?.bid ?? null),
  f("PX_ASK", "Ask price", "Pricing", "quote", "number", (d) => d.quote?.ask ?? null),
  f("BID_SIZE", "Bid size", "Pricing", "quote", "number", (d) => d.quote?.bidSize ?? null),
  f("ASK_SIZE", "Ask size", "Pricing", "quote", "number", (d) => d.quote?.askSize ?? null),
  f("PX_VOLUME", "Volume today", "Pricing", "quote", "number", (d) => d.quote?.volume ?? null),
  f("LAST_UPDATE", "Time of last price", "Pricing", "quote", "date", (d) => d.quote?.time ?? null),
  f("CUR_MKT_CAP", "Market capitalization", "Valuation", "valuation", "number", (d) => d.valuation?.marketCap ?? null),
  f("PE_RATIO", "Price/earnings (trailing 12M)", "Valuation", "valuation", "number", (d) => d.valuation?.pe ?? null),
  f("BEST_PE_RATIO", "Price/earnings (forward)", "Valuation", "valuation", "number", (d) => d.valuation?.forwardPe ?? null),
  f("PX_TO_BOOK_RATIO", "Price/book", "Valuation", "valuation", "number", (d) => d.valuation?.priceToBook ?? null),
  f("TRAIL_12M_EPS", "EPS (trailing 12M)", "Valuation", "valuation", "number", (d) => d.valuation?.eps ?? null),
  f("EQY_DVD_YLD_IND", "Dividend yield (indicated, %)", "Valuation", "valuation", "number", (d) => d.valuation?.dividendYieldPct ?? null),
  f("ENTERPRISE_VALUE", "Enterprise value", "Fundamentals", "profile", "number", (d) => d.profile?.enterpriseValue ?? null),
  f("EQY_SH_OUT", "Shares outstanding", "Fundamentals", "profile", "number", (d) => d.profile?.sharesOutstanding ?? null),
  f("EQY_FLOAT", "Float shares", "Fundamentals", "profile", "number", (d) => d.profile?.floatShares ?? null),
  f("EQY_BETA", "Beta (provider)", "Fundamentals", "profile", "number", (d) => d.profile?.beta ?? null),
  f("EQY_DPS", "Dividend per share (annual)", "Fundamentals", "profile", "number", (d) => d.profile?.dividendRate ?? null),
  f("DVD_EX_DT", "Last ex-dividend date", "Fundamentals", "profile", "date", (d) => d.profile?.exDividendDate ?? null),
  f("HIGH_52WEEK", "52-week high", "Fundamentals", "profile", "number", (d) => d.profile?.high52 ?? null),
  f("LOW_52WEEK", "52-week low", "Fundamentals", "profile", "number", (d) => d.profile?.low52 ?? null),
  f("VOLUME_AVG_3M", "Average daily volume", "Fundamentals", "profile", "number", (d) => d.profile?.avgVolume ?? null),
  f("SHORT_FLOAT_PCT", "Short interest (% of float)", "Fundamentals", "profile", "number", (d) => d.profile?.shortFloatPct ?? null),
  f("GICS_SECTOR_NAME", "Sector", "Descriptive", "profile", "string", (d) => d.profile?.sector ?? null),
  f("GICS_INDUSTRY_NAME", "Industry", "Descriptive", "profile", "string", (d) => d.profile?.industry ?? null),
  f("EXPECTED_REPORT_DT", "Next earnings date", "Fundamentals", "profile", "date", (d) => d.profile?.nextEarnings ?? null),
  f("BEST_TARGET_PRICE", "Analyst mean target price", "Analysts", "analysts", "number", (d) => d.analysts?.targetMean ?? null),
  f("BEST_TARGET_HIGH", "Analyst high target", "Analysts", "analysts", "number", (d) => d.analysts?.targetHigh ?? null),
  f("BEST_TARGET_LOW", "Analyst low target", "Analysts", "analysts", "number", (d) => d.analysts?.targetLow ?? null),
  f("TOT_ANALYST_REC", "Number of analyst recommendations", "Analysts", "analysts", "number", (d) => d.analysts?.analystCount ?? null),
  f("EQY_REC_CONS", "Consensus rating (1 strong buy - 5 strong sell)", "Analysts", "analysts", "number", (d) => d.analysts?.recommendationMean ?? null),
];

export const FIELD_BY_ID = new Map(FIELDS.map((d) => [d.id, d]));

export function unknownFields(ids: string[]): string[] {
  return ids.filter((id) => !FIELD_BY_ID.has(id));
}

export type FieldTable = Record<string, Record<string, FieldValue>>;

export const MAX_FIELD_SECURITIES = 100;
export const MAX_FIELDS = 40;

/** Batch field lookup with per-source caching. */
export class FieldService {
  private quotes = new TtlCache<Quote[]>(15_000);
  private valuations = new TtlCache<Valuation[]>(60_000);
  private profiles = new TtlCache<Profile | null>(3_600_000);
  private analysts = new TtlCache<Analysts | null>(3_600_000);

  constructor(private router: ProviderRouter) {}

  async get(securities: string[], fieldIds: string[]): Promise<FieldTable> {
    const secs = [...new Set(securities.map((s) => normalizeSecurity(s)).filter((s): s is string => !!s))];
    const defs = fieldIds.map((id) => FIELD_BY_ID.get(id)).filter((d): d is FieldDef => !!d);
    const need = new Set(defs.map((d) => d.source));
    const key = secs.join("|");
    const [quotes, valuations, profiles, analysts] = await Promise.all([
      need.has("quote") && secs.length ? this.quotes.get(key, () => this.router.quotes(secs)).catch((): Quote[] => []) : Promise.resolve([] as Quote[]),
      need.has("valuation") && secs.length
        ? this.valuations.get(key, () => this.router.valuations(secs)).catch((): Valuation[] => [])
        : Promise.resolve([] as Valuation[]),
      need.has("profile") ? Promise.all(secs.map((s) => this.profile(s))) : Promise.resolve([] as (Profile | null)[]),
      need.has("analysts") ? Promise.all(secs.map((s) => this.analyst(s))) : Promise.resolve([] as (Analysts | null)[]),
    ]);
    const table: FieldTable = {};
    secs.forEach((s, i) => {
      const data: SourceData = {
        quote: quotes.find((q) => q.security === s),
        valuation: valuations.find((v) => v.security === s),
        profile: profiles[i] ?? undefined,
        analysts: analysts[i] ?? undefined,
      };
      table[s] = Object.fromEntries(defs.map((d) => [d.id, d.get(data)]));
    });
    return table;
  }

  private profile(s: string): Promise<Profile | null> {
    return this.profiles.get(s, () => this.router.first("profile", s, (p) => p.profile!(s))).catch(() => null);
  }

  private analyst(s: string): Promise<Analysts | null> {
    return this.analysts.get(s, () => this.router.first("analysts", s, (p) => p.analysts!(s))).catch(() => null);
  }
}

export function registerFieldRoutes(app: express.Express, service: FieldService): void {
  app.get("/api/fields/list", (_req, res) => {
    res.json(FIELDS.map(({ id, description, category, type, source }) => ({ id, description, category, type, source })));
  });

  app.get("/api/fields", async (req, res) => {
    const securities = String(req.query.s ?? "").split(",").filter((s) => s.trim());
    const fields = String(req.query.f ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    if (!securities.length || securities.length > MAX_FIELD_SECURITIES || !fields.length || fields.length > MAX_FIELDS) {
      res.status(400).json({ error: `s must list 1-${MAX_FIELD_SECURITIES} securities and f 1-${MAX_FIELDS} fields` });
      return;
    }
    const unknown = unknownFields(fields);
    if (unknown.length) {
      res.status(400).json({ error: `Unknown field(s): ${unknown.join(", ")}. See FLDS for the list.` });
      return;
    }
    try {
      res.json(await service.get(securities, fields));
    } catch (err) {
      console.error("fields", err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });
}
