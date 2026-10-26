import { useEffect, useRef, useState } from "react";
import type { ScenarioInput, ScenarioResult } from "../../../server/src/portfolio/scenario";
import { api, useData } from "../api";
import { Grid } from "../components/Grid";
import { usePanels } from "../store/panels";
import { fmtIsoDateTime, fmtNum, fmtPct } from "../terminal/format";
import { lastPortfolio, rememberPortfolio } from "../terminal/portfolioState";
import { captureInNotebook, getResearchWorkbench, rememberResearchWorkbench } from "../terminal/researchState";
import { DataState, KeyValues, Section, type ScreenProps } from "./common";

type Shock = { scope: "sectors" | "securities" | "currencies"; key: string; pct: string };
type ScenarioDraft = { selected: number | null; name: string; market: string; shocks: Shock[]; result: ScenarioResult | null; changed: boolean };

/** Deterministic shocks to saved holdings, with separate price and currency effects. */
export function ScenarioScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [saved] = useState(() => getResearchWorkbench<ScenarioDraft>(user, panel.id, "SCEN"));
  const list = useData(`scenario-portfolios|${user}`, (signal) => api.portfolios(user, signal), 60_000);
  const [selected, setSelected] = useState<number | null>(() => saved?.selected ?? lastPortfolio(user));
  const portfolios = list.data ?? [];
  const id = portfolios.some((p) => p.id === selected) ? selected : (portfolios[0]?.id ?? null);
  const [name, setName] = useState(saved?.name ?? "Market down 10%");
  const [market, setMarket] = useState(saved?.market ?? "-10");
  const [shocks, setShocks] = useState<Shock[]>(saved?.shocks ?? []);
  const [result, setResult] = useState<ScenarioResult | null>(saved?.result ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(saved?.changed ?? false);
  const draft = useRef<ScenarioDraft>({ selected, name, market, shocks, result, changed });
  draft.current = { selected, name, market, shocks, result, changed };
  useEffect(() => () => { rememberResearchWorkbench(user, panel.id, "SCEN", null, draft.current); }, [user, panel.id]);

  const run = async () => {
    if (!id || busy) return;
    setError("");
    try {
      if (!market.trim() || !Number.isFinite(Number(market))) throw new Error("Enter a finite market shock in percent.");
      const input: ScenarioInput = { name: name.trim(), marketPct: Number(market), sectors: {}, securities: {}, currencies: {} };
      for (const shock of shocks) {
        const key = shock.key.trim();
        if (!key || !shock.pct.trim() || !Number.isFinite(Number(shock.pct))) throw new Error("Each shock needs a target and a finite percent change.");
        if (Object.keys(input[shock.scope]).some((k) => k.toUpperCase() === key.toUpperCase())) throw new Error(`Combine duplicate shocks for ${key} into one row.`);
        input[shock.scope][key] = Number(shock.pct);
      }
      setBusy(true);
      setResult(await api.scenario(user, id, input));
      setChanged(false);
      rememberPortfolio(user, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!list.data) return <div data-testid="scen-screen"><DataState state={list} what="PORTFOLIOS" /></div>;
  if (!portfolios.length) return (
    <div data-testid="scen-screen">
      <Section title="Portfolio Scenario Lab" />
      <p className="research-copy">Create a portfolio in PRTU, then apply market, sector, security and currency shocks to its holdings.</p>
      <button className="tool-button primary" onClick={() => usePanels.getState().execute(panel.id, { kind: "function", fn: "PRTU" })}>Create a portfolio</button>
    </div>
  );

  return (
    <div className="research-screen" data-testid="scen-screen">
      <Section title="Portfolio Scenario Lab" right="Explicit shocks · no trade execution" />
      <div className="toolbar">
        <label className="label">Portfolio <select className="form-select" value={id ?? ""} data-testid="scen-portfolio" disabled={busy} onChange={(e) => { setSelected(Number(e.target.value)); setResult(null); }}>
          {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.baseCurrency})</option>)}
        </select></label>
        <button className="tool-button" disabled={busy} onClick={() => { setMarket("-10"); setName("Market down 10%"); setShocks([]); setChanged(true); }}>Market −10%</button>
        <button className="tool-button" disabled={busy} onClick={() => { setMarket("10"); setName("Market up 10%"); setShocks([]); setChanged(true); }}>Market +10%</button>
        <button className="tool-button" disabled={busy} onClick={() => { setMarket("0"); setName("Custom scenario"); setShocks([]); setChanged(true); }}>Custom</button>
      </div>
      <div className="toolbar">
        <label className="label">Name <input className="form-input" value={name} maxLength={60} data-testid="scen-name" disabled={busy} onChange={(e) => { setName(e.target.value); setChanged(true); }} /></label>
        <label className="label">All prices % <input className="form-input research-number" value={market} data-testid="scen-market" disabled={busy} onChange={(e) => { setMarket(e.target.value); setChanged(true); }} /></label>
        <button className="tool-button" data-testid="scen-add-shock" disabled={busy} onClick={() => { setShocks((all) => [...all, { scope: "sectors", key: "", pct: "-5" }]); setChanged(true); }}>Add targeted shock</button>
      </div>
      {shocks.length > 0 && <div className="research-shocks">
        {shocks.map((shock, i) => <div className="toolbar" key={i} data-testid={`scen-shock-${i}`}>
          <select className="form-select" aria-label={`Shock ${i + 1} scope`} value={shock.scope} disabled={busy} onChange={(e) => { setShocks((all) => all.map((s, n) => n === i ? { ...s, scope: e.target.value as Shock["scope"], key: "" } : s)); setChanged(true); }}>
            <option value="sectors">Sector</option><option value="securities">Security</option><option value="currencies">Currency</option>
          </select>
          <input className="form-input grow" aria-label={`Shock ${i + 1} target`} value={shock.key} disabled={busy} placeholder={shock.scope === "sectors" ? "e.g. Technology" : shock.scope === "currencies" ? "e.g. EUR (not portfolio base)" : "e.g. AAPL US Equity"} onChange={(e) => { setShocks((all) => all.map((s, n) => n === i ? { ...s, key: e.target.value } : s)); setChanged(true); }} />
          <input className="form-input research-number" aria-label={`Shock ${i + 1} percent`} value={shock.pct} disabled={busy} onChange={(e) => { setShocks((all) => all.map((s, n) => n === i ? { ...s, pct: e.target.value } : s)); setChanged(true); }} /><span className="gray">%</span>
          <button className="row-remove" aria-label={`Remove shock ${i + 1}`} disabled={busy} onClick={() => { setShocks((all) => all.filter((_, n) => n !== i)); setChanged(true); }}>×</button>
        </div>)}
      </div>}
      <p className="research-copy gray">Price shocks combine market, sector and security assumptions. Currency shocks change the value of one unit of local currency in the portfolio base currency. These are hypothetical moves, with no probabilities attached.</p>
      <div className="toolbar">
        <button className="tool-button primary" data-testid="scen-run" disabled={busy} onClick={() => void run()}>{busy ? "Calculating..." : "Run scenario"}</button>
        {result && <button className="tool-button" data-testid="scen-capture" disabled={busy} onClick={() => captureInNotebook(panel.id, { kind: "scenario", title: `${result.portfolio}: ${result.name}`, source: "BLMBU Portfolio Scenario Lab", asOf: result.asOf, data: result })}>Capture in notebook</button>}
        {changed && result && <span className="yellow">Assumptions changed; run again to update results.</span>}
      </div>
      {error && <div className="cmdline-message" data-testid="scen-error">{error}</div>}
      {result && <>
        <Section title={`${result.portfolio} · ${result.name}`} right={`${result.baseCurrency} · ${fmtIsoDateTime(result.asOf)}`} />
        <div data-testid="scen-summary"><KeyValues columns={2} items={[
          ["Current value", fmtNum(result.currentValue, 2)], ["Stressed value", fmtNum(result.scenarioValue, 2)],
          ["P&L", <span className={result.pnl >= 0 ? "up" : "down"}>{fmtNum(result.pnl, 2)}</span>], ["P&L %", fmtPct(result.pnlPct)],
          ["Gross exposure", fmtNum(result.grossCurrentValue, 2)], ["Data coverage", `${result.coverage.valuedRows}/${result.coverage.totalRows} holdings`],
        ]} /></div>
        {result.warnings.map((warning, i) => <p className="research-copy yellow" key={i}>{warning}</p>)}
        <Section title="Holding contributions" right="Values in portfolio base currency" />
        {result.positions.length === 0 ? <p className="research-copy gray">This portfolio has no holdings. Add positions in PRTU to calculate contributions.</p> : <Grid readOnly scrollOnMount={false} testId="scen-positions" columns={[
          { key: "s", label: "Security" }, { key: "v", label: "Current", align: "right" }, { key: "sv", label: "Stressed", align: "right" },
          { key: "pnl", label: "P&L", align: "right" }, { key: "ps", label: "Price %", align: "right" }, { key: "fx", label: "FX %", align: "right" },
          { key: "pe", label: "Price effect", align: "right" }, { key: "fe", label: "FX effect", align: "right" }, { key: "i", label: "Interaction", align: "right" }, { key: "e", label: "Status" },
        ]} rows={result.positions.map((p) => [p.security, fmtNum(p.currentValue), fmtNum(p.scenarioValue), fmtNum(p.pnl), fmtNum(p.priceShockPct), fmtNum(p.fxShockPct), fmtNum(p.priceEffect), fmtNum(p.fxEffect), fmtNum(p.interaction), p.error ?? "Valued"])} cellClass={(r, c) => c === 3 && result.positions[r] ? (result.positions[r].pnl ?? 0) >= 0 ? "up" : "down" : undefined} />}
        <div className="research-columns">{([["Sector", result.bySector], ["Currency", result.byCurrency]] as const).map(([label, rows]) => <div key={label}>
          <Section title={`By ${label.toLowerCase()}`} />
          <table className="data-table"><thead><tr><th>{label}</th><th>Current</th><th>Stressed</th><th>P&L</th></tr></thead><tbody>{rows.map((row) => <tr key={row.key}><td>{row.key}</td><td className="num">{fmtNum(row.currentValue)}</td><td className="num">{fmtNum(row.scenarioValue)}</td><td className="num">{fmtNum(row.pnl)}</td></tr>)}</tbody></table>
        </div>)}</div>
        <p className="research-copy gray">Capture records this run's assumptions and values as a fixed research snapshot. Copy table ranges with Ctrl/Cmd+C.</p>
      </>}
    </div>
  );
}
