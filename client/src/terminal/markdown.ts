export type Block =
  | { type: "line"; text: string; bullet: boolean }
  | { type: "table"; header: string[] | null; rows: string[][] };

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));
const cellsOf = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Split model output into plain lines, "- " bullets (headings lose their #) and | pipe | tables. */
export function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTableRow(lines[i])) {
      const rows: string[][] = [];
      for (; i < lines.length && isTableRow(lines[i]); i++) rows.push(cellsOf(lines[i]));
      i--;
      const header = rows.length > 1 && isDivider(rows[1]) ? rows[0] : null;
      blocks.push({ type: "table", header, rows: header ? rows.slice(2) : rows.filter((r) => !isDivider(r)) });
      continue;
    }
    const bullet = /^\s*[-*]\s+/.test(lines[i]);
    blocks.push({ type: "line", bullet, text: lines[i].replace(/^\s*[-*]\s+/, "").replace(/^#{1,4}\s+/, "") });
  }
  return blocks;
}

/** Numbers, percentages, currency amounts and multiples, right-aligned in tables. */
export const isNumericCell = (cell: string) => /^[-+]?[$€£¥]?[\d,]*\.?\d+(%|x|bp|[kKmMbBT])?$/.test(cell.replace(/\*/g, ""));
