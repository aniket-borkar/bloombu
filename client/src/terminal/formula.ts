// Spreadsheet formula engine for SHEET: a small, safe parser and evaluator.

export type Scalar = number | string | boolean | null;

export class FormulaError {
  constructor(
    public code: "#REF!" | "#VALUE!" | "#DIV/0!" | "#NAME?" | "#N/A" | "#CYCLE!" | "#SPILL!" | "#ERROR!",
    public detail = "",
  ) {}
  toString(): string {
    return this.detail ? `${this.code} ${this.detail}` : this.code;
  }
}

export type Cell = Scalar | FormulaError;
export interface ArrayValue {
  array: Cell[][];
}
export type Value = Cell | ArrayValue;

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "ref"; col: number; row: number }
  | { t: "range"; c0: number; r0: number; c1: number; r1: number }
  | { t: "call"; name: string; args: Node[] }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "neg"; a: Node };

export const colIndex = (letters: string) => [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

type Tok = { k: "num" | "str" | "ref" | "id" | "op" | "punc"; v: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      let s = "";
      i++;
      while (i < src.length) {
        if (src[i] === '"' && src[i + 1] === '"') {
          s += '"';
          i += 2;
        } else if (src[i] === '"') break;
        else s += src[i++];
      }
      if (i >= src.length) throw new FormulaError("#ERROR!", "unterminated string");
      i++;
      toks.push({ k: "str", v: s });
    } else if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
      if (!m) throw new FormulaError("#ERROR!", `bad number at ${i}`);
      toks.push({ k: "num", v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(ch)) {
      const m = src.slice(i).match(/^\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/);
      if (m) {
        toks.push({ k: "ref", v: `${m[1].toUpperCase()}${m[2]}` });
        i += m[0].length;
      } else {
        const w = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
        if (!w) throw new FormulaError("#ERROR!", `unexpected "${ch}"`);
        toks.push({ k: "id", v: w[0].toUpperCase() });
        i += w[0].length;
      }
    } else if ("<>=".includes(ch)) {
      const two = src.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") {
        toks.push({ k: "op", v: two });
        i += 2;
      } else {
        toks.push({ k: "op", v: ch });
        i++;
      }
    } else if ("+-*/^&".includes(ch)) {
      toks.push({ k: "op", v: ch });
      i++;
    } else if ("(),:".includes(ch)) {
      toks.push({ k: "punc", v: ch });
      i++;
    } else {
      throw new FormulaError("#ERROR!", `unexpected "${ch}"`);
    }
  }
  return toks;
}

const refPos = (ref: string) => {
  const m = ref.match(/^([A-Z]+)(\d+)$/)!;
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
};

/** Parse a formula body (without the leading "="). Throws FormulaError on syntax errors. */
export function parseFormula(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const expect = (k: Tok["k"], v?: string) => {
    const t = toks[p];
    if (!t || t.k !== k || (v !== undefined && t.v !== v)) throw new FormulaError("#ERROR!", `expected ${v ?? k}`);
    p++;
    return t;
  };

  const primary = (): Node => {
    const t = peek();
    if (!t) throw new FormulaError("#ERROR!", "unexpected end");
    if (t.k === "op" && t.v === "-") {
      p++;
      return { t: "neg", a: power() };
    }
    if (t.k === "op" && t.v === "+") {
      p++;
      return power();
    }
    if (t.k === "num") {
      p++;
      return { t: "num", v: Number(t.v) };
    }
    if (t.k === "str") {
      p++;
      return { t: "str", v: t.v };
    }
    if (t.k === "ref") {
      p++;
      const a = refPos(t.v);
      if (peek()?.k === "punc" && peek()!.v === ":") {
        p++;
        const b = refPos(expect("ref").v);
        return { t: "range", c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row), c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row) };
      }
      return { t: "ref", ...a };
    }
    if (t.k === "id") {
      p++;
      if (t.v === "TRUE" || t.v === "FALSE") return { t: "bool", v: t.v === "TRUE" };
      expect("punc", "(");
      const args: Node[] = [];
      if (!(peek()?.k === "punc" && peek()!.v === ")")) {
        args.push(comparison());
        while (peek()?.k === "punc" && peek()!.v === ",") {
          p++;
          args.push(comparison());
        }
      }
      expect("punc", ")");
      return { t: "call", name: t.v, args };
    }
    if (t.k === "punc" && t.v === "(") {
      p++;
      const e = comparison();
      expect("punc", ")");
      return e;
    }
    throw new FormulaError("#ERROR!", `unexpected "${t.v}"`);
  };
  const power = (): Node => {
    let a = primary();
    while (peek()?.k === "op" && peek()!.v === "^") {
      p++;
      a = { t: "bin", op: "^", a, b: primary() };
    }
    return a;
  };
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let a = next();
    while (peek()?.k === "op" && ops.includes(peek()!.v)) {
      const op = toks[p++].v;
      a = { t: "bin", op, a, b: next() };
    }
    return a;
  };
  const multiplicative = binary(power, ["*", "/"]);
  const additive = binary(multiplicative, ["+", "-"]);
  const concat = binary(additive, ["&"]);
  const comparison = binary(concat, ["=", "<>", "<", ">", "<=", ">="]);

  const node = comparison();
  if (p < toks.length) throw new FormulaError("#ERROR!", `unexpected "${toks[p].v}"`);
  return node;
}

export interface EvalContext {
  cell(col: number, row: number): Cell;
  bdp(security: string, field: string): Cell;
  bdh(security: string, field: string, range: string): ArrayValue | FormulaError;
}

const isErr = (v: unknown): v is FormulaError => v instanceof FormulaError;

function toNumber(v: Cell): number | FormulaError {
  if (isErr(v)) return v;
  if (v === null || v === "") return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : new FormulaError("#VALUE!", `"${v}" is not a number`);
}

function scalar(v: Value): Cell {
  return v !== null && typeof v === "object" && "array" in v ? (v.array[0]?.[0] ?? null) : v;
}

function flatten(values: Value[]): Cell[] {
  return values.flatMap((v) => (v !== null && typeof v === "object" && "array" in v ? v.array.flat() : [v]));
}

function numbers(values: Value[]): number[] | FormulaError {
  const out: number[] = [];
  for (const v of flatten(values)) {
    if (isErr(v)) return v;
    if (typeof v === "number") out.push(v);
  }
  return out;
}

export function evaluate(node: Node, ctx: EvalContext): Value {
  switch (node.t) {
    case "num":
    case "str":
    case "bool":
      return node.v;
    case "ref":
      return ctx.cell(node.col, node.row);
    case "range": {
      const array: Cell[][] = [];
      for (let r = node.r0; r <= node.r1; r++) {
        const row: Cell[] = [];
        for (let c = node.c0; c <= node.c1; c++) row.push(ctx.cell(c, r));
        array.push(row);
      }
      return { array };
    }
    case "neg": {
      const n = toNumber(scalar(evaluate(node.a, ctx)));
      return isErr(n) ? n : -n;
    }
    case "bin": {
      const a = scalar(evaluate(node.a, ctx));
      const b = scalar(evaluate(node.b, ctx));
      if (isErr(a)) return a;
      if (isErr(b)) return b;
      if (node.op === "&") return `${a ?? ""}${b ?? ""}`;
      if (["=", "<>", "<", ">", "<=", ">="].includes(node.op)) {
        const both = typeof a === "string" && typeof b === "string";
        const x = both ? a.toUpperCase() : typeof a === "string" ? a : toNumber(a);
        const y = both ? b.toUpperCase() : typeof b === "string" ? b : toNumber(b);
        if (isErr(x) || isErr(y)) return new FormulaError("#VALUE!");
        switch (node.op) {
          case "=":
            return x === y;
          case "<>":
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
      const x = toNumber(a);
      const y = toNumber(b);
      if (isErr(x)) return x;
      if (isErr(y)) return y;
      switch (node.op) {
        case "+":
          return x + y;
        case "-":
          return x - y;
        case "*":
          return x * y;
        case "/":
          return y === 0 ? new FormulaError("#DIV/0!") : x / y;
        default:
          return Math.pow(x, y);
      }
    }
    case "call":
      return callFunction(node.name, node.args, ctx);
  }
}

function callFunction(name: string, args: Node[], ctx: EvalContext): Value {
  const vals = () => args.map((a) => evaluate(a, ctx));
  const arg = (i: number) => (args[i] ? scalar(evaluate(args[i], ctx)) : null);
  const need = (min: number, max = min) => {
    if (args.length < min || args.length > max) throw new FormulaError("#VALUE!", `${name} takes ${min === max ? min : `${min}-${max}`} arguments`);
  };
  switch (name) {
    case "SUM":
    case "AVERAGE":
    case "MIN":
    case "MAX":
    case "COUNT": {
      const ns = numbers(vals());
      if (isErr(ns)) return ns;
      if (name === "COUNT") return ns.length;
      if (name === "SUM") return ns.reduce((s, x) => s + x, 0);
      if (!ns.length) return name === "AVERAGE" ? new FormulaError("#DIV/0!") : 0;
      if (name === "AVERAGE") return ns.reduce((s, x) => s + x, 0) / ns.length;
      return name === "MIN" ? Math.min(...ns) : Math.max(...ns);
    }
    case "ABS": {
      need(1);
      const n = toNumber(arg(0));
      return isErr(n) ? n : Math.abs(n);
    }
    case "ROUND": {
      need(1, 2);
      const n = toNumber(arg(0));
      const d = toNumber(arg(1));
      if (isErr(n)) return n;
      if (isErr(d)) return d;
      const f = Math.pow(10, Math.trunc(d));
      return Math.round(n * f) / f;
    }
    case "IF": {
      need(2, 3);
      const c = arg(0);
      if (isErr(c)) return c;
      const truthy = typeof c === "string" ? c.length > 0 : !!c;
      return args[truthy ? 1 : 2] ? evaluate(args[truthy ? 1 : 2], ctx) : false;
    }
    case "BDP": {
      need(2);
      const s = arg(0);
      const f = arg(1);
      if (isErr(s)) return s;
      if (isErr(f)) return f;
      return ctx.bdp(String(s ?? ""), String(f ?? "").toUpperCase());
    }
    case "BDH": {
      need(2, 3);
      const s = arg(0);
      const f = arg(1);
      const r = args[2] ? arg(2) : "1y";
      if (isErr(s)) return s;
      if (isErr(f)) return f;
      if (isErr(r)) return r;
      return ctx.bdh(String(s ?? ""), String(f ?? "").toUpperCase(), String(r ?? "1y").toLowerCase());
    }
    default:
      return new FormulaError("#NAME?", `unknown function ${name}`);
  }
}

export interface SheetData {
  /** undefined means "not loaded yet". */
  bdp(security: string, field: string): Cell | undefined;
  bdh(security: string, field: string, range: string): Cell[][] | FormulaError | undefined;
}

export interface SheetResult {
  value(row: number, col: number): Cell;
  /** Rows and columns covered by values, including spills. */
  extent: { rows: number; cols: number };
  requests: { bdp: [string, string][]; bdh: [string, string, string][] };
}

const REQUESTING = new FormulaError("#N/A", "Requesting Data...");

/** Evaluate every cell. BDH results spill down and right from their cell. */
export function computeSheet(raw: string[][], data: SheetData): SheetResult {
  const memo = new Map<string, Cell>();
  const active = new Set<string>();
  const spill = new Map<string, Cell>();
  const reqBdp = new Map<string, [string, string]>();
  const reqBdh = new Map<string, [string, string, string]>();
  const parsed = new Map<string, Node | FormulaError>();
  const key = (r: number, c: number) => `${r}:${c}`;
  const text = (r: number, c: number) => raw[r]?.[c] ?? "";
  let extentRows = raw.length;
  let extentCols = Math.max(0, ...raw.map((r) => r.length));

  const parse = (r: number, c: number): Node | FormulaError => {
    const k = key(r, c);
    if (!parsed.has(k)) {
      try {
        parsed.set(k, parseFormula(text(r, c).slice(1)));
      } catch (e) {
        parsed.set(k, e instanceof FormulaError ? e : new FormulaError("#ERROR!", String(e)));
      }
    }
    return parsed.get(k)!;
  };

  const ctx: EvalContext = {
    cell: (c, r) => (r < 0 || c < 0 ? new FormulaError("#REF!") : get(r, c)),
    bdp: (s, f) => {
      const v = data.bdp(s, f);
      if (v === undefined) {
        reqBdp.set(`${s}|${f}`, [s, f]);
        return REQUESTING;
      }
      return v;
    },
    bdh: (s, f, rng) => {
      const v = data.bdh(s, f, rng);
      if (v === undefined) {
        reqBdh.set(`${s}|${f}|${rng}`, [s, f, rng]);
        return REQUESTING;
      }
      return isErr(v) ? v : { array: v };
    },
  };

  function evalCell(r: number, c: number): Value {
    const node = parse(r, c);
    if (isErr(node)) return node;
    try {
      return evaluate(node, ctx);
    } catch (e) {
      return e instanceof FormulaError ? e : new FormulaError("#ERROR!", String(e));
    }
  }

  function get(r: number, c: number): Cell {
    const k = key(r, c);
    if (memo.has(k)) return memo.get(k)!;
    if (active.has(k)) return new FormulaError("#CYCLE!");
    const t = text(r, c);
    if (!t.startsWith("=")) {
      if (spill.has(k)) return spill.get(k)!;
      const trimmed = t.trim();
      const n = trimmed ? Number(trimmed.replace(/,/g, "")) : NaN;
      const v: Cell = !trimmed ? null : Number.isFinite(n) && /^[-+]?[\d,.]+([eE][-+]?\d+)?$/.test(trimmed) ? n : t;
      memo.set(k, v);
      return v;
    }
    active.add(k);
    const v = scalar(evalCell(r, c));
    active.delete(k);
    memo.set(k, v);
    return v;
  }

  // Array formulas (BDH) first, so their spill ranges are known to other cells.
  for (let r = 0; r < raw.length; r++) {
    for (let c = 0; c < (raw[r]?.length ?? 0); c++) {
      if (!text(r, c).startsWith("=")) continue;
      const node = parse(r, c);
      if (isErr(node) || node.t !== "call" || node.name !== "BDH") continue;
      const k = key(r, c);
      active.add(k);
      const v = evalCell(r, c);
      active.delete(k);
      if (v === null || typeof v !== "object" || !("array" in v)) {
        memo.set(k, scalar(v));
        continue;
      }
      const blocked = v.array.some((row, i) =>
        row.some((_, j) => (i || j) && (text(r + i, c + j).trim() !== "" || spill.has(key(r + i, c + j)))),
      );
      if (blocked) {
        memo.set(k, new FormulaError("#SPILL!", "cells below are not empty"));
        continue;
      }
      v.array.forEach((row, i) =>
        row.forEach((cell, j) => {
          if (i || j) spill.set(key(r + i, c + j), cell);
        }),
      );
      memo.set(k, v.array[0]?.[0] ?? null);
      extentRows = Math.max(extentRows, r + v.array.length);
      extentCols = Math.max(extentCols, c + Math.max(...v.array.map((x) => x.length)));
    }
  }

  const values = new Map<string, Cell>();
  for (let r = 0; r < extentRows; r++) {
    for (let c = 0; c < extentCols; c++) values.set(key(r, c), get(r, c));
  }

  return {
    value: (r, c) => values.get(key(r, c)) ?? null,
    extent: { rows: extentRows, cols: extentCols },
    requests: { bdp: [...reqBdp.values()], bdh: [...reqBdh.values()] },
  };
}

/** Display text for a computed cell. */
export function formatCell(v: Cell): string {
  if (v === null) return "";
  if (v instanceof FormulaError) return v.toString();
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "#NUM!";
    if (Number.isInteger(v)) return v.toLocaleString("en-US");
    const d = Math.abs(v) < 1 ? 4 : 2;
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  return v;
}
