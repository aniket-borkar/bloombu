/**
 * Screens returned by plugin functions. The terminal renders these blocks with
 * its own components, so plugins never ship UI code. Shared with the client.
 */

export type Cell = string | number | null;

export interface TextBlock {
  type: "text";
  title?: string;
  text: string;
}

export interface KvBlock {
  type: "kv";
  title?: string;
  items: [string, Cell][];
}

export const COLUMN_FORMATS = ["text", "number", "pct", "date"] as const;
export type ColumnFormat = (typeof COLUMN_FORMATS)[number];

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  format?: ColumnFormat;
  decimals?: number;
}

export interface TableBlock {
  type: "table";
  title?: string;
  columns: TableColumn[];
  rows: Record<string, Cell>[];
  /** Row key holding an http(s) URL opened when the row is clicked. */
  linkKey?: string;
  /** Row key holding a security loaded in the panel when the row is clicked. */
  securityKey?: string;
}

export interface SeriesBlock {
  type: "series";
  title?: string;
  unit?: "number" | "pct";
  series: { label: string; points: { t: number; v: number | null }[] }[];
}

export type Block = TextBlock | KvBlock | TableBlock | SeriesBlock;

export interface ScreenSpec {
  title?: string;
  blocks: Block[];
}

/** What GET /api/plugins reports for each plugin function. */
export interface PluginFunctionInfo {
  code: string;
  name: string;
  security: boolean;
  sectors: string[] | null;
  options: string[];
  plugin: string;
}

export const LIMITS = { blocks: 20, rows: 5000, columns: 30, kvItems: 200, series: 8, points: 20000, text: 20000, cell: 2000 };

export class SpecError extends Error {}

/** The URL if it is http(s), else null (keeps javascript: and data: links out of the terminal). */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function text(v: unknown, what: string, max = 200): string {
  if (typeof v !== "string" || !v.trim()) throw new SpecError(`${what} must be a non-empty string`);
  return v.slice(0, max);
}

const optText = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

function cell(v: unknown, what: string): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.slice(0, LIMITS.cell);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  throw new SpecError(`${what} must be a string, number, boolean, date or null`);
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new SpecError(`${what} must be an array`);
  return v;
}

function record(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SpecError(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function sanitizeTable(b: Record<string, unknown>, where: string, title: string | undefined): TableBlock {
  const rawColumns = list(b.columns, `${where} columns`);
  if (!rawColumns.length) throw new SpecError(`${where} needs at least one column`);
  const columns = rawColumns.slice(0, LIMITS.columns).map((c, j): TableColumn => {
    const col = record(c, `${where} column ${j + 1}`);
    const key = text(col.key, `${where} column ${j + 1} key`, 60);
    const decimals = col.decimals;
    return {
      key,
      label: optText(col.label, 60) ?? key,
      align: col.align === "right" || col.align === "left" ? col.align : undefined,
      format: (COLUMN_FORMATS as readonly unknown[]).includes(col.format) ? (col.format as ColumnFormat) : undefined,
      decimals: typeof decimals === "number" && Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : undefined,
    };
  });
  const linkKey = optText(b.linkKey, 60);
  const securityKey = optText(b.securityKey, 60);
  const keys = new Set([...columns.map((c) => c.key), ...(linkKey ? [linkKey] : []), ...(securityKey ? [securityKey] : [])]);
  const rows = list(b.rows, `${where} rows`)
    .slice(0, LIMITS.rows)
    .map((r, j) => {
      const row = record(r, `${where} row ${j + 1}`);
      const out: Record<string, Cell> = {};
      for (const k of keys) out[k] = cell(row[k], `${where} row ${j + 1} "${k}"`);
      if (linkKey) out[linkKey] = safeUrl(out[linkKey]);
      return out;
    });
  return { type: "table", title, columns, rows, linkKey, securityKey };
}

function sanitizeSeries(b: Record<string, unknown>, where: string, title: string | undefined): SeriesBlock {
  const raw = list(b.series, `${where} series`);
  if (!raw.length) throw new SpecError(`${where} needs at least one series`);
  return {
    type: "series",
    title,
    unit: b.unit === "pct" ? "pct" : "number",
    series: raw.slice(0, LIMITS.series).map((s, j) => {
      const se = record(s, `${where} series ${j + 1}`);
      return {
        label: text(se.label, `${where} series ${j + 1} label`, 60),
        points: list(se.points, `${where} series ${j + 1} points`)
          .slice(0, LIMITS.points)
          .map((p, k) => {
            const pt = record(p, `${where} series ${j + 1} point ${k + 1}`);
            const t = typeof pt.t === "number" ? pt.t : typeof pt.t === "string" ? Date.parse(pt.t) : Number.NaN;
            if (!Number.isFinite(t)) throw new SpecError(`${where} series ${j + 1} point ${k + 1} needs a time t (epoch ms or ISO date)`);
            return { t, v: typeof pt.v === "number" && Number.isFinite(pt.v) ? pt.v : null };
          }),
      };
    }),
  };
}

function sanitizeBlock(raw: unknown, i: number): Block {
  const where = `block ${i + 1}`;
  const b = record(raw, where);
  const title = optText(b.title);
  switch (b.type) {
    case "text":
      return { type: "text", title, text: text(b.text, `${where} text`, LIMITS.text) };
    case "kv":
      return {
        type: "kv",
        title,
        items: list(b.items, `${where} items`)
          .slice(0, LIMITS.kvItems)
          .map((it, j) => {
            if (!Array.isArray(it) || it.length !== 2) throw new SpecError(`${where} item ${j + 1} must be a [label, value] pair`);
            return [text(it[0], `${where} item ${j + 1} label`, 80), cell(it[1], `${where} item ${j + 1} value`)];
          }),
      };
    case "table":
      return sanitizeTable(b, where, title);
    case "series":
      return sanitizeSeries(b, where, title);
    default:
      throw new SpecError(`${where} has unknown type "${String(b.type)}" (use text, kv, table or series)`);
  }
}

/** Validate a plugin's screen and copy only known, bounded, safe fields. */
export function sanitizeSpec(raw: unknown): ScreenSpec {
  const spec = record(raw, "the screen");
  const blocks = list(spec.blocks, "the screen's blocks");
  if (blocks.length > LIMITS.blocks) throw new SpecError(`a screen can have at most ${LIMITS.blocks} blocks`);
  return { title: optText(spec.title), blocks: blocks.map(sanitizeBlock) };
}
