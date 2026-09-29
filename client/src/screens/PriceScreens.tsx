import { useEffect, useMemo, useState } from "react";
import { api, fetchHistory, useData, useQuote, type OptionChain } from "../api";
import { blackScholes, bondAnalytics } from "../../../server/src/research/quant";
import { benchmarkFor, alignedReturns, regress, totalReturnTable } from "../terminal/analytics";
import { decimalsFor, fmtBig, fmtBarTime, fmtIsoDate, fmtNum, fmtPct } from "../terminal/format";
import { sectorOf, tickerOf } from "../terminal/sectors";
import { Change, DataState, DataTable, KeyValues, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

const HP_VIEWS: [string, "1d" | "1wk", "1y" | "5y"][] = [
  ["Daily 1Y", "1d", "1y"],
  ["Weekly 5Y", "1wk", "5y"],
];

/** HP: historical price table, newest first. */
export function HpScreen({ panel, security }: ScreenProps) {
  const view = useOptions(panel, HP_VIEWS.length, 0);
  const [, interval, range] = HP_VIEWS[view];
  const state = useData(`hp|${security}|${interval}|${range}`, (s) => fetchHistory(security!, interval, range, s), 60_000);
  const bars = state.data?.bars ?? [];
  const rows = useMemo(() => bars.map((b, i) => ({ ...b, prev: i ? bars[i - 1].c : null })).reverse(), [bars]);
  const d = decimalsFor(sectorOf(security), bars.at(-1)?.c ?? null);
  return (
    <div className="col-flex" data-testid="hp-screen">
      <OptionBar panel={panel} labels={HP_VIEWS.map(([l]) => l)} selected={view} extra={`${rows.length} rows`} />
      {state.data ? (
        <DataTable
          panel={panel}
          rows={rows}
          columns={[
            { key: "d", label: "Date", render: (r) => <span className="white">{fmtBarTime(r.t, false)}</span> },
            { key: "o", label: "Open", align: "right", render: (r) => fmtNum(r.o, d) },
            { key: "h", label: "High", align: "right", render: (r) => fmtNum(r.h, d) },
            { key: "l", label: "Low", align: "right", render: (r) => fmtNum(r.l, d) },
            { key: "c", label: "Close", align: "right", render: (r) => <span className="white">{fmtNum(r.c, d)}</span> },
            { key: "ch", label: "Change", align: "right", render: (r) => (r.prev !== null ? <Change value={r.c - r.prev} decimals={d} /> : "--") },
            { key: "pc", label: "%Chg", align: "right", render: (r) => (r.prev ? <Change value={(r.c / r.prev - 1) * 100} pct /> : "--") },
            { key: "v", label: "Volume", align: "right", render: (r) => fmtBig(r.v) },
          ]}
        />
      ) : (
        <DataState state={state} what="PRICE HISTORY" />
      )}
    </div>
  );
}

const BETA_VIEWS: [string, "1y" | "2y" | "5y"][] = [
  ["1Y Weekly", "1y"],
  ["2Y Weekly", "2y"],
  ["5Y Weekly", "5y"],
];

/** BETA: regression of weekly returns against the local benchmark index. */
export function BetaScreen({ panel, security }: ScreenProps) {
  const view = useOptions(panel, BETA_VIEWS.length, 1);
  const [label, range] = BETA_VIEWS[view];
  const bench = benchmarkFor(security!);
  const s = useData(`beta-s|${security}|${range}`, (sig) => fetchHistory(security!, "1wk", range, sig));
  const b = useData(`beta-b|${bench}|${range}`, (sig) => fetchHistory(bench, "1wk", range, sig));
  const reg = useMemo(() => {
    if (!s.data || !b.data) return null;
    const { x, y } = alignedReturns(s.data.bars, b.data.bars);
    return regress(x, y);
  }, [s.data, b.data]);
  return (
    <div className="col-flex" data-testid="beta-screen">
      <OptionBar panel={panel} labels={BETA_VIEWS.map(([l]) => l)} selected={view} extra={`vs ${bench}`} />
      {!s.data ? (
        <DataState state={s} what="PRICE HISTORY" />
      ) : !b.data ? (
        <DataState state={b} what="BENCHMARK HISTORY" />
      ) : !reg ? (
        <div className="error-box">NOT ENOUGH OVERLAPPING HISTORY TO ESTIMATE BETA</div>
      ) : (
        <Section title={`Historical Beta · ${tickerOf(security!)} vs ${tickerOf(bench)} · ${label}`}>
          <KeyValues
            columns={2}
            items={[
              ["Raw Beta", <span className="big-number">{fmtNum(reg.beta, 3)}</span>],
              ["Adjusted Beta", <span className="big-number">{fmtNum(reg.adjustedBeta, 3)}</span>],
              ["Alpha (annualized)", fmtPct(reg.alpha * 52 * 100)],
              ["R-Squared", fmtNum(reg.r2, 3)],
              ["Correlation", fmtNum(reg.correlation, 3)],
              ["Observations", reg.n],
            ]}
          />
          <div className="gray note-line">
            OLS of weekly price returns. Adjusted beta = 0.67 x raw + 0.33. Benchmark chosen by listing exchange.
          </div>
        </Section>
      )}
    </div>
  );
}

/** TRA: price and total return (dividends reinvested) over standard periods. */
export function TraScreen({ panel, security }: ScreenProps) {
  const hist = useData(`tra-h|${security}`, (s) => fetchHistory(security!, "1d", "5y", s));
  const ev = useData(`dvd|${security}`, (s) => api.events(security!, s));
  const rows = useMemo(
    () => (hist.data ? totalReturnTable(hist.data.bars, ev.data?.dividends ?? []) : null),
    [hist.data, ev.data],
  );
  if (!rows) return <DataState state={hist} what="PRICE HISTORY" />;
  return (
    <div className="col-flex" data-testid="tra-screen">
      <Section title="Total Return Analysis" right={ev.data ? `${ev.data.dividends.length} dividends in history` : "price only"} />
      <DataTable
        panel={panel}
        rows={rows}
        columns={[
          { key: "p", label: "Period", render: (r) => <span className="white">{r.label}</span> },
          { key: "pr", label: "Price Return", align: "right", render: (r) => (r.priceReturn === null ? "--" : <Change value={r.priceReturn * 100} pct />) },
          { key: "tr", label: "Total Return", align: "right", render: (r) => (r.totalReturn === null ? "--" : <Change value={r.totalReturn * 100} pct />) },
          { key: "an", label: "Annualized TR", align: "right", render: (r) => (r.annualized === null ? "--" : <Change value={r.annualized * 100} pct />) },
        ]}
      />
      <div className="gray note-line">Dividends reinvested at the ex-date close. "--" means history does not cover the period.</div>
    </div>
  );
}

const MAX_EXPIRIES = 12;

/** OMON: option chain for a selected expiration. */
export function OmonScreen({ panel, security }: ScreenProps) {
  const first = useData(`omon|${security}|`, (s) => api.options(security!, null, s), 60_000);
  const expirations = first.data?.expirations.slice(0, MAX_EXPIRIES) ?? [];
  const index = useOptions(panel, expirations.length, 0);
  const expiration = expirations[index] ?? null;
  const chosen = useData(index > 0 && expiration ? `omon|${security}|${expiration}` : null, (s) => api.options(security!, expiration, s), 60_000);
  const chain: OptionChain | null = index > 0 ? chosen.data : first.data;
  const rows = useMemo(() => {
    if (!chain) return [];
    const strikes = [...new Set([...chain.calls, ...chain.puts].map((o) => o.strike))].sort((a, b) => a - b);
    const call = new Map(chain.calls.map((o) => [o.strike, o]));
    const put = new Map(chain.puts.map((o) => [o.strike, o]));
    return strikes.map((k) => ({ strike: k, call: call.get(k), put: put.get(k) }));
  }, [chain]);
  const atm = chain?.underlying ?? null;
  const atmIndex = atm === null ? 0 : rows.reduce((best, r, i) => (Math.abs(r.strike - atm) < Math.abs(rows[best].strike - atm) ? i : best), 0);
  if (!first.data) return <DataState state={first} what="OPTION CHAIN" />;
  const iv = (v: number | null | undefined) => (v === null || v === undefined ? "--" : fmtPct(v * 100, 1));
  const n = (v: number | null | undefined) => fmtNum(v ?? null);
  const i0 = (v: number | null | undefined) => (v === null || v === undefined ? "--" : fmtBig(v, 1));
  return (
    <div className="col-flex" data-testid="omon-screen">
      <OptionBar
        panel={panel}
        labels={expirations.map((e) => fmtIsoDate(e).slice(0, 5))}
        selected={index}
        extra={`Underlying ${fmtNum(atm)} · ${first.data.source}`}
      />
      {!chain ? (
        <DataState state={chosen} what="OPTION CHAIN" />
      ) : (
        <DataTable
          key={chain.expiration ?? ""}
          panel={panel}
          rows={rows}
          initialIndex={Math.max(0, atmIndex - 3)}
          rowClass={(r) => (r.strike === rows[atmIndex]?.strike ? "highlight" : "")}
          columns={[
            { key: "cb", label: "C Bid", align: "right", render: (r) => <span className={r.call?.itm ? "itm" : ""}>{n(r.call?.bid)}</span> },
            { key: "ca", label: "C Ask", align: "right", render: (r) => <span className={r.call?.itm ? "itm" : ""}>{n(r.call?.ask)}</span> },
            { key: "cl", label: "C Last", align: "right", render: (r) => n(r.call?.last) },
            { key: "civ", label: "C IV", align: "right", render: (r) => iv(r.call?.iv) },
            { key: "cv", label: "C Vol", align: "right", render: (r) => i0(r.call?.volume) },
            { key: "coi", label: "C OI", align: "right", render: (r) => i0(r.call?.openInterest) },
            { key: "k", label: "Strike", align: "center", render: (r) => <span className="strike">{fmtNum(r.strike)}</span> },
            { key: "pb", label: "P Bid", align: "right", render: (r) => <span className={r.put?.itm ? "itm" : ""}>{n(r.put?.bid)}</span> },
            { key: "pa", label: "P Ask", align: "right", render: (r) => <span className={r.put?.itm ? "itm" : ""}>{n(r.put?.ask)}</span> },
            { key: "pl", label: "P Last", align: "right", render: (r) => n(r.put?.last) },
            { key: "piv", label: "P IV", align: "right", render: (r) => iv(r.put?.iv) },
            { key: "pv", label: "P Vol", align: "right", render: (r) => i0(r.put?.volume) },
            { key: "poi", label: "P OI", align: "right", render: (r) => i0(r.put?.openInterest) },
          ]}
        />
      )}
    </div>
  );
}

function NumberField({ label, value, onChange, testId }: { label: string; value: string; onChange: (v: string) => void; testId: string }) {
  return (
    <label className="form-field">
      <span className="label">{label}</span>
      <input className="form-input" inputMode="decimal" value={value} data-testid={testId} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const parse = (v: string) => {
  const n = Number(v.replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
};

const DEFAULT_VOL: Partial<Record<string, number>> = { Curncy: 8, Index: 18, Comdty: 30, Govt: 10 };

/** OVML: Black-Scholes-Merton option valuation (Garman-Kohlhagen for FX). */
export function OvmlScreen({ security }: ScreenProps) {
  const sector = sectorOf(security);
  const { data: quote } = useQuote(security);
  const curve = useData("curve", (s) => api.curve(s));
  const profile = useData(sector === "Equity" ? `profile|${security}` : null, (s) => api.profile(security!, s));
  const chain = useData(sector === "Equity" ? `omon|${security}|` : null, (s) => api.options(security!, null, s), 60_000);
  const [form, setForm] = useState<Record<string, string> | null>(null);

  const settled = (s: { loading: boolean }) => !s.loading;
  const inputsReady = settled(curve) && settled(profile) && settled(chain);

  useEffect(() => {
    if (form || !quote?.last || !inputsReady) return;
    const spot = quote.last;
    const d = decimalsFor(sector, spot);
    const bill = curve.data?.points.find((p) => p.tenor === "3M")?.yieldPct ?? 4;
    const atmCall = chain.data?.calls.reduce<{ strike: number; iv: number | null } | null>(
      (best, c) => (!best || Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best),
      null,
    );
    const vol = atmCall?.iv ? atmCall.iv * 100 : (DEFAULT_VOL[sector ?? ""] ?? 25);
    setForm({
      spot: spot.toFixed(d),
      strike: spot.toFixed(d),
      days: "30",
      vol: vol.toFixed(2),
      rate: bill.toFixed(3),
      carry: (profile.data?.dividendYieldPct ?? 0).toFixed(3),
    });
  }, [form, quote?.last, inputsReady, curve.data, chain.data, profile.data, sector]);

  if (!form) return <div className="gray">LOADING PRICING INPUTS...</div>;
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v });
  const inputs = {
    spot: parse(form.spot),
    strike: parse(form.strike),
    t: parse(form.days) / 365,
    vol: parse(form.vol) / 100,
    rate: Math.log(1 + parse(form.rate) / 100),
    carry: Math.log(1 + parse(form.carry) / 100),
  };
  const valid = Object.values(inputs).every((v) => Number.isFinite(v)) && inputs.spot > 0 && inputs.strike > 0 && inputs.t > 0 && inputs.vol > 0;
  const call = valid ? blackScholes("call", inputs) : null;
  const put = valid ? blackScholes("put", inputs) : null;
  const d = decimalsFor(sector, inputs.spot);
  const rows: [string, (v: ReturnType<typeof blackScholes>) => string][] = [
    ["Premium", (v) => fmtNum(v.price, Math.max(d, 2))],
    ["Premium % Spot", (v) => fmtPct((v.price / inputs.spot) * 100, 3)],
    ["Delta", (v) => fmtNum(v.delta, 4)],
    ["Gamma", (v) => fmtNum(v.gamma, 5)],
    ["Vega (1 vol pt)", (v) => fmtNum(v.vega, 4)],
    ["Theta (1 day)", (v) => fmtNum(v.theta, 4)],
    ["Rho (1%)", (v) => fmtNum(v.rho, 4)],
  ];
  return (
    <div className="two-col" data-testid="ovml-screen">
      <Section title="Inputs">
        <div className="form-grid">
          <NumberField label="Spot" value={form.spot} onChange={set("spot")} testId="ovml-spot" />
          <NumberField label="Strike" value={form.strike} onChange={set("strike")} testId="ovml-strike" />
          <NumberField label="Days to Expiry" value={form.days} onChange={set("days")} testId="ovml-days" />
          <NumberField label="Volatility %" value={form.vol} onChange={set("vol")} testId="ovml-vol" />
          <NumberField label="Rate % (ann.)" value={form.rate} onChange={set("rate")} testId="ovml-rate" />
          <NumberField label={sector === "Curncy" ? "Foreign Rate %" : "Dividend Yield %"} value={form.carry} onChange={set("carry")} testId="ovml-carry" />
        </div>
        <div className="gray note-line">
          European exercise, Black-Scholes-Merton{sector === "Curncy" ? " (Garman-Kohlhagen)" : ""}. Defaults: live spot, ATM strike,
          nearest-expiry ATM implied vol where available, 3M T-bill rate. Esc returns to the command line.
        </div>
      </Section>
      <Section title="Valuation">
        {!valid ? (
          <div className="error-box">ENTER POSITIVE SPOT, STRIKE, DAYS AND VOLATILITY</div>
        ) : (
          <table className="data-table" data-testid="ovml-output">
            <thead>
              <tr>
                <th />
                <th style={{ textAlign: "right" }}>Call</th>
                <th style={{ textAlign: "right" }}>Put</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, f]) => (
                <tr key={label}>
                  <td className="label">{label}</td>
                  <td style={{ textAlign: "right" }} className="white">{f(call!)}</td>
                  <td style={{ textAlign: "right" }} className="white">{f(put!)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}

const TENOR_YEARS: Record<string, number> = {
  CT3M: 0.25, CB3: 0.25, CT5: 5, CT10: 10, CT30: 30, USGG3M: 0.25, USGG5YR: 5, USGG10YR: 10, USGG30YR: 30,
};

/** YAS: yield and risk analytics for a bond priced off the loaded yield. */
export function YasScreen({ security }: ScreenProps) {
  const { data: quote } = useQuote(security);
  const [form, setForm] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    if (form || !quote?.last) return;
    const ytm = quote.last;
    const years = TENOR_YEARS[tickerOf(security!).split(" ")[0]] ?? 10;
    setForm({
      coupon: years < 1 ? "0" : (Math.round(ytm * 8) / 8).toFixed(3),
      years: String(years),
      ytm: ytm.toFixed(3),
      freq: years < 1 ? "1" : "2",
    });
  }, [form, quote?.last, security]);
  if (!form) return <div className="gray">LOADING YIELD...</div>;
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v });
  const coupon = parse(form.coupon) / 100;
  const years = parse(form.years);
  const ytm = parse(form.ytm) / 100;
  const frequency = Math.round(parse(form.freq));
  const valid = [coupon, years, ytm].every(Number.isFinite) && years > 0 && frequency >= 1 && frequency <= 12 && coupon >= 0 && ytm > -0.99;
  const b = valid ? bondAnalytics({ coupon, years, ytm, frequency }) : null;
  const shifts = [-100, -50, -25, 0, 25, 50, 100];
  return (
    <div className="two-col" data-testid="yas-screen">
      <Section title="Bond Inputs">
        <div className="form-grid">
          <NumberField label="Coupon %" value={form.coupon} onChange={set("coupon")} testId="yas-coupon" />
          <NumberField label="Years to Maturity" value={form.years} onChange={set("years")} testId="yas-years" />
          <NumberField label="Yield %" value={form.ytm} onChange={set("ytm")} testId="yas-ytm" />
          <NumberField label="Coupons / Year" value={form.freq} onChange={set("freq")} testId="yas-freq" />
        </div>
        <div className="gray note-line">
          Default yield is the loaded security's live yield; coupon defaults to the nearest 1/8. Settlement is assumed on a
          coupon date (no accrued interest). Esc returns to the command line.
        </div>
      </Section>
      <Section title="Analytics">
        {!b ? (
          <div className="error-box">ENTER A VALID COUPON, MATURITY, YIELD AND FREQUENCY (1-12)</div>
        ) : (
          <>
            <KeyValues
              columns={1}
              items={[
                ["Price (per 100)", fmtNum(b.price, 4)],
                ["Macaulay Duration", fmtNum(b.macaulayDuration, 3)],
                ["Modified Duration", fmtNum(b.modifiedDuration, 3)],
                ["Convexity", fmtNum(b.convexity, 3)],
                ["DV01 (per 100)", fmtNum(b.dv01, 4)],
              ]}
            />
            <DataTable
              paged={false}
              rows={shifts}
              testId="yas-scenarios"
              columns={[
                { key: "s", label: "Yield Shift", render: (s) => `${s > 0 ? "+" : ""}${s} bp` },
                { key: "y", label: "Yield", align: "right", render: (s) => fmtPct(ytm * 100 + s / 100, 3) },
                { key: "p", label: "Price", align: "right", render: (s) => fmtNum(bondAnalytics({ coupon, years, ytm: ytm + s / 10_000, frequency }).price, 4) },
                { key: "c", label: "Change", align: "right", render: (s) => <Change value={bondAnalytics({ coupon, years, ytm: ytm + s / 10_000, frequency }).price - b.price} decimals={4} /> },
              ]}
            />
          </>
        )}
      </Section>
    </div>
  );
}

/** CT: futures contract table for a generic commodity future. */
export function CtScreen({ panel, security }: ScreenProps) {
  const state = useData(`ct|${security}`, (s) => api.futures(security!, s), 60_000);
  if (!state.data) return <DataState state={state} what="CONTRACT TABLE" />;
  const d = decimalsFor("Comdty", state.data.contracts[0]?.last ?? null);
  return (
    <div className="col-flex" data-testid="ct-screen">
      <Section title="Contract Table" right={`${state.data.source} · click to load a contract`} />
      <DataTable
        panel={panel}
        rows={state.data.contracts}
        onRowClick={(c) => loadInPanel(panel.id, c.security)}
        columns={[
          { key: "s", label: "Contract", render: (c) => <span className="menu-code">{c.security}</span> },
          { key: "m", label: "Month", render: (c) => <span className="white">{c.month}</span> },
          { key: "l", label: "Last", align: "right", render: (c) => fmtNum(c.last, d) },
          { key: "c", label: "Change", align: "right", render: (c) => <Change value={c.change} decimals={d} /> },
          { key: "p", label: "%Chg", align: "right", render: (c) => <Change value={c.changePct} pct /> },
          { key: "v", label: "Volume", align: "right", render: (c) => fmtBig(c.volume) },
          { key: "oi", label: "Open Int", align: "right", render: (c) => fmtBig(c.openInterest) },
          { key: "x", label: "Expiry", align: "right", render: (c) => fmtIsoDate(c.expiry) },
        ]}
      />
    </div>
  );
}
