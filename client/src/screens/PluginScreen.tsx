import { useMemo } from "react";
import type { Block, Cell, SeriesBlock, TableBlock, TableColumn } from "../../../server/src/plugins/spec";
import { safeUrl } from "../../../server/src/plugins/spec";
import { ApiError, api, useData } from "../api";
import { CompareChart, type CompareSeries } from "../components/CompareChart";
import { fmtIsoDate, fmtNum, fmtPct } from "../terminal/format";
import { PLUGIN_FUNCTIONS } from "../terminal/pluginFunctions";
import type { PanelState } from "../store/panels";
import { DataTable, KeyValues, OptionBar, Section, loadInPanel, openLink, useOptions, type Column, type ScreenProps } from "./common";

const SERIES_COLORS = ["#ffa028", "#4d9bff", "#3ec43e", "#ff4d4d", "#c080ff", "#e0e0e0", "#00c8c8", "#ffd84d"];

export function formatCell(v: Cell, col?: TableColumn): string {
  if (v === null || v === "") return "--";
  switch (col?.format) {
    case "number":
      return typeof v === "number" ? fmtNum(v, col.decimals ?? 2) : v;
    case "pct":
      return typeof v === "number" ? fmtPct(v, col.decimals ?? 2) : v;
    case "date":
      return fmtIsoDate(typeof v === "number" ? new Date(v).toISOString() : v);
    default:
      return typeof v === "number" ? fmtNum(v, col?.decimals ?? (Number.isInteger(v) ? 0 : 2)) : v;
  }
}

function TableView({ block, panel, paged }: { block: TableBlock; panel: PanelState; paged: boolean }) {
  const columns: Column<Record<string, Cell>>[] = block.columns.map((c) => ({
    key: c.key,
    label: c.label,
    align: c.align ?? (c.format === "number" || c.format === "pct" ? "right" : "left"),
    render: (row) => formatCell(row[c.key], c),
  }));
  const { linkKey, securityKey } = block;
  const onRowClick =
    securityKey || linkKey
      ? (row: Record<string, Cell>) => {
          const security = securityKey ? row[securityKey] : null;
          if (typeof security === "string" && security) loadInPanel(panel.id, security);
          else if (linkKey) openLink(safeUrl(row[linkKey]));
        }
      : undefined;
  return (
    <>
      {block.title && <Section title={block.title} />}
      <DataTable panel={paged ? panel : undefined} paged={paged} columns={columns} rows={block.rows} onRowClick={onRowClick} testId="plugin-table" />
    </>
  );
}

function SeriesView({ block }: { block: SeriesBlock }) {
  const series = useMemo<CompareSeries[]>(
    () => block.series.map((s, i) => ({ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length], points: s.points })),
    [block],
  );
  return (
    <>
      {block.title && <Section title={block.title} />}
      <div className="chart-area">
        <CompareChart series={series} unit={block.unit === "pct" ? "pct" : "number"} testId="plugin-series" />
      </div>
    </>
  );
}

function BlockView({ block, panel, paged }: { block: Block; panel: PanelState; paged: boolean }) {
  switch (block.type) {
    case "text":
      return (
        <>
          {block.title && <Section title={block.title} />}
          <p className="prose">{block.text}</p>
        </>
      );
    case "kv":
      return (
        <>
          {block.title && <Section title={block.title} />}
          <KeyValues items={block.items.map(([k, v]): [string, string] => [k, formatCell(v)])} />
        </>
      );
    case "table":
      return <TableView block={block} panel={panel} paged={paged} />;
    case "series":
      return <SeriesView block={block} />;
  }
}

/** Renders the screen a plugin function returns (text, key/values, tables, charts) with the terminal's own components. */
export function PluginScreen({ panel, security, fn }: ScreenProps) {
  const info = PLUGIN_FUNCTIONS.get(fn);
  const labels = info?.options ?? [];
  const selected = useOptions(panel, labels.length);
  const state = useData(`plugin|${fn}|${security ?? ""}|${selected}`, (signal) => api.runPlugin(fn, security, selected, signal));
  const spec = state.data;
  const pagedIndex = useMemo(() => {
    if (!spec) return -1;
    let best = -1;
    spec.blocks.forEach((b, i) => {
      if (b.type === "table" && (best < 0 || b.rows.length > (spec.blocks[best] as TableBlock).rows.length)) best = i;
    });
    return best;
  }, [spec]);

  return (
    <div className="col-flex" data-testid="plugin-screen">
      {labels.length > 0 && <OptionBar panel={panel} labels={labels} selected={selected} extra={info && `plugin: ${info.plugin}`} />}
      {!spec &&
        (state.loading ? (
          <div className="gray" data-testid="screen-loading">
            LOADING {fn}...
          </div>
        ) : (
          <div className="error-box" data-testid="screen-error">
            {state.error instanceof ApiError ? state.error.message : `${fn} IS UNAVAILABLE`}
          </div>
        ))}
      {spec?.title && <div className="menu-title">{spec.title}</div>}
      {spec?.blocks.map((b, i) => <BlockView key={`${selected}-${i}`} block={b} panel={panel} paged={i === pagedIndex} />)}
    </div>
  );
}
