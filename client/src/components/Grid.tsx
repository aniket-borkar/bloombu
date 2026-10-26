import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { columnName, parseTable, toHtmlTable, toTsv } from "../terminal/table";

export interface GridColumn {
  key: string;
  label: string;
  width?: string;
  align?: "left" | "right" | "center";
  editable?: boolean;
}

export interface CellPos {
  row: number;
  col: number;
}

export interface Selection {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

interface Props {
  columns: GridColumn[];
  /** Raw cell text per row; one entry per column. */
  rows: string[][];
  onChange?: (rows: string[][]) => void;
  /** Display override for a cell (defaults to the raw text). */
  render?: (row: number, col: number, raw: string) => ReactNode;
  /** Text copied for a cell (defaults to the raw text). */
  copyText?: (row: number, col: number, raw: string) => string;
  cellClass?: (row: number, col: number) => string | undefined;
  /** Handle a paste yourself (e.g. a header-mapped import); return true if handled. */
  onPasteText?: (text: string, at: CellPos) => boolean;
  onSelectionChange?: (sel: Selection, active: CellPos) => void;
  /** Enter or double-click on a read-only cell. */
  onActivate?: (pos: CellPos) => void;
  minRows?: number;
  readOnly?: boolean;
  /** Show spreadsheet row numbers and column letters (A, B, C). */
  sheetHeaders?: boolean;
  /** Keep a new result table from scrolling its editor away from the headline. */
  scrollOnMount?: boolean;
  testId?: string;
}

const norm = (a: CellPos, b: CellPos): Selection => ({
  r0: Math.min(a.row, b.row),
  c0: Math.min(a.col, b.col),
  r1: Math.max(a.row, b.row),
  c1: Math.max(a.col, b.col),
});

/**
 * Spreadsheet grid: click/shift-click/arrow selection, type or F2 to edit,
 * Enter/Tab to commit, Delete to clear, and native copy/cut/paste as TSV
 * (plus an HTML table so Excel and Sheets keep columns).
 */
export function Grid({
  columns,
  rows,
  onChange,
  render,
  copyText,
  cellClass,
  onPasteText,
  onSelectionChange,
  onActivate,
  minRows = 1,
  readOnly = false,
  sheetHeaders = false,
  scrollOnMount = true,
  testId = "grid",
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<CellPos>({ row: 0, col: 0 });
  const [anchor, setAnchor] = useState<CellPos>({ row: 0, col: 0 });
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);
  const dragging = useRef(false);
  const selectionMoved = useRef(false);

  const editableCol = (c: number) => !readOnly && !!onChange && columns[c]?.editable !== false;
  const rowCount = Math.max(rows.length + (!readOnly && onChange ? 1 : 0), minRows);
  const raw = (r: number, c: number) => rows[r]?.[c] ?? "";
  const sel = norm(anchor, active);

  useEffect(() => {
    onSelectionChange?.(sel, active);
  }, [sel.r0, sel.c0, sel.r1, sel.c1, active.row, active.col]);

  useEffect(() => {
    if (!scrollOnMount && !selectionMoved.current && active.row === 0 && active.col === 0) return;
    selectionMoved.current = true;
    ref.current?.querySelector(`[data-cell="${active.row}:${active.col}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active.row, active.col, scrollOnMount]);

  const write = useCallback(
    (updates: { row: number; col: number; value: string }[]) => {
      if (!onChange || !updates.length) return;
      const next = rows.map((r) => [...r]);
      for (const { row, col, value } of updates) {
        while (next.length <= row) next.push(columns.map(() => ""));
        next[row] = columns.map((_, i) => next[row][i] ?? "");
        next[row][col] = value;
      }
      while (next.length && next[next.length - 1].every((v) => !v.trim())) next.pop();
      onChange(next);
    },
    [rows, columns, onChange],
  );

  const move = (row: number, col: number, extend = false) => {
    const pos = { row: Math.max(0, Math.min(row, rowCount - 1)), col: Math.max(0, Math.min(col, columns.length - 1)) };
    setActive(pos);
    if (!extend) setAnchor(pos);
  };

  const startEdit = (initial?: string) => {
    if (!editableCol(active.col)) {
      onActivate?.(active);
      return;
    }
    setEditing({ pos: active, value: initial ?? raw(active.row, active.col) });
  };

  const commit = (then?: CellPos) => {
    if (!editing) return;
    const { pos, value } = editing;
    setEditing(null);
    if (value !== raw(pos.row, pos.col)) write([{ ...pos, value }]);
    if (then) move(then.row, then.col);
    ref.current?.focus();
  };

  const clearSelection = () => {
    const updates: { row: number; col: number; value: string }[] = [];
    for (let r = sel.r0; r <= sel.r1; r++) {
      for (let c = sel.c0; c <= sel.c1; c++) if (editableCol(c) && raw(r, c)) updates.push({ row: r, col: c, value: "" });
    }
    write(updates);
  };

  const selectionText = (): string[][] => {
    const out: string[][] = [];
    for (let r = sel.r0; r <= Math.min(sel.r1, rows.length - 1); r++) {
      const line: string[] = [];
      for (let c = sel.c0; c <= sel.c1; c++) line.push(copyText ? copyText(r, c, raw(r, c)) : raw(r, c));
      out.push(line);
    }
    return out;
  };

  const pasteAt = (text: string) => {
    const at = { ...active };
    if (onPasteText?.(text, at)) return;
    if (readOnly || !onChange) return;
    const table = parseTable(text);
    const targetCols: number[] = [];
    for (let c = at.col; c < columns.length && targetCols.length < Math.max(...table.map((r) => r.length), 0); c++) {
      if (editableCol(c)) targetCols.push(c);
    }
    const updates = table.flatMap((line, i) => line.slice(0, targetCols.length).map((value, j) => ({ row: at.row + i, col: targetCols[j], value })));
    write(updates);
    if (table.length) {
      setAnchor(at);
      setActive({ row: at.row + table.length - 1, col: targetCols[Math.min(targetCols.length, table[0].length) - 1] ?? at.col });
    }
  };

  // Clipboard events fire on the document when a non-editable element has focus.
  useEffect(() => {
    const inGrid = () => !!ref.current && ref.current.contains(document.activeElement);
    const editingInput = () => document.activeElement instanceof HTMLInputElement && ref.current?.contains(document.activeElement);
    const onCopy = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      if (editingInput()) {
        const input = document.activeElement as HTMLInputElement;
        if (input.selectionStart !== input.selectionEnd) return;
      }
      const data = selectionText();
      e.clipboardData?.setData("text/plain", toTsv(data));
      e.clipboardData?.setData("text/html", toHtmlTable(data));
      e.preventDefault();
      if (e.type === "cut" && !editingInput()) clearSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!inGrid()) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (editingInput() && !/[\t\n]/.test(text.replace(/\r?\n$/, ""))) return;
      e.preventDefault();
      if (editing) setEditing(null);
      pasteAt(text);
      ref.current?.focus();
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  });

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    if (editing) {
      if (e.key === "Enter") {
        e.preventDefault();
        commit({ row: editing.pos.row + (e.shiftKey ? -1 : 1), col: editing.pos.col });
      } else if (e.key === "Tab") {
        e.preventDefault();
        commit({ row: editing.pos.row, col: editing.pos.col + (e.shiftKey ? -1 : 1) });
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setEditing(null);
        ref.current?.focus();
      }
      return;
    }
    const { row, col } = active;
    const handled = () => e.preventDefault();
    switch (e.key) {
      case "ArrowUp":
        handled();
        return move(row - 1, col, e.shiftKey);
      case "ArrowDown":
        handled();
        return move(row + 1, col, e.shiftKey);
      case "ArrowLeft":
        handled();
        return move(row, col - 1, e.shiftKey);
      case "ArrowRight":
        handled();
        return move(row, col + 1, e.shiftKey);
      case "Tab":
        handled();
        return move(row, col + (e.shiftKey ? -1 : 1));
      case "Home":
        handled();
        return move(mod ? 0 : row, 0, e.shiftKey);
      case "End":
        handled();
        return move(mod ? rows.length - 1 : row, columns.length - 1, e.shiftKey);
      case "Enter":
        handled();
        return startEdit();
      case "F2":
        handled();
        return startEdit();
      case "Delete":
      case "Backspace":
        handled();
        return clearSelection();
    }
    if (mod && e.key.toLowerCase() === "a") {
      handled();
      setAnchor({ row: 0, col: 0 });
      setActive({ row: Math.max(rows.length - 1, 0), col: columns.length - 1 });
      return;
    }
    if (!mod && !e.altKey && e.key.length === 1 && editableCol(col)) {
      e.preventDefault();
      startEdit(e.key);
    }
  };

  const inSel = (r: number, c: number) => r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;

  return (
    <div
      ref={ref}
      className="grid-wrap"
      tabIndex={0}
      data-grid="1"
      data-testid={testId}
      onKeyDown={onKeyDown}
    >
      <table className="grid-table">
        <thead>
          <tr>
            {sheetHeaders && <th className="grid-corner" />}
            {columns.map((c, i) => (
              <th key={c.key} style={{ width: c.width, textAlign: c.align ?? "left" }} className={editableCol(i) ? "" : "computed"}>
                {sheetHeaders ? columnName(i) : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rowCount }, (_, r) => (
            <tr key={r}>
              {sheetHeaders && <td className="grid-rownum">{r + 1}</td>}
              {columns.map((c, ci) => {
                const isActive = active.row === r && active.col === ci;
                const isEditing = editing && editing.pos.row === r && editing.pos.col === ci;
                const value = raw(r, ci);
                return (
                  <td
                    key={c.key}
                    data-cell={`${r}:${ci}`}
                    className={[
                      "grid-cell",
                      inSel(r, ci) ? "selected" : "",
                      isActive ? "active" : "",
                      editableCol(ci) ? "" : "computed",
                      cellClass?.(r, ci) ?? "",
                    ].join(" ")}
                    style={{ textAlign: c.align ?? "left" }}
                    onMouseDown={(e) => {
                      if (isEditing) return;
                      e.preventDefault();
                      if (editing) commit();
                      ref.current?.focus();
                      dragging.current = true;
                      move(r, ci, e.shiftKey);
                    }}
                    onMouseEnter={() => {
                      if (dragging.current) setActive({ row: r, col: ci });
                    }}
                    onDoubleClick={() => {
                      setActive({ row: r, col: ci });
                      setAnchor({ row: r, col: ci });
                      if (editableCol(ci)) setEditing({ pos: { row: r, col: ci }, value });
                      else onActivate?.({ row: r, col: ci });
                    }}
                  >
                    {isEditing ? (
                      <input
                        className="grid-input"
                        autoFocus
                        value={editing!.value}
                        onChange={(e) => setEditing({ pos: editing!.pos, value: e.target.value })}
                        onBlur={() => commit()}
                        data-testid="grid-input"
                      />
                    ) : render ? (
                      render(r, ci, value)
                    ) : (
                      value
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
