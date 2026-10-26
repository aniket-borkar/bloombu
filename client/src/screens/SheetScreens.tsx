import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, fetchHistory, useData, useLiveQuotes, type Quote } from "../api";
import { Grid, type CellPos, type GridColumn } from "../components/Grid";
import { usePanels } from "../store/panels";
import { parseCommand } from "../terminal/commandParser";
import { createAutosave } from "../terminal/autosave";
import { FormulaError, computeSheet, formatCell, type Cell } from "../terminal/formula";
import type { HistoryRange } from "../terminal/functions";
import { onPendingBql, takePendingBql, takePendingSheet } from "../terminal/sheetState";
import { columnName } from "../terminal/table";
import { DataState, Section, useOptions, type ScreenProps } from "./common";
import { formatFieldValue } from "./FldsScreen";

const QUOTE_FIELDS: Record<string, (q: Quote) => number | string | null> = {
  PX_LAST: (q) => q.last,
  CHG_NET_1D: (q) => q.change,
  CHG_PCT_1D: (q) => q.changePct,
  PX_BID: (q) => q.bid,
  PX_ASK: (q) => q.ask,
  PX_VOLUME: (q) => q.volume,
  PX_HIGH: (q) => q.high,
  PX_LOW: (q) => q.low,
};

const BDH_RANGES = new Set(["1mo", "3mo", "6mo", "1y", "2y", "5y"]);
const BDH_FIELDS: Record<string, "o" | "h" | "l" | "c" | "v"> = { PX_LAST: "c", PX_OPEN: "o", PX_HIGH: "h", PX_LOW: "l", PX_VOLUME: "v" };

const toSecurity = (s: string): string | null => {
  const cmd = parseCommand(s);
  return cmd.kind === "load" ? cmd.security : null;
};

const EXAMPLE: string[][] = [
  ["Security", "Last", "Chg %", "P/E", "Mkt Cap", "Target", "Upside %"],
  ["AAPL US Equity", '=BDP(A2,"PX_LAST")', '=BDP(A2,"CHG_PCT_1D")', '=BDP(A2,"PE_RATIO")', '=BDP(A2,"CUR_MKT_CAP")', '=BDP(A2,"BEST_TARGET_PRICE")', "=(F2/B2-1)*100"],
  ["MSFT US Equity", '=BDP(A3,"PX_LAST")', '=BDP(A3,"CHG_PCT_1D")', '=BDP(A3,"PE_RATIO")', '=BDP(A3,"CUR_MKT_CAP")', '=BDP(A3,"BEST_TARGET_PRICE")', "=(F3/B3-1)*100"],
  ["NVDA US Equity", '=BDP(A4,"PX_LAST")', '=BDP(A4,"CHG_PCT_1D")', '=BDP(A4,"PE_RATIO")', '=BDP(A4,"CUR_MKT_CAP")', '=BDP(A4,"BEST_TARGET_PRICE")', "=(F4/B4-1)*100"],
  ["Average", "", "=AVERAGE(C2:C4)", "=AVERAGE(D2:D4)", "=SUM(E2:E4)", "", "=AVERAGE(G2:G4)"],
];

/** SHEET: spreadsheet with live Bloomberg-style formulas, saved per user. */
export function SheetScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [version, setVersion] = useState(0);
  const list = useData(`sheets|${user}|${version}`, (s) => api.docs.list(user, "sheet", s));
  const fieldList = useData("field-list", (s) => api.fieldList(s), 3_600_000);
  const known = useMemo(() => new Set(fieldList.data?.map((f) => f.id) ?? []), [fieldList.data]);
  const [name, setName] = useState<string | null>(() => takePendingSheet());
  const [raw, setRaw] = useState<string[][]>(EXAMPLE);
  const [status, setStatus] = useState("");
  const [newName, setNewName] = useState("");
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<CellPos>({ row: 0, col: 0 });
  const [bdp, setBdp] = useState(() => new Map<string, Cell>());
  const [bdh, setBdh] = useState(() => new Map<string, Cell[][] | FormulaError>());
  const inflight = useRef(new Set<string>());
  const loadedName = useRef<string | null>(null);
  const mounted = useRef(true);
  const saver = useMemo(
    () => createAutosave(async (doc: { user: string; name: string; cells: string[][] }) => {
      if (mounted.current && loadedName.current === doc.name) setStatus("Saving...");
      try {
        await api.docs.put(doc.user, "sheet", doc.name, { cells: doc.cells });
        if (mounted.current && loadedName.current === doc.name) setStatus(`Saved ${doc.name}`);
      } catch (e) {
        if (mounted.current) setStatus(`Save failed: ${(e as Error).message}`);
        throw e;
      }
    }),
    [],
  );
  const sheets = list.data ?? [];
  useOptions(panel, sheets.length);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void saver.flush().catch(() => {});
    };
  }, [saver]);

  const openSheet = async (nextName: string) => {
    if (busy || nextName === name) return;
    try {
      await saver.flush();
    } catch {
      // Keep the current draft editable when its save cannot complete.
      return;
    }
    loadedName.current = null;
    setName(nextName);
    setStatus(`Opening ${nextName}...`);
    setArmed(false);
  };

  // Open the first sheet (or keep the example until the user saves one).
  useEffect(() => {
    if (name === null && sheets.length) setName(sheets[0].name);
  }, [sheets.length]);

  useEffect(() => {
    if (!name || loadedName.current === name) return;
    const ctrl = new AbortController();
    let current = true;
    void (async () => {
      try {
        // Finish writes before reading, including when switching back to a sheet.
        await saver.flush();
        if (!current) return;
        const doc = await api.docs.get<{ cells: string[][] }>(user, "sheet", name, ctrl.signal);
        if (!current) return;
        loadedName.current = name;
        setRaw(Array.isArray(doc?.cells) ? doc.cells : []);
        setStatus(`Opened ${name}`);
      } catch (e) {
        if (current) setStatus((e as Error).message);
      }
    })();
    return () => {
      current = false;
      ctrl.abort();
    };
  }, [name, user, saver]);

  useEffect(() => {
    if (panel.option === null) return;
    const s = sheets[panel.option];
    usePanels.getState().setOption(panel.id, null);
    if (s) void openSheet(s.name);
  }, [panel.option]);

  const data = useMemo(
    () => ({
      bdp: (s: string, f: string): Cell | undefined => {
        if (known.size && !known.has(f)) return new FormulaError("#NAME?", `unknown field ${f}`);
        const sec = toSecurity(s);
        if (!sec) return new FormulaError("#N/A", "Invalid Security");
        return bdp.get(`${sec}|${f}`);
      },
      bdh: (s: string, f: string, r: string) => {
        const sec = toSecurity(s);
        if (!sec) return new FormulaError("#N/A", "Invalid Security");
        if (!BDH_FIELDS[f]) return new FormulaError("#NAME?", `BDH supports ${Object.keys(BDH_FIELDS).join(", ")}`);
        if (!BDH_RANGES.has(r)) return new FormulaError("#VALUE!", `range must be ${[...BDH_RANGES].join(", ")}`);
        return bdh.get(`${sec}|${f}|${r}`);
      },
    }),
    [bdp, bdh, known],
  );
  const result = useMemo(() => computeSheet(raw, data), [raw, data]);

  // Fetch data requested by formulas.
  useEffect(() => {
    const wanted = result.requests.bdp
      .map(([s, f]) => ({ sec: toSecurity(s)!, f }))
      .filter((x) => x.sec && !inflight.current.has(`${x.sec}|${x.f}`));
    if (wanted.length) {
      const secs = [...new Set(wanted.map((w) => w.sec))];
      const fields = [...new Set(wanted.map((w) => w.f))];
      wanted.forEach((w) => inflight.current.add(`${w.sec}|${w.f}`));
      api
        .fields(secs, fields)
        .then((table) =>
          setBdp((prev) => {
            const next = new Map(prev);
            for (const w of wanted) {
              const v = table[w.sec]?.[w.f];
              next.set(`${w.sec}|${w.f}`, v === undefined ? new FormulaError("#N/A", "Unknown Security") : v === null ? new FormulaError("#N/A", "N/A") : v);
            }
            return next;
          }),
        )
        .catch((e) =>
          setBdp((prev) => {
            const next = new Map(prev);
            for (const w of wanted) next.set(`${w.sec}|${w.f}`, new FormulaError("#N/A", e instanceof ApiError ? e.message : "Unavailable"));
            return next;
          }),
        );
    }
    for (const [s, f, r] of result.requests.bdh) {
      const sec = toSecurity(s)!;
      const k = `${sec}|${f}|${r}`;
      if (inflight.current.has(k)) continue;
      inflight.current.add(k);
      fetchHistory(sec, "1d", r as HistoryRange)
        .then((h) => setBdh((prev) => new Map(prev).set(k, h.bars.map((b) => [new Date(b.t).toISOString().slice(0, 10), b[BDH_FIELDS[f]]]))))
        .catch(() => setBdh((prev) => new Map(prev).set(k, new FormulaError("#N/A", "No History"))));
    }
  }, [result]);

  // Keep fundamentals fresh and stream quote fields live.
  useEffect(() => {
    const t = setInterval(() => {
      inflight.current.clear();
      setBdp(new Map());
    }, 120_000);
    return () => clearInterval(t);
  }, []);
  const liveSecs = useMemo(
    () => [...new Set([...bdp.keys()].filter((k) => QUOTE_FIELDS[k.split("|")[1]]).map((k) => k.split("|")[0]))].sort(),
    [bdp],
  );
  const snapshot = useData(liveSecs.length ? `sheet-live|${liveSecs.join(",")}` : null, (s) => api.quotes(liveSecs, s), 60_000);
  const live = useLiveQuotes(snapshot.data);
  useEffect(() => {
    if (!live) return;
    setBdp((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const q of live) {
        for (const [f, get] of Object.entries(QUOTE_FIELDS)) {
          const k = `${q.security}|${f}`;
          const v = get(q);
          if (next.has(k) && v !== null && next.get(k) !== v) {
            next.set(k, v);
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [live]);

  const editCells = (next: string[][]) => {
    if (busy) return;
    const cells = next.map((r) => [...r]);
    setRaw(cells);
    if (name && loadedName.current === name) {
      setStatus("Unsaved changes");
      saver.schedule({ user, name, cells });
    }
  };

  const create = async () => {
    const n = newName.trim();
    if (busy || !n) return;
    setBusy(true);
    try {
      await saver.flush();
      await api.docs.put(user, "sheet", n, { cells: name ? [] : raw });
      loadedName.current = null;
      setName(n);
      setNewName("");
      setVersion((v) => v + 1);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !name) return;
    if (!armed) {
      setArmed(true);
      setStatus(`Click Delete again to delete ${name}`);
      return;
    }
    setBusy(true);
    try {
      await saver.flush();
      await api.docs.remove(user, "sheet", name);
      setArmed(false);
      loadedName.current = null;
      setName(null);
      setRaw(EXAMPLE);
      setVersion((v) => v + 1);
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cols = Math.max(10, result.extent.cols + 2, ...raw.map((r) => r.length + 1));
  const rows = Math.max(30, result.extent.rows + 5);
  const columns: GridColumn[] = Array.from({ length: cols }, (_, i) => ({ key: columnName(i), label: columnName(i), width: i === 0 ? "18ch" : "12ch" }));
  const gridRows = Array.from({ length: result.extent.rows }, (_, r) => Array.from({ length: cols }, (_, c) => raw[r]?.[c] ?? ""));
  const activeRaw = raw[active.row]?.[active.col] ?? "";
  const activeValue = result.value(active.row, active.col);

  return (
    <div className="col-flex" data-testid="sheet-screen">
      <div className="toolbar">
        <span className="label">Sheets:</span>
        {sheets.map((s, i) => (
          <button
            key={s.name}
            className={`chart-opt${s.name === name ? " active" : ""}`}
            disabled={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openSheet(s.name)}
          >
            <span className="chart-opt-num">{i + 1})</span> {s.name}
          </button>
        ))}
        {!name && <span className="gray">Example (unsaved). Name it to save:</span>}
        <input className="form-input" placeholder="New sheet name" value={newName} disabled={busy} data-testid="sheet-new" onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        <button className="tool-button" disabled={busy} onClick={() => void create()}>
          Create
        </button>
        <button className="tool-button danger" onClick={() => void remove()} disabled={busy || !name}>
          Delete
        </button>
        <span className="gray" data-testid="sheet-status">
          {status}
        </span>
      </div>
      <div className="formula-bar" data-testid="formula-bar">
        <span className="menu-code">{columnName(active.col)}{active.row + 1}</span>
        <span className="white">{activeRaw || " "}</span>
        {activeRaw.startsWith("=") && <span className="gray"> = {formatCell(activeValue)}</span>}
      </div>
      {fieldList.error && !fieldList.data && <DataState state={fieldList} what="FIELD LIST" />}
      <Grid
        columns={columns}
        rows={gridRows}
        sheetHeaders
        minRows={rows}
        testId="sheet-grid"
        readOnly={busy || (!!name && loadedName.current !== name)}
        onChange={editCells}
        onSelectionChange={(_s, a) => setActive(a)}
        render={(r, c) => {
          const v = result.value(r, c);
          return <span className={v instanceof FormulaError ? "down" : typeof v === "number" ? "num" : ""}>{formatCell(v)}</span>;
        }}
        copyText={(r, c) => {
          const v = result.value(r, c);
          return typeof v === "number" ? String(v) : formatCell(v);
        }}
      />
      <Section title="Formulas" right="=BDP(sec, field) · =BDH(sec, field, range) · SUM AVERAGE MIN MAX COUNT ABS ROUND IF · fields in FLDS" />
    </div>
  );
}

const BQL_EXAMPLES = [
  "SELECT NAME, PX_LAST, CHG_PCT_1D, CUR_MKT_CAP FROM screen('most_actives') ORDER BY CUR_MKT_CAP DESC LIMIT 20",
  "SELECT NAME, PE_RATIO, EQY_DVD_YLD_IND FROM screen('undervalued_large_caps') WHERE PE_RATIO < 20 ORDER BY EQY_DVD_YLD_IND DESC",
  "SELECT NAME, PX_LAST, CHG_PCT_1D FROM wei() ORDER BY CHG_PCT_1D DESC",
  "SELECT NAME, PX_LAST, CHG_PCT_1D FROM glco() WHERE CHG_PCT_1D < 0",
  "SELECT NAME, PX_LAST, PE_RATIO, BEST_TARGET_PRICE FROM list('AAPL US Equity', 'MSFT US Equity', 'NVDA US Equity')",
];

/** BQL: query language over securities and fields; results copy to Excel. */
export function BqlScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [handedOff] = useState(() => takePendingBql(panel.id));
  const [query, setQuery] = useState(() => handedOff ?? localStorage.getItem("blmbu.bql.last") ?? BQL_EXAMPLES[0]);
  const [result, setResult] = useState<{ columns: string[]; rows: (number | string | null)[][]; universeSize: number } | null>(null);
  const [error, setError] = useState<{ message: string; position: number | null } | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (q = query) => {
    setRunning(true);
    setError(null);
    localStorage.setItem("blmbu.bql.last", q);
    try {
      setResult(await api.bql(q, user));
    } catch (e) {
      setResult(null);
      const pos = e instanceof ApiError ? e.body.position : undefined;
      setError({ message: (e as Error).message, position: typeof pos === "number" ? pos : null });
    } finally {
      setRunning(false);
    }
  };
  const latestRun = useRef(run);
  latestRun.current = run;

  // Queries handed over by the AI analyst run straight away.
  useEffect(() => {
    if (handedOff) void latestRun.current(handedOff);
    return onPendingBql(panel.id, (q) => {
      setQuery(q);
      void latestRun.current(q);
    });
  }, [panel.id]);

  return (
    <div className="col-flex" data-testid="bql-screen">
      <textarea
        className="form-input bql-input"
        value={query}
        spellCheck={false}
        data-testid="bql-input"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void run();
          }
        }}
      />
      <div className="toolbar">
        <button className="tool-button primary" data-testid="bql-run" onClick={() => void run()} disabled={running}>
          {running ? "Running..." : "Run (Ctrl/Cmd+Enter)"}
        </button>
        {BQL_EXAMPLES.map((ex, i) => (
          <button key={ex} className="tool-button" title={ex} onClick={() => setQuery(ex)}>
            Example {i + 1}
          </button>
        ))}
        {result && (
          <span className="gray">
            {result.rows.length} rows from {result.universeSize} securities · select cells and Ctrl/Cmd+C to copy
          </span>
        )}
      </div>
      {error && (
        <div className="cmdline-message" data-testid="bql-error">
          {error.message}
          {error.position !== null ? ` (at character ${error.position + 1}: "${query.slice(error.position, error.position + 12)}")` : ""}
        </div>
      )}
      {result ? (
        <Grid
          readOnly
          testId="bql-grid"
          columns={result.columns.map((c) => ({ key: c, label: c, align: c === "SECURITY" || c === "NAME" ? "left" : "right" }))}
          rows={result.rows.map((r) => r.map((v, i) => (i === 0 ? String(v) : formatFieldValue(v, typeof v === "number" ? "number" : "string"))))}
          copyText={(r, c) => {
            const v = result.rows[r]?.[c];
            return v === null || v === undefined ? "" : String(v);
          }}
        />
      ) : (
        !error && (
          <div className="gray note-line">
            SELECT fields FROM screen('id') | members('SPX Index') | portfolio('name') | list('sec', ...) | wei() | glco() | fx() [WHERE ...] [ORDER BY field DESC] [LIMIT n]
          </div>
        )
      )}
    </div>
  );
}
