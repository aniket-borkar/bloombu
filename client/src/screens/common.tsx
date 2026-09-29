import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { usePanels, type PanelState } from "../store/panels";
import { direction, fmtNum, fmtPct, fmtSigned } from "../terminal/format";

export interface ScreenProps {
  panel: PanelState;
  security: string | null;
  fn: string;
}

const LINE = 18;

/** Register `count` numbered options for the panel and return the selected index. */
export function useOptions(panel: PanelState, count: number, defaultIndex = 0): number {
  const setOptionCount = usePanels((s) => s.setOptionCount);
  useEffect(() => {
    setOptionCount(panel.id, count);
  }, [panel.id, count, setOptionCount]);
  const index = panel.option ?? defaultIndex;
  return count ? Math.min(Math.max(index, 0), count - 1) : 0;
}

/** Numbered option hotspots: type `<n> <GO>` or click. */
export function OptionBar({
  panel,
  labels,
  selected,
  extra,
  testId = "option-bar",
}: {
  panel: PanelState;
  labels: string[];
  selected: number;
  extra?: ReactNode;
  testId?: string;
}) {
  const { execute } = usePanels.getState();
  return (
    <div className="chart-options" data-testid={testId}>
      {labels.map((label, i) => (
        <button
          key={`${i}-${label}`}
          className={`chart-opt${i === selected ? " active" : ""}`}
          data-testid={`opt-${i + 1}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => execute(panel.id, { kind: "menuItem", index: i + 1 })}
        >
          <span className="chart-opt-num">{i + 1})</span> {label}
        </button>
      ))}
      {extra && <span className="gray chart-interval">{extra}</span>}
    </div>
  );
}

interface LoadState {
  data: unknown;
  error: Error | null;
  loading: boolean;
}

/** Loading, not-found and error messages for a data request; renders nothing once data has arrived. */
export function DataState({ state, what }: { state: LoadState; what: string }) {
  if (state.data) return null;
  if (state.loading) return <div className="gray" data-testid="screen-loading">LOADING {what}...</div>;
  const e = state.error;
  const message =
    e instanceof ApiError && e.status === 404
      ? e.message && e.message !== "NO DATA AVAILABLE"
        ? e.message
        : `NO ${what} AVAILABLE FOR THIS SECURITY`
      : `${what} DATA SOURCE UNAVAILABLE`;
  return (
    <div className="error-box" data-testid="screen-error">
      {message}
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children?: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">
        <span>{title}</span>
        {right && <span className="gray">{right}</span>}
      </div>
      {children}
    </div>
  );
}

/** Label/value pairs laid out in columns. */
export function KeyValues({ items, columns = 2 }: { items: [string, ReactNode][]; columns?: number }) {
  return (
    <div className="kv" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {items.map(([k, v]) => (
        <div key={k} className="kv-item">
          <span className="label">{k}</span>
          <span className="white">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function Change({ value, decimals = 2, pct = false }: { value: number | null | undefined; decimals?: number; pct?: boolean }) {
  const v = value ?? null;
  return <span className={direction(v)}>{fmtSigned(v, decimals, pct ? "%" : "")}</span>;
}

export const pctText = (v: number | null | undefined) => fmtPct(v);
export const num = (v: number | null | undefined, d = 2) => fmtNum(v ?? null, d);

export interface Column<T> {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
  width?: string;
  render: (row: T, index: number) => ReactNode;
}

/**
 * Terminal table. When `paged`, rows are split into pages that fit the panel
 * height, navigated with <PAGE FWD>/<PAGE BACK>.
 */
export function DataTable<T>({
  panel,
  columns,
  rows,
  onRowClick,
  rowClass,
  paged = true,
  maxRows,
  initialIndex,
  testId = "data-table",
}: {
  panel?: PanelState;
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T, index: number) => void;
  rowClass?: (row: T, index: number) => string;
  paged?: boolean;
  maxRows?: number;
  initialIndex?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [perPage, setPerPage] = useState(20);
  const setPageCount = usePanels((s) => s.setPageCount);
  const usePaging = paged && !!panel;

  useLayoutEffect(() => {
    if (!usePaging || !ref.current) return;
    const el = ref.current;
    const measure = () => setPerPage(Math.max(1, Math.floor(el.clientHeight / LINE) - 1));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [usePaging]);

  const pageCount = usePaging ? Math.max(1, Math.ceil(rows.length / perPage)) : 1;
  useEffect(() => {
    if (usePaging) setPageCount(panel!.id, pageCount);
  }, [usePaging, panel?.id, pageCount, setPageCount]);

  const jumped = useRef(false);
  useEffect(() => {
    if (!usePaging || jumped.current || initialIndex === undefined || !rows.length) return;
    jumped.current = true;
    usePanels.getState().setPage(panel!.id, Math.floor(initialIndex / perPage));
  }, [usePaging, initialIndex, rows.length, perPage, panel]);

  const start = usePaging ? Math.min(panel!.page, pageCount - 1) * perPage : 0;
  const visible = usePaging ? rows.slice(start, start + perPage) : rows.slice(0, maxRows ?? rows.length);

  return (
    <div ref={ref} className={usePaging ? "table-wrap paged" : "table-wrap"} data-testid={testId}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align ?? "left", width: c.width }}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((row, i) => (
            <tr
              key={start + i}
              className={`${onRowClick ? "clickable " : ""}${rowClass?.(row, start + i) ?? ""}`}
              onClick={onRowClick ? () => onRowClick(row, start + i) : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} style={{ textAlign: c.align ?? "left" }}>
                  {c.render(row, start + i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Load a security (optionally with a function) in this panel. */
export function loadInPanel(panelId: number, security: string, fn: string | null = null): void {
  usePanels.getState().execute(panelId, { kind: "load", security, fn });
}

/** Open a link in a new tab (links come from data providers). */
export function openLink(url: string | null): void {
  if (url) window.open(url, "_blank", "noopener,noreferrer");
}
