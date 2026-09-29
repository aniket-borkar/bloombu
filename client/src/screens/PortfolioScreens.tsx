import { useEffect, useMemo, useState } from "react";
import {
  ApiError,
  api,
  useData,
  useLiveQuotes,
  type PortfolioAnalytics,
  type PortfolioInput,
  type PortfolioKind,
  type Quote,
  type Resolution,
} from "../api";
import { CompareChart } from "../components/CompareChart";
import { Grid, type GridColumn, type Selection } from "../components/Grid";
import { usePanels } from "../store/panels";
import { parseCommand } from "../terminal/commandParser";
import { decimalsFor, fmtIsoDate, fmtNum, fmtPct } from "../terminal/format";
import { EDIT_FIELDS, holdingsFromRows, mapPastedTable, rowsFromHoldings } from "../terminal/portfolioGrid";
import { lastPortfolio, rememberPortfolio, takePendingDraft } from "../terminal/portfolioState";
import { sectorOf } from "../terminal/sectors";
import { parseTable } from "../terminal/table";
import { DataState, KeyValues, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

/**
 * Resolve free-form identifiers typed or pasted into a grid (debounced, cached
 * per text). `ensure` resolves anything still pending right away, for actions
 * like Save that must not race the debounce.
 */
function useResolutions(texts: string[]): { map: Map<string, Resolution>; ensure: () => Promise<Map<string, Resolution>> } {
  const [map, setMap] = useState(() => new Map<string, Resolution>());
  const key = texts.map((t) => t.trim()).join("\n");
  const missingFrom = (m: Map<string, Resolution>) => [...new Set(key.split("\n").filter((t) => t && !m.has(t)))];
  const merge = (prev: Map<string, Resolution>, res: Resolution[]) => {
    const next = new Map(prev);
    res.forEach((r) => next.set(r.input.trim(), r));
    return next;
  };

  useEffect(() => {
    const missing = missingFrom(map);
    if (!missing.length) return;
    const timer = setTimeout(() => {
      api
        .resolve(missing)
        .then((res) => setMap((prev) => merge(prev, res)))
        .catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [key]);

  const ensure = async () => {
    const missing = missingFrom(map);
    if (!missing.length) return map;
    const next = merge(map, await api.resolve(missing));
    setMap(next);
    return next;
  };

  return { map, ensure };
}

function useQuoteMap(securities: string[]): Map<string, Quote> {
  const unique = [...new Set(securities)].sort();
  const state = useData(unique.length ? `quotes|${unique.join(",")}` : null, (s) => api.quotes(unique, s), 60_000);
  const live = useLiveQuotes(state.data);
  return useMemo(() => new Map((live ?? []).map((q) => [q.security, q])), [live]);
}

const plain = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "" : v.toFixed(d));
const money = (v: number | null | undefined) => fmtNum(v ?? null, 0);

interface Editor {
  id: number | null;
  name: string;
  kind: PortfolioKind;
  baseCurrency: string;
  notional: string;
  rows: string[][];
  dirty: boolean;
}

const blankEditor = (kind: PortfolioKind = "positions"): Editor => ({
  id: null,
  name: kind === "model" ? "New Model" : "New Portfolio",
  kind,
  baseCurrency: "USD",
  notional: "1000000",
  rows: [],
  dirty: false,
});

const POSITION_COLUMNS: GridColumn[] = [
  { key: "security", label: "Security / Ticker", width: "20ch" },
  { key: "quantity", label: "Shares", align: "right", width: "12ch" },
  { key: "cost", label: "Cost/Share", align: "right", width: "11ch" },
  { key: "acquired", label: "Acquired", width: "11ch" },
  { key: "id", label: "Identified As", editable: false },
  { key: "name", label: "Name", editable: false },
  { key: "last", label: "Last", align: "right", editable: false },
  { key: "ccy", label: "Ccy", editable: false },
  { key: "mv", label: "Mkt Value (local)", align: "right", editable: false },
  { key: "pnl", label: "Unreal P&L (local)", align: "right", editable: false },
];

const MODEL_COLUMNS: GridColumn[] = [
  { key: "security", label: "Security / Ticker", width: "20ch" },
  { key: "weight", label: "Weight %", align: "right", width: "10ch" },
  { key: "id", label: "Identified As", editable: false },
  { key: "name", label: "Name", editable: false },
  { key: "last", label: "Last", align: "right", editable: false },
  { key: "ccy", label: "Ccy", editable: false },
  { key: "target", label: "Target Value (base)", align: "right", editable: false },
];

/** PRTU: create and edit portfolios in a spreadsheet grid with Excel copy and paste. */
export function PrtuScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [version, setVersion] = useState(0);
  const list = useData(`portfolios|${user}|${version}`, (s) => api.portfolios(user, s));
  const [editor, setEditor] = useState<Editor>(() => {
    const draft = takePendingDraft();
    if (!draft) return blankEditor();
    return {
      id: null,
      name: draft.name,
      kind: draft.kind,
      baseCurrency: draft.baseCurrency,
      notional: String(draft.notional ?? 1_000_000),
      rows: rowsFromHoldings(draft.holdings, draft.kind),
      dirty: true,
    };
  });
  const [messages, setMessages] = useState<{ kind: "error" | "info"; text: string }[]>([]);
  const [armed, setArmed] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>({ r0: 0, c0: 0, r1: 0, c1: 0 });
  const portfolios = list.data ?? [];
  useOptions(panel, portfolios.length);

  const load = async (id: number) => {
    try {
      const p = await api.portfolio(user, id);
      setEditor({
        id: p.id,
        name: p.name,
        kind: p.kind,
        baseCurrency: p.baseCurrency,
        notional: String(p.notional ?? 1_000_000),
        rows: rowsFromHoldings(p.holdings, p.kind),
        dirty: false,
      });
      rememberPortfolio(user, p.id);
      setMessages([]);
      setArmed(null);
    } catch (err) {
      setMessages([{ kind: "error", text: (err as Error).message }]);
    }
  };

  useEffect(() => {
    if (editor.id !== null || editor.dirty) return;
    const last = lastPortfolio(user);
    if (last && portfolios.some((p) => p.id === last)) void load(last);
  }, [portfolios.length]);

  useEffect(() => {
    if (panel.option === null) return;
    const p = portfolios[panel.option];
    usePanels.getState().setOption(panel.id, null);
    if (p) void guarded(`open-${p.id}`, () => load(p.id));
  }, [panel.option]);

  /** Destructive actions on a dirty editor need a second click. */
  const guarded = async (token: string, action: () => unknown) => {
    if (editor.dirty && armed !== token) {
      setArmed(token);
      setMessages([{ kind: "info", text: "Unsaved changes. Repeat the action to discard them." }]);
      return;
    }
    setArmed(null);
    await action();
  };

  const fields = EDIT_FIELDS[editor.kind];
  const columns = editor.kind === "positions" ? POSITION_COLUMNS : MODEL_COLUMNS;
  const secCol = fields.indexOf("security");
  const { map: resolutions, ensure } = useResolutions(editor.rows.map((r) => r[secCol] ?? ""));
  const resolvedList = editor.rows.map((r) => resolutions.get((r[secCol] ?? "").trim())?.security ?? null);
  const quotes = useQuoteMap(resolvedList.filter((s): s is string => !!s));

  const weightSum = editor.kind === "model" ? editor.rows.reduce((s, r) => s + (Number(r[1]?.replace(/[%,]/g, "")) || 0), 0) : 0;
  const notional = Number(editor.notional.replace(/,/g, "")) || 0;

  const gridRows = editor.rows.map((r, i) => {
    const editable = fields.map((_, j) => r[j] ?? "");
    const res = resolutions.get((r[secCol] ?? "").trim());
    const sec = resolvedList[i];
    const q = sec ? quotes.get(sec) : undefined;
    const d = decimalsFor(sectorOf(sec), q?.last ?? null);
    const idText = !r[secCol]?.trim() ? "" : !res ? "..." : res.security ?? "NOT FOUND";
    const common = [idText, res?.name ?? q?.name ?? "", q?.last != null ? fmtNum(q.last, d) : "", q?.currency ?? ""];
    if (editor.kind === "positions") {
      const qty = Number((r[1] ?? "").replace(/[,$\s]/g, ""));
      const cost = Number((r[2] ?? "").replace(/[,$\s]/g, ""));
      const mv = q?.last != null && Number.isFinite(qty) ? qty * q.last : null;
      const pnl = mv !== null && r[2]?.trim() && Number.isFinite(cost) ? mv - qty * cost : null;
      return [...editable, ...common, mv !== null ? money(mv) : "", pnl !== null ? money(pnl) : ""];
    }
    const w = Number((r[1] ?? "").replace(/[%,\s]/g, ""));
    const target = weightSum > 0 && Number.isFinite(w) ? (notional * w) / weightSum : null;
    return [...editable, ...common, target !== null ? money(target) : ""];
  });

  const onChange = (rows: string[][]) => {
    setEditor((e) => ({ ...e, rows: rows.map((r) => fields.map((_, j) => r[j] ?? "")), dirty: true }));
  };

  const onPasteText = (text: string, at: { row: number; col: number }) => {
    const table = parseTable(text);
    const mapped = mapPastedTable(table, editor.kind);
    if (!mapped) return false;
    const hasData = editor.rows.some((r) => r.some((c) => c.trim()));
    let kind = editor.kind;
    if (mapped.suggestedKind && mapped.suggestedKind !== editor.kind) {
      if (hasData) {
        setMessages([
          {
            kind: "error",
            text: `The pasted table has ${mapped.suggestedKind === "model" ? "weights" : "share quantities"}; this is a ${editor.kind} portfolio. Start a new ${mapped.suggestedKind} portfolio to paste it.`,
          },
        ]);
        return true;
      }
      kind = mapped.suggestedKind;
    }
    const startRow = hasData ? at.row : 0;
    setEditor((e) => {
      const rows = kind === e.kind ? e.rows.map((r) => [...r]) : [];
      mapped.rows.forEach((r, i) => {
        rows[startRow + i] = r;
      });
      return { ...e, kind, rows: rows.map((r) => r ?? EDIT_FIELDS[kind].map(() => "")), dirty: true };
    });
    setMessages([{ kind: "info", text: `Pasted ${mapped.rows.length} rows using the header row${kind !== editor.kind ? ` (switched to a ${kind} portfolio)` : ""}.` }]);
    return true;
  };

  const buildInput = (resolved: Map<string, Resolution>): PortfolioInput | null => {
    const { holdings, errors } = holdingsFromRows(editor.rows, editor.kind, resolved);
    if (!editor.name.trim()) errors.unshift("Name is required");
    if (!holdings.length && !errors.length) errors.push("Add at least one holding");
    if (errors.length) {
      setMessages(errors.slice(0, 8).map((text) => ({ kind: "error", text })));
      return null;
    }
    return {
      name: editor.name.trim(),
      kind: editor.kind,
      baseCurrency: editor.baseCurrency.trim().toUpperCase() || "USD",
      notional: editor.kind === "model" ? notional : null,
      holdings,
    };
  };

  const save = async (asCopy = false) => {
    let resolved: Map<string, Resolution>;
    try {
      resolved = await ensure();
    } catch {
      setMessages([{ kind: "error", text: "Could not identify securities (data source unavailable)" }]);
      return;
    }
    const input = buildInput(resolved);
    if (!input) return;
    try {
      const p =
        editor.id && !asCopy
          ? await api.updatePortfolio(user, editor.id, input)
          : await api.createPortfolio(user, asCopy ? { ...input, name: `${input.name} copy` } : input);
      setEditor((e) => ({ ...e, id: p.id, name: p.name, rows: rowsFromHoldings(p.holdings, p.kind), dirty: false }));
      rememberPortfolio(user, p.id);
      setVersion((v) => v + 1);
      setMessages([{ kind: "info", text: `Saved "${p.name}" with ${p.holdings.length} holdings.` }]);
    } catch (err) {
      setMessages([{ kind: "error", text: err instanceof ApiError ? err.message : "Save failed" }]);
    }
  };

  const remove = async () => {
    if (!editor.id) return;
    if (armed !== "delete") {
      setArmed("delete");
      setMessages([{ kind: "info", text: `Click Delete again to permanently delete "${editor.name}".` }]);
      return;
    }
    await api.deletePortfolio(user, editor.id);
    setEditor(blankEditor());
    setArmed(null);
    setVersion((v) => v + 1);
    setMessages([{ kind: "info", text: "Portfolio deleted." }]);
  };

  const deleteRows = () => {
    setEditor((e) => ({ ...e, rows: e.rows.filter((_, i) => i < selection.r0 || i > selection.r1), dirty: true }));
  };

  const unresolved = editor.rows
    .map((r, i) => ({ row: i, text: (r[secCol] ?? "").trim(), res: resolutions.get((r[secCol] ?? "").trim()) }))
    .filter((x) => x.text && x.res && !x.res.security);

  return (
    <div className="col-flex" data-testid="prtu-screen">
      <div className="toolbar">
        <span className="label">Portfolios:</span>
        {portfolios.map((p, i) => (
          <button
            key={p.id}
            className={`chart-opt${p.id === editor.id ? " active" : ""}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void guarded(`open-${p.id}`, () => load(p.id))}
          >
            <span className="chart-opt-num">{i + 1})</span> {p.name}
          </button>
        ))}
        {!portfolios.length && <span className="gray">none yet</span>}
      </div>
      <div className="toolbar">
        <button className="tool-button" onClick={() => void guarded("new-positions", () => setEditor(blankEditor("positions")))}>
          New Positions
        </button>
        <button className="tool-button" onClick={() => void guarded("new-model", () => setEditor(blankEditor("model")))}>
          New Model
        </button>
        <label className="label">
          Name{" "}
          <input className="form-input" value={editor.name} data-testid="prtu-name" onChange={(e) => setEditor({ ...editor, name: e.target.value, dirty: true })} />
        </label>
        <label className="label">
          Base{" "}
          <input className="form-input" style={{ width: "5ch" }} value={editor.baseCurrency} maxLength={3} onChange={(e) => setEditor({ ...editor, baseCurrency: e.target.value.toUpperCase(), dirty: true })} />
        </label>
        {editor.kind === "model" && (
          <label className="label">
            Notional{" "}
            <input className="form-input" style={{ width: "12ch" }} value={editor.notional} data-testid="prtu-notional" onChange={(e) => setEditor({ ...editor, notional: e.target.value, dirty: true })} />
          </label>
        )}
        <span className="gray">
          {editor.kind === "positions" ? "Positions (shares)" : `Model (weights sum ${fmtNum(weightSum, 2)}%)`}
          {editor.dirty ? " · unsaved" : ""}
        </span>
      </div>
      <div className="toolbar">
        <button className="tool-button primary" data-testid="prtu-save" onClick={() => void save()}>
          Save
        </button>
        <button className="tool-button" onClick={() => void save(true)} disabled={!editor.rows.length}>
          Save Copy
        </button>
        <button className="tool-button" onClick={deleteRows} disabled={!editor.rows.length}>
          Delete Rows {selection.r0 + 1}-{selection.r1 + 1}
        </button>
        <button className="tool-button danger" onClick={() => void remove()} disabled={!editor.id}>
          Delete
        </button>
        <button
          className="tool-button"
          disabled={!editor.id}
          onClick={() => {
            if (editor.id) rememberPortfolio(user, editor.id);
            usePanels.getState().execute(panel.id, { kind: "function", fn: "PORT" });
          }}
        >
          Analyze in PORT
        </button>
        <span className="gray">Paste from Excel/Sheets with Ctrl/Cmd+V (a header row like Ticker, Shares, Cost is mapped automatically).</span>
      </div>
      {messages.map((m, i) => (
        <div key={i} className={m.kind === "error" ? "cmdline-message" : "gray note-line"} data-testid={m.kind === "error" ? "prtu-error" : "prtu-info"}>
          {m.text}
        </div>
      ))}
      {list.error && !list.data && <DataState state={list} what="PORTFOLIOS" />}
      <Grid
        columns={columns}
        rows={gridRows}
        onChange={onChange}
        onPasteText={onPasteText}
        onSelectionChange={(s) => setSelection(s)}
        minRows={12}
        testId="prtu-grid"
        cellClass={(r, c) => {
          if (c !== secCol) return undefined;
          const res = resolutions.get((editor.rows[r]?.[secCol] ?? "").trim());
          if (!res) return undefined;
          return res.status === "unresolved" ? "invalid" : res.status === "search" ? "resolved-search" : undefined;
        }}
      />
      {unresolved.length > 0 && (
        <div className="note-line" data-testid="prtu-suggestions">
          {unresolved.slice(0, 4).map((u) => (
            <span key={u.row} className="inline-quote">
              <span className="down">Row {u.row + 1} "{u.text}"</span>
              {u.res!.candidates.length ? " did you mean " : " no match"}
              {u.res!.candidates.slice(0, 3).map((c) => (
                <button
                  key={c.security}
                  className="link-button"
                  onClick={() =>
                    setEditor((e) => ({
                      ...e,
                      rows: e.rows.map((r, i) => (i === u.row ? r.map((v, j) => (j === secCol ? c.security : v)) : r)),
                      dirty: true,
                    }))
                  }
                >
                  {c.security}
                </button>
              ))}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- PORT

const TABS = ["Holdings", "Performance", "Risk", "Exposures", "Attribution", "What-If"];
const RANGES = ["3mo", "6mo", "1y", "2y", "5y"];

function copyable(display: string[][], copy: string[][]) {
  return { display, copy: (r: number, c: number) => copy[r]?.[c] ?? display[r]?.[c] ?? "" };
}

function HoldingsTab({ a, panelId }: { a: PortfolioAnalytics; panelId: number }) {
  const quotes = useQuoteMap(a.holdings.filter((h) => !h.error).map((h) => h.security));
  const rows = a.holdings.map((h) => {
    const q = quotes.get(h.security);
    const last = q?.last ?? h.last;
    const unit = h.priceScale * (h.fxToBase ?? NaN);
    const mv = h.quantity !== null && last !== null ? h.quantity * last * unit : h.marketValue;
    const day = h.quantity !== null && last !== null && q?.prevClose != null ? h.quantity * (last - q.prevClose) * unit : h.dayPnl;
    const pnl = h.costValue !== null && mv !== null && Number.isFinite(mv) ? mv - h.costValue : h.unrealizedPnl;
    return { h, last, mv: Number.isFinite(mv ?? NaN) ? mv : null, day: Number.isFinite(day ?? NaN) ? day : null, pnl };
  });
  const total = rows.reduce((s, r) => s + (r.mv ?? 0), 0);
  const totalDay = rows.reduce((s, r) => s + (r.day ?? 0), 0);
  const totalPnl = rows.some((r) => r.pnl !== null) ? rows.reduce((s, r) => s + (r.pnl ?? 0), 0) : null;
  const ccy = a.baseCurrency;
  const columns: GridColumn[] = [
    { key: "s", label: "Security" },
    { key: "n", label: "Name" },
    { key: "q", label: "Quantity", align: "right" },
    { key: "l", label: "Last", align: "right" },
    { key: "c", label: "Ccy" },
    { key: "mv", label: `Mkt Val ${ccy}`, align: "right" },
    { key: "w", label: "Weight %", align: "right" },
    { key: "d", label: `Day P&L ${ccy}`, align: "right" },
    { key: "p", label: `Unreal P&L ${ccy}`, align: "right" },
    { key: "pp", label: "Unreal %", align: "right" },
    { key: "e", label: "Status" },
  ];
  const display = rows.map(({ h, last, mv, day, pnl }) => [
    h.security,
    h.name,
    h.quantity !== null ? fmtNum(h.quantity, Math.abs(h.quantity) < 100 ? 2 : 0) : "",
    last !== null ? fmtNum(last, decimalsFor(sectorOf(h.security), last)) : "",
    h.currency + (h.priceScale !== 1 ? " (minor)" : ""),
    money(mv),
    h.weightPct !== null && total ? fmtNum(((mv ?? 0) / total) * 100, 2) : "",
    money(day),
    pnl !== null ? money(pnl) : "",
    h.unrealizedPct !== null ? fmtNum(h.unrealizedPct, 2) : "",
    h.error ?? "OK",
  ]);
  const copy = rows.map(({ h, last, mv, day, pnl }) => [
    h.security,
    h.name,
    plain(h.quantity, 4),
    plain(last, 6),
    h.currency,
    plain(mv, 2),
    total ? plain(((mv ?? 0) / total) * 100, 4) : "",
    plain(day, 2),
    plain(pnl, 2),
    plain(h.unrealizedPct, 4),
    h.error ?? "OK",
  ]);
  display.push(["TOTAL", "", "", "", ccy, money(total), "100.00", money(totalDay), totalPnl !== null ? money(totalPnl) : "", "", ""]);
  copy.push(["TOTAL", "", "", "", ccy, plain(total), "100", plain(totalDay), plain(totalPnl), "", ""]);
  const t = copyable(display, copy);
  return (
    <Grid
      columns={columns}
      rows={t.display}
      copyText={t.copy}
      readOnly
      testId="port-holdings"
      onActivate={({ row }) => row < a.holdings.length && loadInPanel(panelId, a.holdings[row].security)}
      cellClass={(r, c) => {
        const v = r < rows.length ? [null, null, null, null, null, null, null, rows[r].day, rows[r].pnl][c] : null;
        if (r === rows.length) return "summary";
        if (c === 10 && rows[r]?.h.error) return "invalid";
        return typeof v === "number" ? (v > 0 ? "up" : v < 0 ? "down" : undefined) : undefined;
      }}
    />
  );
}

function PerformanceTab({ a }: { a: PortfolioAnalytics }) {
  const p = a.performance;
  const series = useMemo(
    () => [
      { label: a.name, color: "#fb8b1e", points: p.points.map((x) => ({ t: x.t, v: x.portfolio })) },
      { label: a.benchmark, color: "#4d9bff", points: p.points.map((x) => ({ t: x.t, v: x.benchmark })) },
    ],
    [a],
  );
  const excess = p.totalReturnPct !== null && p.benchmarkReturnPct !== null ? p.totalReturnPct - p.benchmarkReturnPct : null;
  return (
    <div className="col-flex">
      <KeyValues
        columns={3}
        items={[
          ["Portfolio Return", fmtPct(p.totalReturnPct)],
          [`${a.benchmark}`, fmtPct(p.benchmarkReturnPct)],
          ["Excess Return", fmtPct(excess)],
          ["Annualized", fmtPct(p.annualizedPct)],
          ["Start", fmtIsoDate(p.start)],
          ["Basis", "Current holdings held constant"],
        ]}
      />
      <div className="chart-area">{p.points.length > 1 ? <CompareChart series={series} testId="port-chart" /> : <div className="gray">NOT ENOUGH HISTORY</div>}</div>
    </div>
  );
}

function RiskTab({ a }: { a: PortfolioAnalytics }) {
  const r = a.risk;
  const ccy = a.baseCurrency;
  const contrib = a.holdings.filter((h) => h.riskContributionPct !== null).sort((x, y) => (y.riskContributionPct ?? 0) - (x.riskContributionPct ?? 0));
  const corr = a.correlation;
  return (
    <div className="col-flex">
      <KeyValues
        columns={3}
        items={[
          ["Volatility (ann.)", fmtPct(r.volatilityPct)],
          ["Benchmark Vol", fmtPct(r.benchmarkVolatilityPct)],
          ["Beta", fmtNum(r.beta, 3)],
          ["Correlation", fmtNum(r.correlation, 3)],
          ["Tracking Error", fmtPct(r.trackingErrorPct)],
          ["Information Ratio", fmtNum(r.informationRatio, 2)],
          [`Sharpe (rf ${fmtPct(r.riskFreePct)})`, fmtNum(r.sharpe, 2)],
          ["Max Drawdown", `${fmtPct(r.maxDrawdownPct)}${r.maxDrawdownPeak ? ` (${fmtIsoDate(r.maxDrawdownPeak)} to ${fmtIsoDate(r.maxDrawdownTrough)})` : ""}`],
          ["Observations", String(r.observations)],
          [`VaR 95% 1D hist (${ccy})`, money(r.var95Historical)],
          [`VaR 95% 1D param (${ccy})`, money(r.var95Parametric)],
          [`CVaR 95% 1D (${ccy})`, money(r.cvar95)],
        ]}
      />
      <div className="two-col fixed" style={{ flex: 1, minHeight: 0 }}>
        <div className="col-flex">
          <Section title="Contribution to Risk" />
          <Grid
            readOnly
            testId="port-risk"
            columns={[
              { key: "s", label: "Security" },
              { key: "w", label: "Weight %", align: "right" },
              { key: "r", label: "Risk %", align: "right" },
            ]}
            rows={contrib.map((h) => [h.security, fmtNum(h.weightPct, 2), fmtNum(h.riskContributionPct, 2)])}
          />
        </div>
        <div className="col-flex">
          <Section title="Correlation (top holdings)" />
          <Grid
            readOnly
            testId="port-corr"
            columns={[{ key: "s", label: "" }, ...corr.securities.map((s, i) => ({ key: `c${i}`, label: s.split(" ")[0], align: "right" as const }))]}
            rows={corr.securities.map((s, i) => [s.split(" ")[0], ...corr.matrix[i].map((v) => (v === null ? "" : v.toFixed(2)))])}
          />
        </div>
      </div>
    </div>
  );
}

const bar = (pct: number) => "█".repeat(Math.max(0, Math.min(20, Math.round(Math.abs(pct) / 5))));

function ExposuresTab({ a }: { a: PortfolioAnalytics }) {
  const block = (title: string, rows: { key: string; weightPct: number }[], testId: string) => (
    <div className="col-flex">
      <Section title={title} />
      <Grid
        readOnly
        testId={testId}
        columns={[
          { key: "k", label: title },
          { key: "w", label: "Weight %", align: "right" },
          { key: "b", label: "" },
        ]}
        rows={rows.map((r) => [r.key, fmtNum(r.weightPct, 2), bar(r.weightPct)])}
        copyText={(r, c) => (c === 1 ? plain(rows[r]?.weightPct, 4) : c === 2 ? "" : rows[r]?.key ?? "")}
      />
    </div>
  );
  return (
    <div className="grid-2x2 fill" data-testid="port-exposures">
      {block("Sector", a.exposures.sector, "exp-sector")}
      {block("Country", a.exposures.country, "exp-country")}
      {block("Currency", a.exposures.currency, "exp-currency")}
      {block("Asset Class", a.exposures.assetClass, "exp-asset")}
    </div>
  );
}

function AttributionTab({ a }: { a: PortfolioAnalytics }) {
  const rows = a.holdings.filter((h) => h.contributionPct !== null).sort((x, y) => (y.contributionPct ?? 0) - (x.contributionPct ?? 0));
  return (
    <div className="two-col fixed" style={{ flex: 1, minHeight: 0 }}>
      <div className="col-flex">
        <Section title="By Holding" right={`Sum ${fmtPct(a.attribution.totalContributionPct)} vs return ${fmtPct(a.performance.totalReturnPct)}`} />
        <Grid
          readOnly
          testId="port-attrib"
          columns={[
            { key: "s", label: "Security" },
            { key: "w", label: "Weight %", align: "right" },
            { key: "r", label: "Return %", align: "right" },
            { key: "c", label: "Contrib %", align: "right" },
          ]}
          rows={rows.map((h) => [h.security, fmtNum(h.weightPct, 2), fmtNum(h.periodReturnPct, 2), fmtNum(h.contributionPct, 2)])}
          cellClass={(r, c) => (c >= 2 && rows[r] ? ((c === 2 ? rows[r].periodReturnPct : rows[r].contributionPct) ?? 0) >= 0 ? "up" : "down" : undefined)}
        />
      </div>
      <div className="col-flex">
        <Section title="By Sector" right="Arithmetic sum of daily contributions" />
        <Grid
          readOnly
          testId="port-attrib-sector"
          columns={[
            { key: "k", label: "Sector" },
            { key: "w", label: "Weight %", align: "right" },
            { key: "c", label: "Contrib %", align: "right" },
          ]}
          rows={a.attribution.bySector.map((s) => [s.key, fmtNum(s.weightPct, 2), fmtNum(s.contributionPct, 2)])}
        />
      </div>
    </div>
  );
}

function WhatIfTab({ id, a, range, benchmark }: { id: number; a: PortfolioAnalytics; range: string; benchmark: string }) {
  const user = usePanels((s) => s.user);
  const kind = a.kind;
  const fields = EDIT_FIELDS[kind];
  const [rows, setRows] = useState<string[][] | null>(null);
  const [result, setResult] = useState<{ current: PortfolioAnalytics; proposed: PortfolioAnalytics } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.portfolio(user, id).then((p) => setRows(rowsFromHoldings(p.holdings, p.kind))).catch((e) => setError((e as Error).message));
  }, [user, id]);

  const { map: resolutions, ensure } = useResolutions((rows ?? []).map((r) => r[0] ?? ""));
  if (!rows) return <div className="gray">{error ?? "LOADING HOLDINGS..."}</div>;

  const run = async () => {
    setRunning(true);
    try {
      const { holdings, errors } = holdingsFromRows(rows, kind, await ensure());
      if (errors.length) {
        setError(errors[0]);
        return;
      }
      setError(null);
      setResult(await api.portfolioWhatIf(user, id, holdings, range, benchmark));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const metric = (label: string, f: (x: PortfolioAnalytics) => number | null, fmt: (v: number | null) => string) => {
    const c = result ? f(result.current) : null;
    const p = result ? f(result.proposed) : null;
    return [label, fmt(c), fmt(p), c !== null && p !== null ? fmt(p - c) : ""];
  };

  return (
    <div className="two-col fixed" style={{ flex: 1, minHeight: 0 }}>
      <div className="col-flex">
        <div className="toolbar">
          <button className="tool-button primary" data-testid="whatif-run" onClick={() => void run()} disabled={running}>
            {running ? "Running..." : "Run What-If"}
          </button>
          <span className="gray">Edit or paste proposed holdings ({kind === "positions" ? "shares" : "weights"}).</span>
        </div>
        {error && <div className="cmdline-message">{error}</div>}
        <Grid
          columns={(kind === "positions" ? POSITION_COLUMNS : MODEL_COLUMNS).slice(0, fields.length)}
          rows={rows}
          onChange={(next) => setRows(next.map((r) => fields.map((_, j) => r[j] ?? "")))}
          onPasteText={(text) => {
            const mapped = mapPastedTable(parseTable(text), kind);
            if (!mapped || (mapped.suggestedKind && mapped.suggestedKind !== kind)) return false;
            setRows(mapped.rows);
            return true;
          }}
          minRows={8}
          testId="whatif-grid"
          cellClass={(r, c) => (c === 0 && resolutions.get((rows[r]?.[0] ?? "").trim())?.status === "unresolved" ? "invalid" : undefined)}
        />
      </div>
      <div className="col-flex">
        <Section title="Current vs Proposed" />
        {result ? (
          <Grid
            readOnly
            testId="whatif-result"
            columns={[
              { key: "m", label: "Metric" },
              { key: "c", label: "Current", align: "right" },
              { key: "p", label: "Proposed", align: "right" },
              { key: "d", label: "Change", align: "right" },
            ]}
            rows={[
              metric(`Market Value ${a.baseCurrency}`, (x) => x.totals.marketValue, money),
              metric("Holdings", (x) => x.holdings.length, (v) => (v === null ? "" : String(v))),
              metric("Volatility %", (x) => x.risk.volatilityPct, (v) => fmtNum(v, 2)),
              metric("Beta", (x) => x.risk.beta, (v) => fmtNum(v, 3)),
              metric("Sharpe", (x) => x.risk.sharpe, (v) => fmtNum(v, 2)),
              metric("Max Drawdown %", (x) => x.risk.maxDrawdownPct, (v) => fmtNum(v, 2)),
              metric(`VaR 95% 1D ${a.baseCurrency}`, (x) => x.risk.var95Historical, money),
              metric("Period Return %", (x) => x.performance.totalReturnPct, (v) => fmtNum(v, 2)),
              ...[...new Set([...result.current.exposures.sector, ...result.proposed.exposures.sector].map((s) => s.key))].map((k) =>
                metric(
                  `Sector: ${k} %`,
                  (x) => x.exposures.sector.find((s) => s.key === k)?.weightPct ?? 0,
                  (v) => fmtNum(v, 2),
                ),
              ),
            ]}
          />
        ) : (
          <div className="gray">Run the what-if to compare risk, return and exposures.</div>
        )}
      </div>
    </div>
  );
}

/** PORT: portfolio and risk analytics. */
export function PortScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const list = useData(`portfolios|${user}|port`, (s) => api.portfolios(user, s), 60_000);
  const [pid, setPid] = useState<number | null>(() => lastPortfolio(user));
  const [range, setRange] = useState("1y");
  const [benchText, setBenchText] = useState("SPX Index");
  const [bench, setBench] = useState("SPX Index");
  const [benchError, setBenchError] = useState<string | null>(null);
  const tab = useOptions(panel, TABS.length, 0);
  const portfolios = list.data ?? [];
  const id = portfolios.some((p) => p.id === pid) ? pid : (portfolios[0]?.id ?? null);
  useEffect(() => {
    if (id !== null) rememberPortfolio(user, id);
  }, [user, id]);
  const state = useData(id ? `port|${user}|${id}|${range}|${bench}` : null, (s) => api.portfolioAnalytics(user, id!, range, bench, s), 60_000);
  const a = state.data;

  if (list.data && !portfolios.length) {
    return (
      <div data-testid="port-screen">
        <div className="yellow">NO PORTFOLIOS YET.</div>
        <p className="prose">Create one in PRTU: paste holdings from Excel or type tickers and shares, then Save.</p>
        <button className="tool-button primary" onClick={() => usePanels.getState().execute(panel.id, { kind: "function", fn: "PRTU" })}>
          Open PRTU
        </button>
      </div>
    );
  }

  return (
    <div className="col-flex" data-testid="port-screen">
      <div className="toolbar">
        <label className="label">
          Portfolio{" "}
          <select
            className="form-select"
            value={id ?? ""}
            data-testid="port-select"
            onChange={(e) => {
              const v = Number(e.target.value);
              setPid(v);
              rememberPortfolio(user, v);
            }}
          >
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.kind === "model" ? "model" : "positions"}, {p.count})
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Range{" "}
          <select className="form-select" value={range} onChange={(e) => setRange(e.target.value)}>
            {RANGES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const cmd = parseCommand(benchText);
            if (cmd.kind === "load") {
              setBench(cmd.security);
              setBenchError(null);
            } else setBenchError("Benchmark must be a security, e.g. SPX Index");
          }}
        >
          <label className="label">
            Benchmark <input className="form-input" style={{ width: "16ch" }} value={benchText} onChange={(e) => setBenchText(e.target.value.toUpperCase())} />
          </label>
        </form>
        <button className="tool-button" onClick={() => usePanels.getState().execute(panel.id, { kind: "function", fn: "PRTU" })}>
          Edit in PRTU
        </button>
        {a && (
          <span className="gray">
            {a.baseCurrency} {money(a.totals.marketValue)} · day <span className={a.totals.dayPnl >= 0 ? "up" : "down"}>{money(a.totals.dayPnl)}</span>
          </span>
        )}
      </div>
      {benchError && <div className="cmdline-message">{benchError}</div>}
      <OptionBar panel={panel} labels={TABS} selected={tab} extra={a ? `as of ${fmtIsoDate(a.asOf)}` : undefined} testId="port-tabs" />
      {a?.warnings.slice(0, 3).map((w) => (
        <div key={w} className="gray note-line">
          {w}
        </div>
      ))}
      {!a ? (
        <DataState state={state} what="PORTFOLIO ANALYTICS" />
      ) : tab === 0 ? (
        <HoldingsTab a={a} panelId={panel.id} />
      ) : tab === 1 ? (
        <PerformanceTab a={a} />
      ) : tab === 2 ? (
        <RiskTab a={a} />
      ) : tab === 3 ? (
        <ExposuresTab a={a} />
      ) : tab === 4 ? (
        <AttributionTab a={a} />
      ) : (
        <WhatIfTab id={id!} a={a} range={range} benchmark={bench} />
      )}
    </div>
  );
}
