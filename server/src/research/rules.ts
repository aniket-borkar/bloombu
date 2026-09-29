// Trading-rule expressions evaluated over daily bars, shared by the backtester
// (BTST and the AI analyst's tools) and rule alerts (ALRT). Pure: no I/O.

export interface RuleBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export class RuleError extends Error {
  constructor(
    message: string,
    public position: number,
  ) {
    super(message);
  }
}

type Node =
  | { t: "num"; v: number; pos: number }
  | { t: "series"; name: "open" | "high" | "low" | "close" | "volume"; pos: number }
  | { t: "call"; name: string; args: Node[]; pos: number }
  | { t: "bin"; op: string; a: Node; b: Node; pos: number }
  | { t: "not"; a: Node; pos: number }
  | { t: "neg"; a: Node; pos: number };

const SERIES = new Set(["open", "high", "low", "close", "volume"]);

/** name -> [min args, max args, index of a required lookback argument or -1]. */
const FUNCS: Record<string, [number, number, number]> = {
  sma: [2, 2, 1],
  ema: [2, 2, 1],
  rsi: [1, 2, 1],
  highest: [2, 2, 1],
  lowest: [2, 2, 1],
  change: [1, 2, 1],
  prev: [1, 2, 1],
  crossabove: [2, 2, -1],
  crossbelow: [2, 2, -1],
  abs: [1, 1, -1],
  max: [2, 2, -1],
  min: [2, 2, -1],
};

export const RULE_FUNCTIONS = ["sma(x, n)", "ema(x, n)", "rsi(x, n=14)", "highest(x, n)", "lowest(x, n)", "change(x, n=1) %", "prev(x, n=1)", "crossAbove(a, b)", "crossBelow(a, b)", "abs(x)", "max(a, b)", "min(a, b)"];

const MAX_LOOKBACK = 500;

type Tok = { k: "num" | "id" | "op" | "punc"; v: string; pos: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const pos = i;
    if (/[0-9.]/.test(ch)) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)/);
      if (!m) throw new RuleError(`Bad number`, pos);
      out.push({ k: "num", v: m[0], pos });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/)!;
      out.push({ k: "id", v: m[0].toLowerCase(), pos });
      i += m[0].length;
    } else if (/[<>=!]/.test(ch)) {
      const two = src.slice(i, i + 2);
      if (["<=", ">=", "==", "!="].includes(two)) {
        out.push({ k: "op", v: two, pos });
        i += 2;
      } else if (ch === "<" || ch === ">") {
        out.push({ k: "op", v: ch, pos });
        i++;
      } else if (ch === "=") {
        out.push({ k: "op", v: "==", pos });
        i++;
      } else {
        throw new RuleError(`Unexpected "${ch}"`, pos);
      }
    } else if ("+-*/".includes(ch)) {
      out.push({ k: "op", v: ch, pos });
      i++;
    } else if ("(),".includes(ch)) {
      out.push({ k: "punc", v: ch, pos });
      i++;
    } else {
      throw new RuleError(`Unexpected "${ch}"`, pos);
    }
  }
  return out;
}

export function parseRule(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const endPos = () => toks[p]?.pos ?? src.length;
  const expect = (k: Tok["k"], v: string) => {
    const t = toks[p];
    if (!t || t.k !== k || t.v !== v) throw new RuleError(`Expected "${v}"${t ? ` but found "${t.v}"` : ""}`, endPos());
    p++;
  };
  const isWord = (w: string) => peek()?.k === "id" && peek()!.v === w;

  const primary = (): Node => {
    const t = peek();
    if (!t) throw new RuleError("Rule ended unexpectedly", src.length);
    if (t.k === "op" && t.v === "-") {
      p++;
      return { t: "neg", a: primary(), pos: t.pos };
    }
    if (t.k === "num") {
      p++;
      return { t: "num", v: Number(t.v), pos: t.pos };
    }
    if (t.k === "punc" && t.v === "(") {
      p++;
      const e = orExpr();
      expect("punc", ")");
      return e;
    }
    if (t.k === "id") {
      p++;
      if (SERIES.has(t.v)) return { t: "series", name: t.v as "close", pos: t.pos };
      const spec = FUNCS[t.v];
      if (!spec) throw new RuleError(`Unknown name "${t.v}". Use close, open, high, low, volume or ${Object.keys(FUNCS).join(", ")}`, t.pos);
      expect("punc", "(");
      const args: Node[] = [];
      if (!(peek()?.k === "punc" && peek()!.v === ")")) {
        args.push(orExpr());
        while (peek()?.k === "punc" && peek()!.v === ",") {
          p++;
          args.push(orExpr());
        }
      }
      expect("punc", ")");
      const [min, max, lookback] = spec;
      if (args.length < min || args.length > max) throw new RuleError(`${t.v} takes ${min === max ? min : `${min}-${max}`} arguments`, t.pos);
      if (lookback >= 0 && args[lookback]) {
        const n = args[lookback];
        if (n.t !== "num" || !Number.isInteger(n.v) || n.v < 1 || n.v > MAX_LOOKBACK) {
          throw new RuleError(`${t.v}: lookback must be a whole number from 1 to ${MAX_LOOKBACK}`, n.pos);
        }
      }
      return { t: "call", name: t.v, args, pos: t.pos };
    }
    throw new RuleError(`Unexpected "${t.v}"`, t.pos);
  };
  const binary = (next: () => Node, ops: string[]) => (): Node => {
    let a = next();
    while (peek()?.k === "op" && ops.includes(peek()!.v)) {
      const tok = toks[p++];
      a = { t: "bin", op: tok.v, a, b: next(), pos: tok.pos };
    }
    return a;
  };
  const mul = binary(primary, ["*", "/"]);
  const add = binary(mul, ["+", "-"]);
  const cmp = binary(add, ["<", ">", "<=", ">=", "==", "!="]);
  const notExpr = (): Node => {
    if (isWord("not")) {
      const pos = toks[p++].pos;
      return { t: "not", a: notExpr(), pos };
    }
    return cmp();
  };
  const andExpr = (): Node => {
    let a = notExpr();
    while (isWord("and")) {
      const pos = toks[p++].pos;
      a = { t: "bin", op: "and", a, b: notExpr(), pos };
    }
    return a;
  };
  const orExpr = (): Node => {
    let a = andExpr();
    while (isWord("or")) {
      const pos = toks[p++].pos;
      a = { t: "bin", op: "or", a, b: andExpr(), pos };
    }
    return a;
  };

  if (!toks.length) throw new RuleError("Rule is empty", 0);
  const node = orExpr();
  if (p < toks.length) throw new RuleError(`Unexpected "${toks[p].v}"`, toks[p].pos);
  return node;
}

type Series = number[];

function rolling(x: Series, n: number, f: (window: number[]) => number): Series {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    const w = x.slice(i - n + 1, i + 1);
    return w.some((v) => Number.isNaN(v)) ? NaN : f(w);
  });
}

function ema(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seedCount = 0;
  let seedSum = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (Number.isNaN(v)) {
      prev = NaN;
      seedCount = 0;
      seedSum = 0;
      continue;
    }
    if (Number.isNaN(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount === n) {
        prev = seedSum / n;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
function rsi(x: Series, n: number): Series {
  const out: Series = new Array(x.length).fill(NaN);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < x.length; i++) {
    const d = x[i] - x[i - 1];
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);
    if (i <= n) {
      avgGain += gain / n;
      avgLoss += loss / n;
      if (i === n) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (n - 1) + gain) / n;
      avgLoss = (avgLoss * (n - 1) + loss) / n;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

const shift = (x: Series, n: number): Series => x.map((_, i) => (i - n >= 0 ? x[i - n] : NaN));
const zip = (a: Series, b: Series, f: (x: number, y: number) => number): Series =>
  a.map((x, i) => (Number.isNaN(x) || Number.isNaN(b[i]) ? NaN : f(x, b[i])));
const bool = (v: boolean) => (v ? 1 : 0);

function evalNode(node: Node, bars: RuleBar[]): Series {
  switch (node.t) {
    case "num":
      return bars.map(() => node.v);
    case "series": {
      const key = { open: "o", high: "h", low: "l", close: "c", volume: "v" }[node.name] as keyof RuleBar;
      return bars.map((b) => {
        const v = b[key];
        return typeof v === "number" ? v : NaN;
      });
    }
    case "neg":
      return evalNode(node.a, bars).map((v) => -v);
    case "not":
      return evalNode(node.a, bars).map((v) => (Number.isNaN(v) ? NaN : bool(v === 0)));
    case "bin": {
      const a = evalNode(node.a, bars);
      const b = evalNode(node.b, bars);
      switch (node.op) {
        case "+":
          return zip(a, b, (x, y) => x + y);
        case "-":
          return zip(a, b, (x, y) => x - y);
        case "*":
          return zip(a, b, (x, y) => x * y);
        case "/":
          return zip(a, b, (x, y) => (y === 0 ? NaN : x / y));
        case "<":
          return zip(a, b, (x, y) => bool(x < y));
        case ">":
          return zip(a, b, (x, y) => bool(x > y));
        case "<=":
          return zip(a, b, (x, y) => bool(x <= y));
        case ">=":
          return zip(a, b, (x, y) => bool(x >= y));
        case "==":
          return zip(a, b, (x, y) => bool(x === y));
        case "!=":
          return zip(a, b, (x, y) => bool(x !== y));
        case "and":
          return zip(a, b, (x, y) => bool(x !== 0 && y !== 0));
        default:
          return zip(a, b, (x, y) => bool(x !== 0 || y !== 0));
      }
    }
    case "call": {
      const arg = (i: number) => evalNode(node.args[i], bars);
      const lookback = (i: number, fallback: number) => (node.args[i] ? (node.args[i] as { v: number }).v : fallback);
      switch (node.name) {
        case "sma":
          return rolling(arg(0), lookback(1, 1), (w) => w.reduce((s, v) => s + v, 0) / w.length);
        case "ema":
          return ema(arg(0), lookback(1, 1));
        case "rsi":
          return rsi(arg(0), lookback(1, 14));
        case "highest":
          return rolling(arg(0), lookback(1, 1), (w) => Math.max(...w));
        case "lowest":
          return rolling(arg(0), lookback(1, 1), (w) => Math.min(...w));
        case "change": {
          const x = arg(0);
          const prev = shift(x, lookback(1, 1));
          return zip(x, prev, (a, b) => (b === 0 ? NaN : (a / b - 1) * 100));
        }
        case "prev":
          return shift(arg(0), lookback(1, 1));
        case "crossabove":
        case "crossbelow": {
          const a = arg(0);
          const b = arg(1);
          const above = node.name === "crossabove";
          return a.map((_, i) => {
            if (i === 0 || [a[i], b[i], a[i - 1], b[i - 1]].some(Number.isNaN)) return NaN;
            return bool(above ? a[i] > b[i] && a[i - 1] <= b[i - 1] : a[i] < b[i] && a[i - 1] >= b[i - 1]);
          });
        }
        case "abs":
          return arg(0).map(Math.abs);
        case "max":
          return zip(arg(0), arg(1), Math.max);
        default:
          return zip(arg(0), arg(1), Math.min);
      }
    }
  }
}

/** Value of the rule on each bar (NaN where lookbacks are not yet filled). */
export function evaluateRule(src: string, bars: RuleBar[]): number[] {
  return evalNode(parseRule(src), bars);
}

/** Whether the rule is true on each bar (false where undefined). */
export function ruleSignal(src: string, bars: RuleBar[]): boolean[] {
  return evaluateRule(src, bars).map((v) => !Number.isNaN(v) && v !== 0);
}
