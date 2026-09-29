import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import type { PortfolioStore } from "../portfolio/store.js";
import type { ProviderRouter } from "../providers/router.js";
import { normalizeSecurity } from "../symbology.js";
import { SCREENS, type ScreenId } from "../types.js";
import { FIELD_BY_ID, FIELDS, type FieldService, type FieldValue } from "./fields.js";

export class BqlError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
  }
}

type Tok = { t: "kw" | "id" | "num" | "str" | "op" | "punc"; v: string; pos: number };

const KEYWORDS = new Set(["SELECT", "FROM", "WHERE", "ORDER", "BY", "ASC", "DESC", "LIMIT", "AND", "OR", "NOT", "NULL", "IS"]);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === "'" || ch === '"') {
      let s = "";
      i++;
      while (i < src.length && src[i] !== ch) s += src[i++];
      if (i >= src.length) throw new BqlError("Unterminated string", start);
      i++;
      out.push({ t: "str", v: s, pos: start });
    } else if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      while (i < src.length && /[0-9.eE]/.test(src[i])) i++;
      out.push({ t: "num", v: src.slice(start, i), pos: start });
    } else if (/[A-Za-z_]/.test(ch)) {
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) i++;
      const word = src.slice(start, i);
      const up = word.toUpperCase();
      out.push({ t: KEYWORDS.has(up) ? "kw" : "id", v: KEYWORDS.has(up) ? up : word, pos: start });
    } else if (/[<>!=]/.test(ch)) {
      const two = src.slice(i, i + 2);
      if (["<=", ">=", "!=", "<>"].includes(two)) {
        out.push({ t: "op", v: two === "<>" ? "!=" : two, pos: start });
        i += 2;
      } else {
        out.push({ t: "op", v: ch === "!" ? "!" : ch, pos: start });
        i++;
      }
    } else if ("(),*-".includes(ch)) {
      out.push({ t: "punc", v: ch, pos: start });
      i++;
    } else {
      throw new BqlError(`Unexpected character "${ch}"`, start);
    }
  }
  return out;
}

export type Cond =
  | { k: "and" | "or"; a: Cond; b: Cond }
  | { k: "not"; a: Cond }
  | { k: "cmp"; op: string; left: Operand; right: Operand }
  | { k: "isnull"; field: string; negate: boolean };
type Operand = { k: "field"; id: string } | { k: "lit"; v: number | string };

export interface BqlQuery {
  select: string[];
  universe: { fn: string; args: string[] };
  where: Cond | null;
  order: { field: string; desc: boolean }[];
  limit: number;
}

export const MAX_ROWS = 500;

export function parseBql(src: string): BqlQuery {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const at = () => toks[p]?.pos ?? src.length;
  const eat = (t: Tok["t"], v?: string): Tok => {
    const tok = toks[p];
    if (!tok || tok.t !== t || (v !== undefined && tok.v !== v)) throw new BqlError(`Expected ${v ?? t}${tok ? ` but found "${tok.v}"` : " but the query ended"}`, at());
    p++;
    return tok;
  };
  const isKw = (v: string) => peek()?.t === "kw" && peek()!.v === v;
  const field = (): string => {
    const tok = eat("id");
    const id = tok.v.toUpperCase();
    if (id !== "SECURITY" && !FIELD_BY_ID.has(id)) throw new BqlError(`Unknown field ${id} (see FLDS)`, tok.pos);
    return id;
  };

  eat("kw", "SELECT");
  let select: string[] = [];
  if (peek()?.t === "punc" && peek()!.v === "*") {
    p++;
    select = ["NAME", "PX_LAST", "CHG_PCT_1D", "CUR_MKT_CAP", "PE_RATIO"];
  } else {
    select.push(field());
    while (peek()?.t === "punc" && peek()!.v === ",") {
      p++;
      select.push(field());
    }
  }
  eat("kw", "FROM");
  const fnTok = eat("id");
  eat("punc", "(");
  const args: string[] = [];
  if (!(peek()?.t === "punc" && peek()!.v === ")")) {
    args.push(eat("str").v);
    while (peek()?.t === "punc" && peek()!.v === ",") {
      p++;
      args.push(eat("str").v);
    }
  }
  eat("punc", ")");
  const universe = { fn: fnTok.v.toLowerCase(), args };
  if (!UNIVERSES.includes(universe.fn)) throw new BqlError(`Unknown universe ${fnTok.v}(); use ${UNIVERSES.join("(), ")}()`, fnTok.pos);

  const operand = (): Operand => {
    const tok = peek();
    if (!tok) throw new BqlError("Expected a value", at());
    if (tok.t === "num") {
      p++;
      return { k: "lit", v: Number(tok.v) };
    }
    if (tok.t === "punc" && tok.v === "-" && toks[p + 1]?.t === "num") {
      p += 2;
      return { k: "lit", v: -Number(toks[p - 1].v) };
    }
    if (tok.t === "str") {
      p++;
      return { k: "lit", v: tok.v };
    }
    return { k: "field", id: field() };
  };
  const primary = (): Cond => {
    if (isKw("NOT")) {
      p++;
      return { k: "not", a: primary() };
    }
    if (peek()?.t === "punc" && peek()!.v === "(") {
      p++;
      const c = orExpr();
      eat("punc", ")");
      return c;
    }
    const left = operand();
    if (isKw("IS")) {
      p++;
      const negate = isKw("NOT");
      if (negate) p++;
      eat("kw", "NULL");
      if (left.k !== "field") throw new BqlError("IS NULL needs a field", at());
      return { k: "isnull", field: left.id, negate };
    }
    const opTok = eat("op");
    if (!["=", "!=", "<", ">", "<=", ">="].includes(opTok.v)) throw new BqlError(`Unknown operator ${opTok.v}`, opTok.pos);
    return { k: "cmp", op: opTok.v, left, right: operand() };
  };
  const andExpr = (): Cond => {
    let c = primary();
    while (isKw("AND")) {
      p++;
      c = { k: "and", a: c, b: primary() };
    }
    return c;
  };
  const orExpr = (): Cond => {
    let c = andExpr();
    while (isKw("OR")) {
      p++;
      c = { k: "or", a: c, b: andExpr() };
    }
    return c;
  };

  let where: Cond | null = null;
  if (isKw("WHERE")) {
    p++;
    where = orExpr();
  }
  const order: { field: string; desc: boolean }[] = [];
  if (isKw("ORDER")) {
    p++;
    eat("kw", "BY");
    do {
      if (order.length) p++;
      const id = field();
      let desc = false;
      if (isKw("DESC")) {
        desc = true;
        p++;
      } else if (isKw("ASC")) p++;
      order.push({ field: id, desc });
    } while (peek()?.t === "punc" && peek()!.v === ",");
  }
  let limit = 100;
  if (isKw("LIMIT")) {
    p++;
    const tok = eat("num");
    limit = Math.floor(Number(tok.v));
    if (!(limit > 0 && limit <= MAX_ROWS)) throw new BqlError(`LIMIT must be 1-${MAX_ROWS}`, tok.pos);
  }
  if (p < toks.length) throw new BqlError(`Unexpected "${toks[p].v}"`, toks[p].pos);
  return { select, universe, where, order, limit };
}

export const UNIVERSES = ["screen", "portfolio", "list", "members", "wei", "glco", "fx"];

const UNIVERSE_HELP: Record<string, string> = {
  screen: `screen('${Object.keys(SCREENS).join("' | '")}')`,
  portfolio: "portfolio('name') for the user's saved portfolios",
  list: "list('AAPL US Equity', 'MSFT US Equity', ...)",
  members: "members('SPX Index') for SPX, INDU, NDX, UKX, DAX, CAC, SX5E, HSI or AS51",
  wei: "wei() world equity indices",
  glco: "glco() commodity futures",
  fx: "fx() major currency pairs",
};

/** The query language, described for the AI analyst from the universes and the field dictionary. */
export function bqlGuide(): string {
  const fields = FIELDS.map((f) => `${f.id} (${f.description}${f.source === "profile" || f.source === "analysts" ? `; at most ${MAX_PER_SECURITY} securities` : ""})`);
  return [
    "Run a BQL query over securities and fields; returns up to 30 rows and the user can open the full grid in BQL.",
    `Syntax: SELECT field, ... (or *) FROM universe [WHERE condition] [ORDER BY field [ASC|DESC], ...] [LIMIT n] (default 100, max ${MAX_ROWS}).`,
    `Universes: ${UNIVERSES.map((u) => UNIVERSE_HELP[u] ?? `${u}()`).join("; ")}.`,
    "Conditions compare fields and values with = != < > <= >=, combine with AND, OR, NOT and parentheses, and test IS [NOT] NULL; quote strings with single quotes; a comparison with a missing value is false.",
    `Fields: ${fields.join(", ")}.`,
    "Example: SELECT NAME, PE_RATIO, CHG_PCT_1D FROM members('NDX Index') WHERE PE_RATIO < 25 AND CUR_MKT_CAP > 100000000000 ORDER BY PE_RATIO LIMIT 20",
  ].join(" ");
}

/** Universes may be this large when every field comes from batch quote/valuation calls. */
const MAX_UNIVERSE = 600;
/** Fields that need one request per security are limited to this many securities. */
const MAX_PER_SECURITY = 100;

const WEI = ["INDU", "SPX", "CCMP", "NDX", "RTY", "SPTSX", "MEXBOL", "IBOV", "SX5E", "SXXP", "UKX", "DAX", "CAC", "IBEX", "AEX", "SMI", "NKY", "HSI", "SHCOMP", "KOSPI", "TWSE", "AS51", "SENSEX", "NIFTY", "STI"].map((t) => `${t} Index`);
const GLCO = ["CL1", "CO1", "NG1", "HO1", "XB1", "GC1", "SI1", "HG1", "PL1", "PA1", "C 1", "W 1", "S 1", "KC1", "SB1", "CC1", "CT1", "LC1"].map((t) => `${t} Comdty`);
const FX = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD", "NZDUSD", "USDCNY", "USDINR", "USDMXN", "USDBRL"].map((t) => `${t} Curncy`);

function referencedFields(q: BqlQuery): string[] {
  const out = new Set<string>([...q.select, ...q.order.map((o) => o.field)]);
  const walk = (c: Cond | null) => {
    if (!c) return;
    if (c.k === "and" || c.k === "or") {
      walk(c.a);
      walk(c.b);
    } else if (c.k === "not") walk(c.a);
    else if (c.k === "isnull") out.add(c.field);
    else if (c.k === "cmp") for (const o of [c.left, c.right]) if (o.k === "field") out.add(o.id);
  };
  walk(q.where);
  out.delete("SECURITY");
  return [...out];
}

function evalCond(c: Cond, row: Record<string, FieldValue>): boolean {
  switch (c.k) {
    case "and":
      return evalCond(c.a, row) && evalCond(c.b, row);
    case "or":
      return evalCond(c.a, row) || evalCond(c.b, row);
    case "not":
      return !evalCond(c.a, row);
    case "isnull":
      return (row[c.field] === null || row[c.field] === undefined) !== c.negate;
    case "cmp": {
      const val = (o: Operand) => (o.k === "lit" ? o.v : (row[o.id] ?? null));
      const a = val(c.left);
      const b = val(c.right);
      if (a === null || b === null) return false;
      const x = typeof a === "string" && typeof b === "string" ? a.toUpperCase() : a;
      const y = typeof a === "string" && typeof b === "string" ? b.toUpperCase() : b;
      switch (c.op) {
        case "=":
          return x === y;
        case "!=":
          return x !== y;
        case "<":
          return x < y;
        case ">":
          return x > y;
        case "<=":
          return x <= y;
        default:
          return x >= y;
      }
    }
  }
}

export interface BqlResult {
  columns: string[];
  rows: FieldValue[][];
  universeSize: number;
}

export interface BqlDeps {
  router: ProviderRouter;
  fields: FieldService;
  portfolios?: PortfolioStore;
}

export async function runBql(src: string, user: string | null, deps: BqlDeps): Promise<BqlResult> {
  const q = parseBql(src);
  let securities: string[];
  const arg0 = q.universe.args[0];
  switch (q.universe.fn) {
    case "screen": {
      if (!arg0 || !(arg0 in SCREENS)) throw new BqlError(`screen() needs one of: ${Object.keys(SCREENS).join(", ")}`, 0);
      const rows = await deps.router.first("screen", null, (p) => p.screen!(arg0 as ScreenId));
      securities = (rows ?? []).map((r) => r.security);
      break;
    }
    case "portfolio": {
      if (!arg0) throw new BqlError("portfolio() needs a portfolio name", 0);
      const p = user && deps.portfolios ? deps.portfolios.findByName(user, arg0) : null;
      if (!p) throw new BqlError(`No portfolio named "${arg0}" for ${user ?? "this user"}`, 0);
      securities = [...new Set(p.holdings.map((h) => h.security))];
      break;
    }
    case "list": {
      const parsed = q.universe.args.map((a) => normalizeSecurity(a));
      const bad = q.universe.args.find((_, i) => !parsed[i]);
      if (bad !== undefined) throw new BqlError(`"${bad}" is not a security (use e.g. 'AAPL US Equity')`, 0);
      securities = parsed as string[];
      break;
    }
    case "members": {
      const index = arg0 ? normalizeSecurity(arg0) : null;
      if (!index) throw new BqlError("members() needs an index, e.g. members('SPX Index')", 0);
      const m = await deps.router.indexMembers(index);
      if (!m) throw new BqlError(`No member list for ${index} (covered: SPX, INDU, NDX, UKX, DAX, CAC, SX5E, HSI, AS51)`, 0);
      securities = m.members.map((x) => x.security);
      break;
    }
    case "wei":
      securities = WEI;
      break;
    case "glco":
      securities = GLCO;
      break;
    default:
      securities = FX;
  }
  const needed = referencedFields(q);
  const perSecurity = needed.filter((f) => {
    const source = FIELD_BY_ID.get(f)?.source;
    return source === "profile" || source === "analysts";
  });
  if (perSecurity.length && securities.length > MAX_PER_SECURITY) {
    throw new BqlError(
      `${perSecurity.join(", ")} need one request per security, so they are limited to ${MAX_PER_SECURITY} securities; this universe has ${securities.length}. Drop them or use a smaller universe.`,
      0,
    );
  }
  securities = securities.slice(0, MAX_UNIVERSE);
  const table = needed.length ? await deps.fields.get(securities, needed) : {};
  let rows = securities.map((s) => ({ SECURITY: s as FieldValue, ...(table[s] ?? {}) }) as Record<string, FieldValue>);
  if (q.where) rows = rows.filter((r) => evalCond(q.where!, r));
  if (q.order.length) {
    rows.sort((a, b) => {
      for (const { field, desc } of q.order) {
        const x = a[field];
        const y = b[field];
        if (x === y) continue;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : 1) * (desc ? -1 : 1);
      }
      return 0;
    });
  }
  const columns = ["SECURITY", ...q.select.filter((f) => f !== "SECURITY")];
  return { columns, rows: rows.slice(0, q.limit).map((r) => columns.map((c) => r[c] ?? null)), universeSize: securities.length };
}

export function registerBqlRoute(app: express.Express, deps: BqlDeps): void {
  app.post("/api/bql", async (req, res) => {
    const body = (req.body ?? {}) as { query?: unknown; user?: unknown };
    if (typeof body.query !== "string" || !body.query.trim() || body.query.length > 4000) {
      res.status(400).json({ error: "query is required (up to 4000 characters)" });
      return;
    }
    try {
      res.json(await runBql(body.query, normalizeUser(body.user), deps));
    } catch (err) {
      if (err instanceof BqlError) {
        res.status(400).json({ error: err.message, position: err.position });
        return;
      }
      console.error("bql", err);
      res.status(502).json({ error: "DATA SOURCE UNAVAILABLE" });
    }
  });
}
