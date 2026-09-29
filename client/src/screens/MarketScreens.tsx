import { api, useData, useLiveQuotes, type CurvePoint, type Quote, type ScreenId, type ScreenRow } from "../api";
import { SCREENS, type YieldCurve } from "../../../server/src/types";
import { decimalsFor, fmtBig, fmtIsoDate, fmtNum, fmtPct, fmtTradeTime } from "../terminal/format";
import { sectorOf, tickerOf } from "../terminal/sectors";
import { Change, DataState, DataTable, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

function useQuoteList(securities: string[], refreshMs = 60_000) {
  const state = useData(`quotes|${securities.join(",")}`, (s) => api.quotes(securities, s), refreshMs);
  const live = useLiveQuotes(state.data);
  return { state, rows: live };
}

const quoteColumns = (extra: { key: string; label: string; render: (q: Quote & { group?: string }) => React.ReactNode }[] = []) => [
  ...extra,
  { key: "t", label: "Ticker", render: (q: Quote) => <span className="menu-code">{tickerOf(q.security)}</span> },
  { key: "n", label: "Name", render: (q: Quote) => <span className="white ellipsis">{q.name}</span> },
  { key: "l", label: "Last", align: "right" as const, render: (q: Quote) => <span className="white">{fmtNum(q.last, decimalsFor(sectorOf(q.security), q.last))}</span> },
  { key: "c", label: "Net Chg", align: "right" as const, render: (q: Quote) => <Change value={q.change} decimals={decimalsFor(sectorOf(q.security), q.last)} /> },
  { key: "p", label: "%Chg", align: "right" as const, render: (q: Quote) => <Change value={q.changePct} pct /> },
  { key: "tm", label: "Time", align: "right" as const, render: (q: Quote) => <span className="gray">{fmtTradeTime(q.time)}</span> },
];

const WEI_GROUPS: [string, string[]][] = [
  ["Americas", ["INDU", "SPX", "CCMP", "NDX", "RTY", "SPTSX", "MEXBOL", "IBOV"]],
  ["EMEA", ["SX5E", "SXXP", "UKX", "DAX", "CAC", "IBEX", "AEX", "SMI"]],
  ["Asia/Pac", ["NKY", "HSI", "SHCOMP", "KOSPI", "TWSE", "AS51", "SENSEX", "NIFTY", "STI"]],
];
const WEI_LIST = WEI_GROUPS.flatMap(([, t]) => t.map((x) => `${x} Index`));
const WEI_REGION = Object.fromEntries(WEI_GROUPS.flatMap(([g, t]) => t.map((x) => [`${x} Index`, g])));

/** WEI / W: world equity indices by region. */
export function WeiScreen({ panel }: ScreenProps) {
  const { state, rows } = useQuoteList(WEI_LIST, 30_000);
  if (!rows) return <DataState state={state} what="INDEX QUOTES" />;
  return (
    <div className="col-flex" data-testid="wei-screen">
      <Section title="World Equity Indices" right="Click to load" />
      <DataTable
        panel={panel}
        rows={rows}
        onRowClick={(q) => loadInPanel(panel.id, q.security)}
        columns={quoteColumns([{ key: "g", label: "Region", render: (q) => <span className="gray">{WEI_REGION[q.security]}</span> }])}
      />
    </div>
  );
}

const USD_QUOTED = new Set(["EUR", "GBP", "AUD", "NZD"]);
const WCRS_CCYS = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "CNY", "HKD", "SGD", "INR", "KRW", "BRL", "MXN", "ZAR", "TRY", "PLN"];
const pairFor = (ccy: string) => (USD_QUOTED.has(ccy) ? `${ccy}USD Curncy` : `USD${ccy} Curncy`);

/** Percent change of the currency itself against USD, from its USD pair's change. */
export function vsUsdPct(ccy: string, pairPct: number | null): number | null {
  if (pairPct === null) return null;
  return USD_QUOTED.has(ccy) ? pairPct : (1 / (1 + pairPct / 100) - 1) * 100;
}

/** WCRS: currencies ranked by performance against the US dollar. */
export function WcrsScreen({ panel }: ScreenProps) {
  const { state, rows } = useQuoteList(WCRS_CCYS.map(pairFor), 30_000);
  if (!rows) return <DataState state={state} what="FX QUOTES" />;
  const ranked = rows
    .map((q) => {
      const ccy = WCRS_CCYS.find((c) => pairFor(c) === q.security)!;
      return { q, ccy, vs: vsUsdPct(ccy, q.changePct) };
    })
    .sort((a, b) => (b.vs ?? -Infinity) - (a.vs ?? -Infinity));
  return (
    <div className="col-flex" data-testid="wcrs-screen">
      <Section title="World Currency Ranker" right="Performance vs USD, today" />
      <DataTable
        panel={panel}
        rows={ranked}
        onRowClick={(r) => loadInPanel(panel.id, r.q.security)}
        columns={[
          { key: "r", label: "Rank", align: "right", render: (_r, i) => i + 1 },
          { key: "c", label: "Currency", render: (r) => <span className="white">{r.ccy}</span> },
          { key: "vs", label: "vs USD", align: "right", render: (r) => <Change value={r.vs} decimals={3} pct /> },
          { key: "p", label: "Pair", render: (r) => <span className="menu-code">{tickerOf(r.q.security)}</span> },
          { key: "l", label: "Last", align: "right", render: (r) => fmtNum(r.q.last, decimalsFor("Curncy", r.q.last)) },
          { key: "pc", label: "Pair %Chg", align: "right", render: (r) => <Change value={r.q.changePct} decimals={3} pct /> },
        ]}
      />
    </div>
  );
}

const G10 = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"];

/** USD value of one unit of each currency, from USD pair quotes. */
export function usdValues(quotes: Quote[]): Record<string, number | null> {
  const out: Record<string, number | null> = { USD: 1 };
  for (const ccy of G10.slice(1)) {
    const q = quotes.find((x) => x.security === pairFor(ccy));
    out[ccy] = q?.last ? (USD_QUOTED.has(ccy) ? q.last : 1 / q.last) : null;
  }
  return out;
}

const crossDecimals = (v: number) => (v >= 100 ? 2 : v >= 1 ? 4 : 6);

/** FXC: G10 cross-rate matrix (units of column currency per one row currency). */
export function FxcScreen({ panel }: ScreenProps) {
  const { state, rows } = useQuoteList(G10.slice(1).map(pairFor), 30_000);
  if (!rows) return <DataState state={state} what="FX QUOTES" />;
  const usd = usdValues(rows);
  return (
    <div className="col-flex" data-testid="fxc-screen">
      <Section title="FX Cross Rates" right="Units of column currency per 1 row currency" />
      <DataTable
        panel={panel}
        rows={G10}
        columns={[
          { key: "base", label: "", render: (b) => <span className="menu-code">{b}</span> },
          ...G10.map((quote) => ({
            key: quote,
            label: quote,
            align: "right" as const,
            render: (base: string) => {
              if (base === quote) return <span className="gray">--</span>;
              const b = usd[base];
              const q = usd[quote];
              if (!b || !q) return "--";
              const v = b / q;
              return <span className="white">{fmtNum(v, crossDecimals(v))}</span>;
            },
          })),
        ]}
      />
    </div>
  );
}

const GLCO_GROUPS: [string, string[]][] = [
  ["Energy", ["CL1", "CO1", "NG1", "HO1", "XB1"]],
  ["Metals", ["GC1", "SI1", "HG1", "PL1", "PA1"]],
  ["Agriculture", ["C 1", "W 1", "S 1", "KC1", "SB1", "CC1", "CT1"]],
  ["Livestock", ["LC1"]],
];
const GLCO_LIST = GLCO_GROUPS.flatMap(([, t]) => t.map((x) => `${x} Comdty`));
const GLCO_GROUP = Object.fromEntries(GLCO_GROUPS.flatMap(([g, t]) => t.map((x) => [`${x} Comdty`, g])));

/** GLCO: global commodity prices (generic front-month futures). */
export function GlcoScreen({ panel }: ScreenProps) {
  const { state, rows } = useQuoteList(GLCO_LIST, 30_000);
  if (!rows) return <DataState state={state} what="COMMODITY QUOTES" />;
  return (
    <div className="col-flex" data-testid="glco-screen">
      <Section title="Global Commodity Prices" right="Generic 1st futures · click to load" />
      <DataTable
        panel={panel}
        rows={rows}
        onRowClick={(q) => loadInPanel(panel.id, q.security)}
        columns={quoteColumns([{ key: "g", label: "Group", render: (q) => <span className="gray">{GLCO_GROUP[q.security]}</span> }])}
      />
    </div>
  );
}

const SECTOR_ETFS: [string, string][] = [
  ["XLK", "Technology"],
  ["XLC", "Communication"],
  ["XLY", "Cons. Discretionary"],
  ["XLF", "Financials"],
  ["XLV", "Health Care"],
  ["XLI", "Industrials"],
  ["XLP", "Cons. Staples"],
  ["XLE", "Energy"],
  ["XLB", "Materials"],
  ["XLU", "Utilities"],
  ["XLRE", "Real Estate"],
];

function heat(pct: number | null): string {
  if (pct === null) return "#222";
  const a = Math.min(Math.abs(pct) / 3, 1) * 0.75 + 0.15;
  return pct >= 0 ? `rgba(30, 215, 96, ${a})` : `rgba(255, 67, 61, ${a})`;
}

/** IMAP: intraday market map of US sectors (SPDR sector ETFs as proxies). */
export function ImapScreen({ panel }: ScreenProps) {
  const list = ["SPX Index", ...SECTOR_ETFS.map(([t]) => `${t} US Equity`)];
  const { state, rows } = useQuoteList(list, 30_000);
  if (!rows) return <DataState state={state} what="SECTOR QUOTES" />;
  const spx = rows.find((q) => q.security === "SPX Index");
  const tiles = SECTOR_ETFS.map(([t, name]) => ({ name, q: rows.find((q) => q.security === `${t} US Equity`) }));
  return (
    <div className="col-flex" data-testid="imap-screen">
      <Section
        title="Intraday Market Map: US Sectors"
        right={
          <>
            S&amp;P 500 <Change value={spx?.changePct ?? null} pct /> · sector ETFs as proxies · click to load
          </>
        }
      />
      <div className="tiles">
        {tiles.map(({ name, q }) => (
          <button
            key={name}
            className="tile"
            style={{ background: heat(q?.changePct ?? null) }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => q && loadInPanel(panel.id, q.security)}
          >
            <span className="tile-name">{name}</span>
            <span className="tile-pct">{fmtPct(q?.changePct ?? null)}</span>
            <span className="tile-sub">{q ? tickerOf(q.security) : "--"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ScreenTable({ panel, rows }: { panel: ScreenProps["panel"]; rows: ScreenRow[] }) {
  return (
    <DataTable
      panel={panel}
      rows={rows}
      onRowClick={(r) => loadInPanel(panel.id, r.security)}
      columns={[
        { key: "s", label: "Ticker", render: (r) => <span className="menu-code">{tickerOf(r.security)}</span> },
        { key: "n", label: "Name", render: (r) => <span className="white ellipsis">{r.name}</span> },
        { key: "l", label: "Last", align: "right", render: (r) => fmtNum(r.last) },
        { key: "c", label: "Net Chg", align: "right", render: (r) => <Change value={r.change} /> },
        { key: "p", label: "%Chg", align: "right", render: (r) => <Change value={r.changePct} pct /> },
        { key: "v", label: "Volume", align: "right", render: (r) => fmtBig(r.volume) },
        { key: "m", label: "Mkt Cap", align: "right", render: (r) => fmtBig(r.marketCap) },
      ]}
    />
  );
}

function ScreenFunction({ panel, ids, testId }: { panel: ScreenProps["panel"]; ids: ScreenId[]; testId: string }) {
  const index = useOptions(panel, ids.length, 0);
  const id = ids[index];
  const state = useData(`screen|${id}`, (s) => api.screen(id, s), 60_000);
  return (
    <div className="col-flex" data-testid={testId}>
      <OptionBar panel={panel} labels={ids.map((i) => SCREENS[i])} selected={index} extra="Click a row to load" />
      {state.data ? <ScreenTable panel={panel} rows={state.data} /> : <DataState state={state} what="SCREEN RESULTS" />}
    </div>
  );
}

/** MOST: most active, top gainers and top losers (US). */
export function MostScreen({ panel }: ScreenProps) {
  return <ScreenFunction panel={panel} ids={["most_actives", "day_gainers", "day_losers"]} testId="most-screen" />;
}

/** EQS: predefined equity screens from the data provider. */
export function EqsScreen({ panel }: ScreenProps) {
  return (
    <ScreenFunction
      panel={panel}
      ids={["undervalued_large_caps", "undervalued_growth_stocks", "growth_technology_stocks", "aggressive_small_caps", "small_cap_gainers", "most_shorted_stocks", "portfolio_anchors"]}
      testId="eqs-screen"
    />
  );
}

const bp = (a: number | null | undefined, b: number | null | undefined) =>
  a === null || a === undefined || b === null || b === undefined ? null : (a - b) * 100;

function CurveChart({ points, history }: { points: CurvePoint[]; history: { label: string; points: CurvePoint[] }[] }) {
  const all = [points, ...history.map((h) => h.points)].flat().map((p) => p.yieldPct).filter((v): v is number => v !== null);
  const min = Math.floor((Math.min(...all) - 0.1) * 4) / 4;
  const max = Math.ceil((Math.max(...all) + 0.1) * 4) / 4;
  const W = 600;
  const H = 220;
  const L = 44;
  const B = 22;
  const x = (i: number) => L + (i * (W - L - 10)) / Math.max(points.length - 1, 1);
  const y = (v: number) => 8 + ((max - v) * (H - B - 8)) / (max - min || 1);
  const path = (pts: CurvePoint[]) =>
    points
      .map((p, i) => {
        const v = pts.find((q) => q.tenor === p.tenor)?.yieldPct;
        return v === null || v === undefined ? null : `${x(i)},${y(v)}`;
      })
      .filter(Boolean)
      .join(" ");
  const ticks = Array.from({ length: Math.round((max - min) / 0.25) + 1 }, (_, i) => min + i * 0.25).filter((_, i, a) => a.length <= 12 || i % 2 === 0);
  const colors = ["#9a9a9a", "#0068ff"];
  return (
    <svg className="curve" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-testid="curve-chart">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - 10} y1={y(t)} y2={y(t)} stroke="#1f1f1f" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" className="axis">{t.toFixed(2)}</text>
        </g>
      ))}
      {points.map((p, i) => (
        <text key={p.tenor} x={x(i)} y={H - 6} textAnchor="middle" className="axis">{p.tenor}</text>
      ))}
      {history.map((h, i) => (
        <polyline key={h.label} points={path(h.points)} fill="none" stroke={colors[i % colors.length]} strokeDasharray="4 3" strokeWidth="1.5" />
      ))}
      <polyline points={path(points)} fill="none" stroke="#fb8b1e" strokeWidth="2.5" />
      {points.map((p, i) => (p.yieldPct === null ? null : <circle key={p.tenor} cx={x(i)} cy={y(p.yieldPct)} r="2.5" fill="#fb8b1e" />))}
    </svg>
  );
}

/** GC: yield curve with one-week and one-month comparisons. */
const curveLabel = (name: string) => name.replace(/\s*\(.*\)$/, "").replace(/ Govt.*$| Actives$/, "");

export function GcScreen({ panel }: ScreenProps) {
  const state = useData("curves", (s) => api.curves(s));
  const selected = useOptions(panel, state.data?.length ?? 1);
  const c = state.data?.[selected] ?? state.data?.[0];
  if (!c) return <DataState state={state} what="YIELD CURVE" />;
  const w = c.history.find((h) => h.label === "1W Ago");
  const m = c.history.find((h) => h.label === "1M Ago");
  const at = (pts: CurvePoint[] | undefined, tenor: string) => pts?.find((p) => p.tenor === tenor)?.yieldPct ?? null;
  const s2s10 = bp(at(c.points, "10Y"), at(c.points, "2Y"));
  return (
    <div className="gc" data-testid="gc-screen">
      <OptionBar panel={panel} labels={state.data!.map((x) => curveLabel(x.name))} selected={selected} testId="gc-curves" />
      <Section
        title={`${c.name} · ${fmtIsoDate(c.date)}`}
        right={
          <>
            <span className="legend-now">Current</span> <span className="legend-w">1W ago</span> <span className="legend-m">1M ago</span> · 2s10s{" "}
            {s2s10 === null ? "--" : `${s2s10 > 0 ? "+" : ""}${fmtNum(s2s10, 1)}bp`} · {c.source}
          </>
        }
      />
      <div className="gc-body">
        <CurveChart points={c.points} history={c.history} />
        <DataTable
          panel={panel}
          rows={c.points}
          columns={[
            { key: "t", label: "Tenor", render: (p) => <span className="white">{p.tenor}</span> },
            { key: "y", label: "Yield", align: "right", render: (p) => fmtPct(p.yieldPct, 3) },
            { key: "w", label: "1W bp", align: "right", render: (p) => <Change value={bp(p.yieldPct, at(w?.points, p.tenor))} decimals={1} /> },
            { key: "m", label: "1M bp", align: "right", render: (p) => <Change value={bp(p.yieldPct, at(m?.points, p.tenor))} decimals={1} /> },
          ]}
        />
      </div>
    </div>
  );
}

const TSY_FUTURES = ["TU1 Comdty", "FV1 Comdty", "TY1 Comdty", "US1 Comdty"];

/** BTMM: US Treasury and money markets. */
export function BtmmScreen({ panel }: ScreenProps) {
  const mm = useData("money-markets", (s) => api.moneyMarkets(s));
  const curve = useData("curve", (s) => api.curve(s));
  const futures = useQuoteList(TSY_FUTURES, 30_000);
  const pick = (tenors: string[]) => (curve.data ? curve.data.points.filter((p) => tenors.includes(p.tenor)) : []);
  return (
    <div className="grid-2x2" data-testid="btmm-screen">
      <Section title="Money Market Rates" right={mm.data?.source}>
        {mm.data ? (
          <DataTable
            paged={false}
            rows={mm.data.rates}
            columns={[
              {
                key: "n",
                label: "Rate",
                render: (r) => (
                  <>
                    <span className="white">{r.name}</span>
                    {r.note && <span className="gray"> {r.note}</span>}
                  </>
                ),
              },
              { key: "r", label: "%", align: "right", render: (r) => fmtPct(r.ratePct, 2) },
              { key: "d", label: "As Of", align: "right", render: (r) => <span className="gray">{fmtIsoDate(r.date)}</span> },
            ]}
          />
        ) : (
          <DataState state={mm} what="MONEY MARKET RATES" />
        )}
      </Section>
      <Section title="Treasury Bills" right={curve.data ? fmtIsoDate(curve.data.date) : undefined}>
        {curve.data ? (
          <DataTable paged={false} rows={pick(["1M", "2M", "3M", "4M", "6M", "1Y"])} columns={[
            { key: "t", label: "Tenor", render: (p) => <span className="white">{p.tenor}</span> },
            { key: "y", label: "Yield", align: "right", render: (p) => fmtPct(p.yieldPct, 3) },
          ]} />
        ) : (
          <DataState state={curve} what="TREASURY YIELDS" />
        )}
      </Section>
      <Section title="Treasury Notes & Bonds">
        {curve.data ? (
          <DataTable paged={false} rows={pick(["2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"])} columns={[
            { key: "t", label: "Tenor", render: (p) => <span className="white">{p.tenor}</span> },
            { key: "y", label: "Yield", align: "right", render: (p) => fmtPct(p.yieldPct, 3) },
          ]} />
        ) : (
          <DataState state={curve} what="TREASURY YIELDS" />
        )}
      </Section>
      <Section title="Treasury Futures">
        {futures.rows ? (
          <DataTable
            paged={false}
            rows={futures.rows}
            onRowClick={(q) => loadInPanel(panel.id, q.security)}
            columns={[
              { key: "t", label: "Contract", render: (q) => <span className="menu-code">{tickerOf(q.security)}</span> },
              { key: "l", label: "Last", align: "right", render: (q) => fmtNum(q.last, 4) },
              { key: "c", label: "Chg", align: "right", render: (q) => <Change value={q.change} decimals={4} /> },
            ]}
          />
        ) : (
          <DataState state={futures.state} what="FUTURES QUOTES" />
        )}
      </Section>
    </div>
  );
}

/** WB: world bond markets. Free sources cover US Treasuries only. */
export function WbScreen({ panel }: ScreenProps) {
  const curves = useData("curves", (s) => api.curves(s));
  const futures = useQuoteList(TSY_FUTURES, 30_000);
  const at = (pts: CurvePoint[] | undefined, ...tenors: string[]) => {
    for (const t of tenors) {
      const y = pts?.find((p) => p.tenor === t)?.yieldPct;
      if (y !== null && y !== undefined) return y;
    }
    return null;
  };
  const yieldCell = (c: YieldCurve, ...tenors: string[]) => fmtPct(at(c.points, ...tenors), 3);
  return (
    <div className="col-flex" data-testid="wb-screen">
      <Section title="World Bond Markets" right="Official data: US Treasury, ECB, MOF Japan, Bank of Canada, Bank of England" />
      {curves.data ? (
        <DataTable
          panel={panel}
          paged={false}
          testId="wb-table"
          rows={curves.data}
          columns={[
            { key: "c", label: "Market", render: (c) => <span className="white">{curveLabel(c.name)}</span> },
            { key: "2", label: "2Y", align: "right", render: (c) => yieldCell(c, "2Y") },
            { key: "5", label: "5Y", align: "right", render: (c) => yieldCell(c, "5Y") },
            { key: "10", label: "10Y", align: "right", render: (c) => yieldCell(c, "10Y") },
            { key: "30", label: "30Y", align: "right", render: (c) => yieldCell(c, "30Y", "Long", "20Y") },
            { key: "w", label: "10Y 1W bp", align: "right", render: (c) => <Change value={bp(at(c.points, "10Y"), at(c.history.find((h) => h.label === "1W Ago")?.points, "10Y"))} decimals={1} /> },
            { key: "s", label: "2s10s bp", align: "right", render: (c) => <Change value={bp(at(c.points, "10Y"), at(c.points, "2Y"))} decimals={1} /> },
            { key: "d", label: "As Of", align: "right", render: (c) => <span className="gray">{fmtIsoDate(c.date)}</span> },
          ]}
        />
      ) : (
        <DataState state={curves} what="GOVERNMENT YIELDS" />
      )}
      {futures.rows && (
        <div className="gray note-line">
          Futures:{" "}
          {futures.rows.map((q) => (
            <span key={q.security} className="inline-quote">
              {tickerOf(q.security)} <span className="white">{fmtNum(q.last, 4)}</span> <Change value={q.change} decimals={4} />
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** ECST: world economic statistics (latest annual values). */
export function EcstScreen({ panel }: ScreenProps) {
  const state = useData("econ-stats", (s) => api.econStats(s));
  const e = state.data;
  if (!e) return <DataState state={state} what="ECONOMIC STATISTICS" />;
  return (
    <div className="col-flex" data-testid="ecst-screen">
      <Section title="World Economic Statistics" right={`Latest annual value (year) · ${e.source}`} />
      <DataTable
        panel={panel}
        rows={e.countries}
        columns={[
          { key: "c", label: "Country", render: (c) => <span className="white">{c.name}</span> },
          ...e.indicators.map((ind) => ({
            key: ind.id,
            label: ind.name,
            align: "right" as const,
            render: (c: (typeof e.countries)[number]) => {
              const v = c.values[ind.id];
              if (!v || v.value === null) return "--";
              const text = ind.id === "NY.GDP.MKTP.CD" ? fmtBig(v.value) : fmtNum(v.value, 1);
              return (
                <>
                  {text} <span className="gray">{v.year ? `'${v.year.slice(2)}` : ""}</span>
                </>
              );
            },
          })),
        ]}
      />
    </div>
  );
}

/** ECO: upcoming US economic data releases (FRED release calendar). */
export function EcoScreen({ panel }: ScreenProps) {
  const state = useData("econ-cal", (s) => api.econCalendar(s), 3_600_000);
  if (!state.data) return <DataState state={state} what="ECONOMIC CALENDAR" />;
  return (
    <div className="col-flex" data-testid="eco-screen">
      <Section title="Economic Calendar: Upcoming Releases" right={state.data[0]?.source} />
      <DataTable
        panel={panel}
        rows={state.data}
        columns={[
          { key: "d", label: "Date", render: (e) => <span className="white">{fmtIsoDate(e.date)}</span> },
          { key: "n", label: "Release", render: (e) => e.name },
        ]}
      />
    </div>
  );
}
