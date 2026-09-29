import { useEffect, useMemo, useState } from "react";
import { forwardCurve } from "../../../server/src/research/fxmath";
import { api, useData } from "../api";
import { fmtIsoDate, fmtNum } from "../terminal/format";
import { DataState, DataTable, KeyValues, Section, type ScreenProps } from "./common";

/** FRD: theoretical FX forwards from official overnight rates, with editable rates for what-if pricing. */
export function FrdScreen({ panel, security }: ScreenProps) {
  const state = useData(`frd|${security}`, (s) => api.forwards(security!, s), 300_000);
  const d = state.data;
  const [baseRate, setBaseRate] = useState("");
  const [quoteRate, setQuoteRate] = useState("");

  useEffect(() => {
    if (!d) return;
    setBaseRate(String(d.base.ratePct));
    setQuoteRate(String(d.quote.ratePct));
  }, [d?.base.ratePct, d?.quote.ratePct]);

  const curve = useMemo(() => {
    if (!d) return null;
    const b = Number(baseRate);
    const q = Number(quoteRate);
    if (!Number.isFinite(b) || !Number.isFinite(q) || baseRate === "" || quoteRate === "") return d;
    return forwardCurve(d.security, d.spot, { ...d.base, ratePct: b }, { ...d.quote, ratePct: q });
  }, [d, baseRate, quoteRate]);

  if (!d || !curve) return <DataState state={state} what="FORWARDS" />;
  const edited = Number(baseRate) !== d.base.ratePct || Number(quoteRate) !== d.quote.ratePct;
  const decimals = d.quote.currency === "JPY" ? 3 : 5;
  const rateInput = (label: string, value: string, set: (v: string) => void, testId: string) => (
    <label className="label">
      {label}{" "}
      <input className="form-input" style={{ width: "9ch" }} value={value} data-testid={testId} onChange={(e) => set(e.target.value)} /> %
    </label>
  );

  return (
    <div className="col-flex" data-testid="frd-screen">
      <Section title={`${d.base.currency}/${d.quote.currency} Forward Rates`} right={`Spot ${fmtNum(d.spot, decimals)}`} />
      <KeyValues
        items={[
          [`${d.base.currency} ${d.base.name}`, `${fmtNum(d.base.ratePct, 3)}% (${fmtIsoDate(d.base.date)}, ${d.base.source})`],
          [`${d.quote.currency} ${d.quote.name}`, `${fmtNum(d.quote.ratePct, 3)}% (${fmtIsoDate(d.quote.date)}, ${d.quote.source})`],
        ]}
      />
      <div className="toolbar">
        {rateInput(d.base.currency, baseRate, setBaseRate, "frd-base")}
        {rateInput(d.quote.currency, quoteRate, setQuoteRate, "frd-quote")}
        {edited && (
          <button
            className="tool-button"
            onClick={() => {
              setBaseRate(String(d.base.ratePct));
              setQuoteRate(String(d.quote.ratePct));
            }}
          >
            Reset to official rates
          </button>
        )}
        {edited && <span className="yellow">What-if rates</span>}
      </div>
      <DataTable
        panel={panel}
        paged={false}
        testId="frd-table"
        rows={curve.rows}
        columns={[
          { key: "tenor", label: "Tenor", render: (r) => r.tenor },
          { key: "days", label: "Days", align: "right", render: (r) => r.days },
          { key: "outright", label: "Outright", align: "right", render: (r) => fmtNum(r.outright, decimals) },
          { key: "points", label: "Fwd Points", align: "right", render: (r) => <span className={r.points > 0 ? "up" : r.points < 0 ? "down" : ""}>{fmtNum(r.points, 2)}</span> },
          { key: "pct", label: "Premium % p.a.", align: "right", render: (r) => fmtNum(((r.outright / d.spot - 1) * 365 * 100) / r.days, 3) },
        ]}
      />
      <div className="screen-note">{d.method}</div>
    </div>
  );
}
