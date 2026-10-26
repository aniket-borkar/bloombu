import { useEffect, useRef, useState } from "react";
import type { ValuationContext, ValuationInput, ValuationResult } from "../../../server/src/research/valuation";
import { api, useData } from "../api";
import { Grid } from "../components/Grid";
import { usePanels } from "../store/panels";
import { fmtIsoDateTime, fmtNum, fmtPct } from "../terminal/format";
import { captureInNotebook, getResearchWorkbench, rememberResearchWorkbench } from "../terminal/researchState";
import { DataState, KeyValues, Section, type ScreenProps } from "./common";

type Model = "earnings" | "dcf";
type ValuationDraft = { method: Model; form: Record<string, string>; seeded: boolean; inferred: boolean; result: ValuationResult | null; resultContext: ValuationContext | null; changed: boolean };
const INITIAL: Record<string, string> = {
  currency: "", currentPrice: "", eps: "", growthPct: "5", years: "5", requiredReturnPct: "10", terminalPE: "15", payoutPct: "25",
  freeCashFlow: "", discountRatePct: "10", terminalGrowthPct: "2", netDebt: "0", sharesOutstanding: "",
};

/** Explicit valuation assumptions, with an earnings model and a manual FCFF model. */
export function ValuationScreen({ panel, security }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [saved] = useState(() => getResearchWorkbench<ValuationDraft>(user, panel.id, "VAL", security));
  const context = useData(`valuation-context|${security}`, (signal) => api.valuationContext(security!, signal), 60_000);
  const [method, setMethod] = useState<Model>(saved?.method ?? "earnings");
  const [form, setForm] = useState(saved?.form ?? INITIAL);
  const [seeded, setSeeded] = useState(saved?.seeded ?? false);
  const [inferred, setInferred] = useState(saved?.inferred ?? false);
  const [result, setResult] = useState<ValuationResult | null>(saved?.result ?? null);
  const [resultContext, setResultContext] = useState<ValuationContext | null>(saved?.resultContext ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(saved?.changed ?? false);
  const draft = useRef<ValuationDraft>({ method, form, seeded, inferred, result, resultContext, changed });
  draft.current = { method, form, seeded, inferred, result, resultContext, changed };
  useEffect(() => () => { rememberResearchWorkbench(user, panel.id, "VAL", security, draft.current); }, [user, panel.id, security]);

  useEffect(() => {
    if (!context.data || seeded) return;
    const data = context.data;
    setForm((current) => ({ ...current, currency: current.currency || data.currency || "", currentPrice: current.currentPrice || (data.price === null ? "" : String(data.price)), eps: current.eps || (data.inferredEps === null ? "" : String(data.inferredEps)), sharesOutstanding: current.sharesOutstanding || (data.sharesOutstanding === null ? "" : String(data.sharesOutstanding)) }));
    setInferred(!form.eps && data.inferredEps !== null);
    setSeeded(true);
  }, [context.data, seeded]);

  const edit = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    if (key === "eps") setInferred(false);
    setChanged(true);
  };
  const number = (key: string) => {
    if (!form[key].trim() || !Number.isFinite(Number(form[key]))) throw new Error(`Enter a finite value for ${key}.`);
    return Number(form[key]);
  };
  const calculate = async () => {
    if (busy) return;
    setError("");
    try {
      const common = { security: security!, currency: form.currency.trim(), currentPrice: form.currentPrice.trim() ? number("currentPrice") : null, growthPct: number("growthPct"), years: number("years") };
      const input: ValuationInput = method === "earnings"
        ? { ...common, method, eps: number("eps"), requiredReturnPct: number("requiredReturnPct"), terminalPE: number("terminalPE"), payoutPct: number("payoutPct") }
        : { ...common, method, freeCashFlow: number("freeCashFlow"), discountRatePct: number("discountRatePct"), terminalGrowthPct: number("terminalGrowthPct"), netDebt: number("netDebt"), sharesOutstanding: number("sharesOutstanding") };
      setBusy(true);
      const reference = context.data;
      setResult(await api.valuation(input));
      setResultContext(reference);
      setChanged(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = (key: string, label: string, hint?: string) => <label className="form-field" key={key}>
    <span className="label">{label}</span><span className="research-field"><input className="form-input" value={form[key]} data-testid={`val-${key}`} disabled={busy} onChange={(e) => edit(key, e.target.value)} />{hint && <small className="gray">{hint}</small>}</span>
  </label>;

  return (
    <div className="research-screen" data-testid="val-screen">
      <Section title="Valuation Lab" right={security} />
      <div className="toolbar">
        <button className={`tool-button${method === "earnings" ? " active" : ""}`} data-testid="val-earnings" disabled={busy} onClick={() => { setMethod("earnings"); setChanged(true); }}>Earnings & dividends</button>
        <button className={`tool-button${method === "dcf" ? " active" : ""}`} data-testid="val-dcf" disabled={busy} onClick={() => { setMethod("dcf"); setChanged(true); }}>Enterprise DCF (manual FCFF)</button>
      </div>
      {context.loading && <DataState state={context} what="VALUATION CONTEXT" />}
      {context.error && <p className="research-copy yellow">Market context unavailable. Enter inputs manually: {context.error.message}</p>}
      {context.data && <p className="research-copy gray" data-testid="val-source">Quote source: {context.data.source ?? "Unavailable"}{context.data.priceAsOf ? ` · ${fmtIsoDateTime(context.data.priceAsOf)}` : ""}. {inferred ? "Base EPS is inferred from quote price / positive trailing P/E; verify it before use." : "Valuation inputs are your assumptions."}</p>}
      {context.data?.warnings.map((warning, i) => <p className="research-copy yellow" key={i}>{warning}</p>)}
      <div className="research-columns">
        <div className="form-grid">
          {field("currency", "Currency", "Use one currency throughout the model.")}
          {field("currentPrice", "Market price", "Optional comparison price per share.")}
          {field("growthPct", "Growth % / year")}
          {field("years", "Forecast years")}
          {method === "earnings" ? <>
            {field("eps", "Base EPS", inferred ? "Inferred from the current quote, not reported EPS." : "Earnings per share in the selected currency.")}
            {field("requiredReturnPct", "Required return %")}
            {field("terminalPE", "Terminal P/E", "Multiple applied to final forecast-year EPS.")}
            {field("payoutPct", "Dividend payout %", "Percent of each year's earnings paid as dividends.")}
          </> : <>
            {field("freeCashFlow", "Base unlevered FCFF", "Total firm cash flow, in currency units; enter manually.")}
            {field("discountRatePct", "Discount rate %", "Firm cash flow discount rate (WACC).")}
            {field("terminalGrowthPct", "Terminal growth %")}
            {field("netDebt", "Net debt", "Debt minus cash, in the same currency; negative = net cash.")}
            {field("sharesOutstanding", "Shares outstanding", "Share count, not millions of shares.")}
          </>}
        </div>
        <div>
          <Section title={method === "earnings" ? "What this model values" : "Enterprise DCF assumptions"} />
          <p className="research-copy">{method === "earnings" ? "Discount projected cash dividends and a terminal share price equal to final-year EPS × terminal P/E. Growth, payout, multiple and required return are explicit assumptions." : "Discount unlevered free cash flow to the firm and a perpetual terminal value, subtract net debt, then divide by shares. Reported operating cash flow minus capital expenditure is not automatically treated as unlevered FCFF."}</p>
          <p className="research-copy gray">These outputs are conditional model values. Sensitivities vary two assumptions while holding the others fixed. They are not forecasts or recommendations.</p>
        </div>
      </div>
      <div className="toolbar">
        <button className="tool-button primary" data-testid="val-run" disabled={busy} onClick={() => void calculate()}>{busy ? "Calculating..." : "Calculate valuation"}</button>
        {result && <button className="tool-button" data-testid="val-capture" disabled={busy} onClick={() => captureInNotebook(panel.id, { kind: "valuation", title: `${result.security} ${result.method === "dcf" ? "DCF" : "earnings valuation"}`, security: result.security, source: resultContext?.source ?? "Manual valuation inputs", asOf: resultContext?.priceAsOf ?? result.calculatedAt, data: { context: resultContext, result } })}>Capture in notebook</button>}
        {changed && result && <span className="yellow">Assumptions changed; calculate again to update results.</span>}
      </div>
      {error && <div className="cmdline-message" data-testid="val-error">{error}</div>}
      {result && <>
        <Section title={`Last calculated · ${result.method === "dcf" ? "Enterprise DCF" : "Earnings & dividends"}`} right={`${result.currency} · ${fmtIsoDateTime(result.calculatedAt)}`} />
        <div data-testid="val-summary"><KeyValues columns={2} items={[
          ["Model value / share", <span data-testid="val-value">{fmtNum(result.valuePerShare, 4)}</span>], ["Comparison price", fmtNum(result.currentPrice, 4)], ["Upside / downside", fmtPct(result.upsidePct)],
          ...(result.enterpriseValue !== null ? [["Enterprise value", fmtNum(result.enterpriseValue, 0)] as [string, string]] : []),
          ...(result.equityValue !== null ? [["Equity value", fmtNum(result.equityValue, 0)] as [string, string]] : []),
        ]} /></div>
        {result.warnings.map((warning, i) => <p className="research-copy yellow" key={i}>{warning}</p>)}
        <Section title="Sensitivity" right={`${result.sensitivity.rowLabel} × ${result.sensitivity.columnLabel}`} />
        <div className="research-table" data-testid="val-sensitivity"><table className="data-table"><thead><tr><th>{result.sensitivity.rowLabel} ↓ / {result.sensitivity.columnLabel} →</th>{result.sensitivity.columns.map((column, i) => <th key={i} className="num">{fmtNum(column, 2)}{result.method === "earnings" ? "×" : "%"}</th>)}</tr></thead><tbody>{result.sensitivity.rows.map((row, i) => <tr key={i}><td className="label">{fmtNum(row, 2)}%</td>{result.sensitivity.values[i].map((value, j) => <td className="num" key={j}>{value === null ? "Invalid" : fmtNum(value, 2)}</td>)}</tr>)}</tbody></table></div>
        <p className="research-copy gray">Sensitivity cells are model value per share in {result.currency}. Invalid cells violate the model's assumptions.</p>
        <Section title="Forecast cash flows" right={result.method === "earnings" ? `${result.currency} / share` : `${result.currency} total firm`} />
        <Grid readOnly scrollOnMount={false} testId="val-forecast" columns={[{ key: "y", label: "Year" }, { key: "e", label: "EPS", align: "right" }, { key: "c", label: "Cash flow", align: "right" }, { key: "d", label: "Discount factor", align: "right" }, { key: "p", label: "Present value", align: "right" }]} rows={result.forecast.map((row) => [String(row.year), fmtNum(row.earningsPerShare, 4), fmtNum(row.cashFlow, 4), fmtNum(row.discountFactor, 4), fmtNum(row.presentValue, 4)])} />
        <KeyValues columns={2} items={[["Terminal value", fmtNum(result.terminalValue, 4)], ["Terminal present value", fmtNum(result.terminalPresentValue, 4)]]} />
        <p className="research-copy gray">{result.methodology}</p>
      </>}
    </div>
  );
}
