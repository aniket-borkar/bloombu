/** Parse clipboard text from Excel/Sheets (TSV) or a CSV file into rows of cells. */
export function parseTable(text: string): string[][] {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!normalized) return [];
  const delimiter = normalized.includes("\t") || !normalized.includes(",") ? "\t" : ",";
  return parseDelimited(normalized, delimiter);
}

/** Delimited text where a cell starting with a quote may contain delimiters, newlines and doubled quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      quoted = true;
      cell = "";
    } else if (ch === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell.trim());
  rows.push(row);
  return rows;
}

const tsvCell = (s: string) => (/[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toTsv(rows: string[][]): string {
  return rows.map((r) => r.map(tsvCell).join("\t")).join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** HTML table for the clipboard, so Excel and Sheets keep columns. */
export function toHtmlTable(rows: string[][]): string {
  return `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;
}

const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]/g, "");

/**
 * If `row` looks like a header, map each field to its column index using
 * `aliases` (field -> accepted header names). Returns null for data rows.
 */
export function mapHeader<F extends string>(row: string[], aliases: Record<F, string[]>): Partial<Record<F, number>> | null {
  const nonEmpty = row.filter((c) => c.trim());
  if (!nonEmpty.length || nonEmpty.some((c) => /^-?[\d,.$%()\s]+$/.test(c))) return null;
  // Earlier aliases win: with both "Name" and "Ticker" columns, Ticker identifies the security.
  const best: Partial<Record<F, { index: number; rank: number }>> = {};
  let matched = 0;
  row.forEach((cell, i) => {
    const c = clean(cell);
    for (const field of Object.keys(aliases) as F[]) {
      const rank = aliases[field].findIndex((a) => clean(a) === c);
      if (rank < 0) continue;
      matched++;
      const current = best[field];
      if (!current || rank < current.rank) best[field] = { index: i, rank };
      break;
    }
  });
  if (!matched || matched * 2 < nonEmpty.length) return null;
  const mapping: Partial<Record<F, number>> = {};
  for (const field of Object.keys(best) as F[]) mapping[field] = best[field]!.index;
  return mapping;
}

/** Parse a number from spreadsheet text: "1,234.5", "$12", "(3.2)", "45%". */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const n = Number(t.replace(/[(),$%\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** Spreadsheet column letters: 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
