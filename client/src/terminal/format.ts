import type { Sector } from "./sectors";

/** Price precision by market convention. */
export function decimalsFor(sector: Sector | null, value: number | null): number {
  if (value === null) return 2;
  const v = Math.abs(value);
  if (sector === "Curncy") return v < 10 ? 5 : v < 1000 ? 3 : 2;
  if (sector === "Govt") return 3;
  if (v < 1) return 4;
  return 2;
}

export function fmtNum(value: number | null, decimals = 2): string {
  if (value === null) return "--";
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtSigned(value: number | null, decimals = 2, suffix = ""): string {
  if (value === null) return "--";
  const s = fmtNum(Math.abs(value), decimals);
  return `${value > 0 ? "+" : value < 0 ? "-" : ""}${s}${suffix}`;
}

export function fmtInt(value: number | null): string {
  if (value === null) return "--";
  return Math.round(value).toLocaleString("en-US");
}

/** Compact magnitude: 3.83T, 412.5B, 12.3M, 45.6K. */
export function fmtBig(value: number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  const a = Math.abs(value);
  const [div, unit] = a >= 1e12 ? [1e12, "T"] : a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return `${fmtNum(value / div, unit ? decimals : 2)}${unit}`;
}

/** A value already in percent units, e.g. 1.234 -> "1.23%". */
export function fmtPct(value: number | null | undefined, decimals = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "--" : `${fmtNum(value, decimals)}%`;
}

/** Calendar date of an ISO timestamp or date, as MM/DD/YY in UTC (providers stamp dates at UTC midnight). */
export function fmtIsoDate(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "--";
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear() % 100)}`;
}

/** Local date and time of an ISO timestamp, as MM/DD HH:MM. */
export function fmtIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return "--";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function direction(value: number | null): "up" | "down" | "" {
  if (value === null || value === 0) return "";
  return value > 0 ? "up" : "down";
}

const pad = (n: number) => String(n).padStart(2, "0");

/** MM/DD/YY, the terminal's date format. */
export function fmtDate(d: Date): string {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${pad(d.getFullYear() % 100)}`;
}

export function fmtClock(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Bar timestamp label. Intraday bars use local time; daily and weekly bars use the
 * UTC calendar date, since providers stamp them at or after 00:00 UTC of the session day.
 */
export function fmtBarTime(t: number, intraday: boolean): string {
  const d = new Date(t);
  if (intraday) return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCFullYear() % 100)}`;
}

/** Trade time: HH:MM if today, otherwise MM/DD/YY. */
export function fmtTradeTime(iso: string | null, now = new Date()): string {
  if (!iso) return "--";
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : fmtDate(d);
}
