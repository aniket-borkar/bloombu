import { useEffect, useMemo, useRef, useState } from "react";
import { api, fetchHistory, useData, type Bar } from "../api";
import { RULE_FUNCTIONS, RuleError, ruleSignal } from "../../../server/src/research/rules";
import { CompareChart } from "../components/CompareChart";
import { Grid } from "../components/Grid";
import { usePanels } from "../store/panels";
import { backtest, type BacktestResult } from "../../../server/src/research/backtest";
import { onPendingBacktest, takePendingBacktest } from "../terminal/backtestState";
import { decimalsFor, fmtBarTime, fmtNum, fmtPct } from "../terminal/format";
import type { HistoryRange } from "../terminal/functions";
import { sectorOf } from "../terminal/sectors";
import { KeyValues, Section, type ScreenProps } from "./common";

interface Strategy {
  entry: string;
  exit: string;
  direction: "long" | "short";
  costBps: number;
}

const PRESETS: [string, Strategy][] = [
  ["Golden Cross", { entry: "crossAbove(sma(close, 50), sma(close, 200))", exit: "crossBelow(sma(close, 50), sma(close, 200))", direction: "long", costBps: 5 }],
  ["Trend (100D)", { entry: "close > sma(close, 100)", exit: "close < sma(close, 100)", direction: "long", costBps: 5 }],
  ["RSI Reversion", { entry: "rsi(close, 14) < 30", exit: "rsi(close, 14) > 55", direction: "long", costBps: 5 }],
  ["20D Breakout", { entry: "close > prev(highest(high, 20))", exit: "close < prev(lowest(low, 10))", direction: "long", costBps: 5 }],
  ["Momentum Short", { entry: "change(close, 20) < -10 and close < sma(close, 50)", exit: "close > sma(close, 20)", direction: "short", costBps: 10 }],
];

const RANGES: HistoryRange[] = ["1y", "2y", "5y"];

/** BTST: backtest trading rules on daily history. */
export function BacktestScreen({ panel, security }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [pending] = useState(() => (security ? takePendingBacktest({ panelId: panel.id, security }) : null));
  const [strategy, setStrategy] = useState<Strategy>(() =>
    pending ? { entry: pending.entry, exit: pending.exit, direction: pending.direction, costBps: pending.costBps } : PRESETS[1][1],
  );
  const [range, setRange] = useState<HistoryRange>(pending && RANGES.includes(pending.range) ? pending.range : "5y");
  const [runNonce, setRunNonce] = useState(0);
  const [ran, setRan] = useState<{ result: BacktestResult; bars: Bar[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [version, setVersion] = useState(0);
  const saved = useData(`strategies|${user}|${version}`, (s) => api.docs.list(user, "strategy", s));

  const latestRun = useRef(0);

  const run = async () => {
    const id = ++latestRun.current;
    setRunning(true);
    setError(null);
    try {
      const h = await fetchHistory(security!, "1d", range);
      if (id !== latestRun.current) return;
      const bars = h.bars;
      const which = (label: string, src: string) => {
        try {
          return ruleSignal(src, bars);
        } catch (e) {
          if (e instanceof RuleError) throw new Error(`${label} rule: ${e.message} (at character ${e.position + 1})`);
          throw e;
        }
      };
      const entry = which("Entry", strategy.entry);
      const exit = strategy.exit.trim() ? which("Exit", strategy.exit) : null;
      setRan({ result: backtest({ bars, entry, exit, direction: strategy.direction, costBps: strategy.costBps }), bars });
    } catch (e) {
      if (id !== latestRun.current) return;
      setRan(null);
      setError((e as Error).message);
    } finally {
      if (id === latestRun.current) setRunning(false);
    }
  };

  useEffect(() => {
    void run();
  }, [runNonce]);

  useEffect(() => {
    if (!security) return;
    return onPendingBacktest({ panelId: panel.id, security }, (p) => {
      setStrategy({ entry: p.entry, exit: p.exit, direction: p.direction, costBps: p.costBps });
      if (RANGES.includes(p.range)) setRange(p.range);
      setRunNonce((n) => n + 1);
    });
  }, [panel.id, security]);

  const save = async () => {
    const name = saveName.trim();
    if (!name) return;
    await api.docs.put(user, "strategy", name, strategy);
    setSaveName("");
    setVersion((v) => v + 1);
  };

  const load = async (name: string) => {
    const s = await api.docs.get<Strategy>(user, "strategy", name);
    setStrategy({ entry: s.entry ?? "", exit: s.exit ?? "", direction: s.direction === "short" ? "short" : "long", costBps: Number(s.costBps) || 0 });
  };

  const series = useMemo(
    () =>
      ran
        ? [
            { label: "Strategy", color: "#fb8b1e", points: ran.result.curve.map((p) => ({ t: p.t, v: p.strategy })) },
            { label: "Buy & Hold", color: "#4d9bff", points: ran.result.curve.map((p) => ({ t: p.t, v: p.buyHold })) },
          ]
        : [],
    [ran],
  );
  const s = ran?.result.stats;
  const d = decimalsFor(sectorOf(security), ran?.bars.at(-1)?.c ?? null);

  return (
    <div className="col-flex" data-testid="btst-screen">
      <div className="toolbar">
        <span className="label">Presets:</span>
        {PRESETS.map(([name, p]) => (
          <button key={name} className="tool-button" onClick={() => setStrategy(p)}>
            {name}
          </button>
        ))}
        {saved.data?.map((doc) => (
          <button key={doc.name} className="tool-button" onClick={() => void load(doc.name)}>
            ★ {doc.name}
          </button>
        ))}
      </div>
      <div className="form-grid">
        <label className="form-field">
          <span className="label">Entry rule</span>
          <input className="form-input" value={strategy.entry} data-testid="btst-entry" onChange={(e) => setStrategy({ ...strategy, entry: e.target.value })} />
        </label>
        <label className="form-field">
          <span className="label">Exit rule</span>
          <input className="form-input" value={strategy.exit} placeholder="blank = exit when entry is no longer true" data-testid="btst-exit" onChange={(e) => setStrategy({ ...strategy, exit: e.target.value })} />
        </label>
      </div>
      <div className="toolbar">
        <label className="label">
          Direction{" "}
          <select className="form-select" value={strategy.direction} onChange={(e) => setStrategy({ ...strategy, direction: e.target.value as "long" | "short" })}>
            <option value="long">long</option>
            <option value="short">short</option>
          </select>
        </label>
        <label className="label">
          Cost bps/side{" "}
          <input className="form-input" style={{ width: "6ch" }} value={strategy.costBps} onChange={(e) => setStrategy({ ...strategy, costBps: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label className="label">
          History{" "}
          <select className="form-select" value={range} onChange={(e) => setRange(e.target.value as HistoryRange)}>
            {RANGES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        </label>
        <button className="tool-button primary" data-testid="btst-run" onClick={() => void run()} disabled={running}>
          {running ? "Running..." : "Run Backtest"}
        </button>
        <input className="form-input" placeholder="Save as..." value={saveName} style={{ width: "14ch" }} onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        <button className="tool-button" onClick={() => void save()} disabled={!saveName.trim()}>
          Save
        </button>
      </div>
      {error && (
        <div className="cmdline-message" data-testid="btst-error">
          {error}
        </div>
      )}
      {s ? (
        <div className="two-col fixed" style={{ flex: 1, minHeight: 0 }}>
          <div className="col-flex">
            <KeyValues
              columns={2}
              items={[
                ["Strategy Return", fmtPct(s.totalReturnPct)],
                ["Buy & Hold", fmtPct(s.buyHoldReturnPct)],
                ["CAGR", fmtPct(s.cagrPct)],
                ["Volatility", fmtPct(s.volatilityPct)],
                ["Sharpe (rf 0)", fmtNum(s.sharpe, 2)],
                ["Max Drawdown", fmtPct(s.maxDrawdownPct)],
                ["Trades", String(s.trades)],
                ["Win Rate", fmtPct(s.winRatePct)],
                ["Avg Trade", fmtPct(s.avgTradePct)],
                ["Time in Market", fmtPct(s.exposurePct)],
              ]}
            />
            <div className="chart-area">
              <CompareChart series={series} testId="btst-chart" />
            </div>
          </div>
          <div className="col-flex">
            <Section title="Trades" right="Fills at next open · copy with Ctrl/Cmd+C" />
            <Grid
              readOnly
              testId="btst-trades"
              columns={[
                { key: "in", label: "Entry" },
                { key: "ip", label: "Price", align: "right" },
                { key: "out", label: "Exit" },
                { key: "op", label: "Price", align: "right" },
                { key: "r", label: "Return %", align: "right" },
                { key: "b", label: "Days", align: "right" },
              ]}
              rows={ran!.result.trades.map((t) => [
                fmtBarTime(t.entryDate, false),
                fmtNum(t.entryPrice, d),
                t.open ? "open" : fmtBarTime(t.exitDate, false),
                fmtNum(t.exitPrice, d),
                fmtNum(t.returnPct, 2),
                String(t.bars),
              ])}
              cellClass={(r, c) => (c === 4 ? (ran!.result.trades[r]?.returnPct ?? 0) >= 0 ? "up" : "down" : undefined)}
            />
          </div>
        </div>
      ) : (
        !error && (
          <div className="gray note-line">
            Rules use close, open, high, low, volume, numbers, comparisons, and/or/not and: {RULE_FUNCTIONS.join(", ")}.
          </div>
        )
      )}
    </div>
  );
}
