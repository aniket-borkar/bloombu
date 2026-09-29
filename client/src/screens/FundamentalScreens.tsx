import { api, useData, type Statement, type StatementPeriod, type Valuation } from "../api";
import { fmtBig, fmtInt, fmtIsoDate, fmtNum, fmtPct } from "../terminal/format";
import { Change, DataState, DataTable, KeyValues, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

const FA_VIEWS: [string, Statement, StatementPeriod][] = [
  ["Income", "income", "annual"],
  ["Balance Sheet", "balance", "annual"],
  ["Cash Flow", "cashflow", "annual"],
  ["Income Qtr", "income", "quarterly"],
  ["Balance Qtr", "balance", "quarterly"],
  ["Cash Flow Qtr", "cashflow", "quarterly"],
];

const PER_SHARE = new Set(["basicEPS", "dilutedEPS"]);

/** FA: financial statements, annual and quarterly. */
export function FaScreen({ panel, security }: ScreenProps) {
  const view = useOptions(panel, FA_VIEWS.length, 0);
  const [, statement, period] = FA_VIEWS[view];
  const state = useData(`fa|${security}|${statement}|${period}`, (s) => api.financials(security!, statement, period, s));
  const fs = state.data;
  return (
    <div className="col-flex" data-testid="fa-screen">
      <OptionBar panel={panel} labels={FA_VIEWS.map(([l]) => l)} selected={view} extra={fs ? `${fs.source} · reported currency` : undefined} />
      {fs ? (
        <DataTable
          panel={panel}
          rows={fs.rows}
          columns={[
            { key: "label", label: "Item", render: (r) => <span className="white">{r.label}</span> },
            ...fs.columns.map((date, i) => ({
              key: date,
              label: period === "annual" ? `FY ${fmtIsoDate(date)}` : fmtIsoDate(date),
              align: "right" as const,
              render: (r: (typeof fs.rows)[number]) => {
                const v = r.values[i];
                return <span className={v !== null && v < 0 ? "down" : ""}>{PER_SHARE.has(r.key) ? fmtNum(v) : fmtBig(v)}</span>;
              },
            })),
          ]}
        />
      ) : (
        <DataState state={state} what="FINANCIALS" />
      )}
    </div>
  );
}

/** EE: consensus earnings and revenue estimates. */
export function EeScreen({ panel, security }: ScreenProps) {
  const state = useData(`earnings|${security}`, (s) => api.earnings(security!, s));
  const e = state.data;
  if (!e) return <DataState state={state} what="ESTIMATES" />;
  return (
    <div className="col-flex" data-testid="ee-screen">
      <Section title="Earnings & Estimates" right={`Next report ${fmtIsoDate(e.nextDate)} · ${e.source}`} />
      <DataTable
        panel={panel}
        rows={e.estimates}
        columns={[
          { key: "p", label: "Period", render: (r) => <span className="white">{r.period}</span> },
          { key: "end", label: "Ending", render: (r) => fmtIsoDate(r.endDate) },
          { key: "eps", label: "EPS Est", align: "right", render: (r) => fmtNum(r.epsAvg) },
          { key: "lo", label: "Low", align: "right", render: (r) => fmtNum(r.epsLow) },
          { key: "hi", label: "High", align: "right", render: (r) => fmtNum(r.epsHigh) },
          { key: "ya", label: "Yr Ago", align: "right", render: (r) => fmtNum(r.epsYearAgo) },
          { key: "g", label: "EPS Gr", align: "right", render: (r) => <Change value={r.epsGrowthPct} pct /> },
          { key: "rev", label: "Rev Est", align: "right", render: (r) => fmtBig(r.revenueAvg) },
          { key: "rg", label: "Rev Gr", align: "right", render: (r) => <Change value={r.revenueGrowthPct} pct /> },
          { key: "n", label: "#Est", align: "right", render: (r) => r.analysts ?? "--" },
        ]}
      />
    </div>
  );
}

/** ERN: reported earnings versus estimates, and annual results. */
export function ErnScreen({ panel, security }: ScreenProps) {
  const state = useData(`earnings|${security}`, (s) => api.earnings(security!, s));
  const e = state.data;
  if (!e) return <DataState state={state} what="EARNINGS" />;
  return (
    <div className="col-flex" data-testid="ern-screen">
      <Section title="Quarterly EPS: Actual vs Estimate" right={e.source}>
        <DataTable
          rows={[...e.history].reverse()}
          paged={false}
          columns={[
            { key: "q", label: "Quarter End", render: (r) => <span className="white">{fmtIsoDate(r.quarter)}</span> },
            { key: "est", label: "Estimate", align: "right", render: (r) => fmtNum(r.estimate) },
            { key: "act", label: "Actual", align: "right", render: (r) => fmtNum(r.actual) },
            { key: "s", label: "Surprise", align: "right", render: (r) => <Change value={r.surprisePct} pct /> },
          ]}
        />
      </Section>
      <Section title="Annual Results">
        <DataTable
          panel={panel}
          rows={[...e.annual].reverse()}
          columns={[
            { key: "y", label: "Fiscal Year", render: (r) => <span className="white">{r.year}</span> },
            { key: "rev", label: "Revenue", align: "right", render: (r) => fmtBig(r.revenue) },
            { key: "earn", label: "Net Income", align: "right", render: (r) => fmtBig(r.earnings) },
            {
              key: "m",
              label: "Margin",
              align: "right",
              render: (r) => (r.revenue && r.earnings !== null ? fmtPct((r.earnings / r.revenue) * 100) : "--"),
            },
          ]}
        />
      </Section>
    </div>
  );
}

const REC_SCALE = "1 Strong Buy · 2 Buy · 3 Hold · 4 Sell · 5 Strong Sell";

/** ANR: analyst recommendations, price targets and rating changes. */
export function AnrScreen({ panel, security }: ScreenProps) {
  const state = useData(`anr|${security}`, (s) => api.analysts(security!, s));
  const a = state.data;
  if (!a) return <DataState state={state} what="ANALYST DATA" />;
  const upside = (t: number | null) => (t !== null && a.currentPrice ? ((t / a.currentPrice - 1) * 100) : null);
  return (
    <div className="col-flex" data-testid="anr-screen">
      <div className="two-col fixed">
        <Section title="Consensus" right={a.source}>
          <KeyValues
            columns={1}
            items={[
              ["Rating", a.recommendation ? a.recommendation.toUpperCase().replace("_", " ") : "--"],
              ["Mean (1-5)", fmtNum(a.recommendationMean)],
              ["Analysts", a.analystCount ?? "--"],
              ["Price", fmtNum(a.currentPrice)],
            ]}
          />
          <div className="gray note-line">{REC_SCALE}</div>
        </Section>
        <Section title="12M Price Target">
          <KeyValues
            columns={1}
            items={[
              ["Mean", <>{fmtNum(a.targetMean)} <Change value={upside(a.targetMean)} pct /></>],
              ["Median", <>{fmtNum(a.targetMedian)} <Change value={upside(a.targetMedian)} pct /></>],
              ["High", <>{fmtNum(a.targetHigh)} <Change value={upside(a.targetHigh)} pct /></>],
              ["Low", <>{fmtNum(a.targetLow)} <Change value={upside(a.targetLow)} pct /></>],
            ]}
          />
        </Section>
      </div>
      <Section title="Recommendation Trend">
        <DataTable
          rows={a.trend}
          paged={false}
          columns={[
            { key: "p", label: "Period", render: (r) => <span className="white">{r.period}</span> },
            { key: "sb", label: "Strong Buy", align: "right", render: (r) => <span className="up">{r.strongBuy}</span> },
            { key: "b", label: "Buy", align: "right", render: (r) => <span className="up">{r.buy}</span> },
            { key: "h", label: "Hold", align: "right", render: (r) => r.hold },
            { key: "s", label: "Sell", align: "right", render: (r) => <span className="down">{r.sell}</span> },
            { key: "ss", label: "Strong Sell", align: "right", render: (r) => <span className="down">{r.strongSell}</span> },
          ]}
        />
      </Section>
      <Section title="Rating Changes" />
      <DataTable
        panel={panel}
        rows={a.actions}
        columns={[
          { key: "d", label: "Date", render: (r) => fmtIsoDate(r.date) },
          { key: "f", label: "Firm", render: (r) => <span className="white">{r.firm}</span> },
          { key: "a", label: "Action", render: (r) => <span className={r.action === "Upgrade" ? "up" : r.action === "Downgrade" ? "down" : ""}>{r.action}</span> },
          { key: "g", label: "Rating", render: (r) => (r.fromGrade && r.fromGrade !== r.toGrade ? `${r.fromGrade} -> ${r.toGrade ?? "--"}` : (r.toGrade ?? "--")) },
          { key: "t", label: "Target", align: "right", render: (r) => (r.priorTarget && r.priorTarget !== r.target ? `${fmtNum(r.priorTarget)} -> ${fmtNum(r.target)}` : fmtNum(r.target)) },
        ]}
      />
    </div>
  );
}

const HDS_VIEWS = ["Institutions", "Funds", "Insiders"];

/** HDS: institutional, fund and insider holders. */
export function HdsScreen({ panel, security }: ScreenProps) {
  const view = useOptions(panel, HDS_VIEWS.length, 0);
  const state = useData(`hds|${security}`, (s) => api.holders(security!, s));
  const h = state.data;
  if (!h) return <DataState state={state} what="HOLDERS" />;
  const holdings = view === 0 ? h.institutions : h.funds;
  return (
    <div className="col-flex" data-testid="hds-screen">
      <KeyValues
        columns={4}
        items={[
          ["Institutions", fmtPct(h.institutionsPct)],
          ["Inst. of Float", fmtPct(h.institutionsFloatPct)],
          ["Insiders", fmtPct(h.insidersPct)],
          ["# Institutions", h.institutionCount !== null ? fmtInt(h.institutionCount) : "--"],
        ]}
      />
      <OptionBar panel={panel} labels={HDS_VIEWS} selected={view} extra={h.source} />
      {view < 2 ? (
        <DataTable
          panel={panel}
          rows={holdings}
          columns={[
            { key: "n", label: "Holder", render: (r) => <span className="white">{r.name}</span> },
            { key: "pct", label: "% Out", align: "right", render: (r) => fmtPct(r.heldPct) },
            { key: "sh", label: "Shares", align: "right", render: (r) => fmtBig(r.shares) },
            { key: "v", label: "Value", align: "right", render: (r) => fmtBig(r.value) },
            { key: "c", label: "Chg", align: "right", render: (r) => <Change value={r.changePct} pct /> },
            { key: "d", label: "As Of", align: "right", render: (r) => fmtIsoDate(r.reportDate) },
          ]}
        />
      ) : (
        <DataTable
          panel={panel}
          rows={h.insiders}
          columns={[
            { key: "n", label: "Insider", render: (r) => <span className="white">{r.name}</span> },
            { key: "r", label: "Relation", render: (r) => r.relation ?? "--" },
            { key: "sh", label: "Shares", align: "right", render: (r) => fmtBig(r.shares) },
            { key: "t", label: "Last Transaction", render: (r) => r.lastTransaction ?? "--" },
            { key: "d", label: "Date", align: "right", render: (r) => fmtIsoDate(r.date) },
          ]}
        />
      )}
    </div>
  );
}

/** DVD: dividend and split history. */
export function DvdScreen({ panel, security }: ScreenProps) {
  const state = useData(`dvd|${security}`, (s) => api.events(security!, s));
  const e = state.data;
  if (!e) return <DataState state={state} what="DIVIDEND DATA" />;
  const dividends = [...e.dividends].reverse();
  return (
    <div className="col-flex" data-testid="dvd-screen">
      <KeyValues
        columns={3}
        items={[
          ["Annual Rate", fmtNum(e.dividendRate)],
          ["Yield", fmtPct(e.dividendYieldPct)],
          ["Payout Ratio", fmtPct(e.payoutRatioPct)],
          ["Last Ex-Date", fmtIsoDate(e.exDividendDate)],
          ["Pay Date", fmtIsoDate(e.payDate)],
          ["Splits", e.splits.length ? e.splits.map((s) => `${s.ratio} (${fmtIsoDate(s.date)})`).join(", ") : "None"],
        ]}
      />
      <Section title="Dividend History" right={`${e.source}${e.currency ? ` · ${e.currency}` : ""}`} />
      {dividends.length ? (
        <DataTable
          panel={panel}
          rows={dividends}
          columns={[
            { key: "d", label: "Ex-Date", render: (r) => <span className="white">{fmtIsoDate(r.date)}</span> },
            { key: "a", label: "Amount", align: "right", render: (r) => fmtNum(r.amount, 4) },
            {
              key: "c",
              label: "Chg vs Prior",
              align: "right",
              render: (r, i) => {
                const prior = dividends[i + 1];
                return prior ? <Change value={((r.amount / prior.amount - 1) * 100)} pct /> : "--";
              },
            },
          ]}
        />
      ) : (
        <div className="gray">NO DIVIDENDS PAID IN THE AVAILABLE HISTORY</div>
      )}
    </div>
  );
}

function median(values: (number | null)[]): number | null {
  const v = values.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** RV: relative valuation against peers suggested by the data provider. */
export function RvScreen({ panel, security }: ScreenProps) {
  const peers = useData(`related|${security}`, (s) => api.related(security!, s));
  const list = peers.data ? [security!, ...peers.data.filter((p) => p !== security)].slice(0, 12) : null;
  const vals = useData(list ? `val|${list.join(",")}` : null, (s) => api.valuations(list!, s), 60_000);
  if (!peers.data) return <DataState state={peers} what="PEERS" />;
  if (!vals.data) return <DataState state={vals} what="VALUATIONS" />;
  const rows: (Valuation & { median?: boolean })[] = [
    ...vals.data,
    {
      security: "Peer Median",
      name: "",
      currency: null,
      last: null,
      changePct: median(vals.data.map((v) => v.changePct)),
      marketCap: median(vals.data.map((v) => v.marketCap)),
      pe: median(vals.data.map((v) => v.pe)),
      forwardPe: median(vals.data.map((v) => v.forwardPe)),
      priceToBook: median(vals.data.map((v) => v.priceToBook)),
      eps: null,
      dividendYieldPct: median(vals.data.map((v) => v.dividendYieldPct)),
      median: true,
    },
  ];
  return (
    <div className="col-flex" data-testid="rv-screen">
      <Section title="Relative Valuation" right="Peers from provider recommendations · click to load" />
      <DataTable
        panel={panel}
        rows={rows}
        rowClass={(r) => (r.security === security ? "highlight" : r.median ? "summary" : "")}
        onRowClick={(r) => !r.median && loadInPanel(panel.id, r.security)}
        columns={[
          { key: "s", label: "Security", render: (r) => <span className="menu-code">{r.security}</span> },
          { key: "n", label: "Name", render: (r) => <span className="white ellipsis">{r.name}</span> },
          { key: "l", label: "Last", align: "right", render: (r) => fmtNum(r.last) },
          { key: "c", label: "%Chg", align: "right", render: (r) => <Change value={r.changePct} pct /> },
          { key: "mc", label: "Mkt Cap", align: "right", render: (r) => fmtBig(r.marketCap) },
          { key: "pe", label: "P/E", align: "right", render: (r) => fmtNum(r.pe) },
          { key: "fpe", label: "Fwd P/E", align: "right", render: (r) => fmtNum(r.forwardPe) },
          { key: "pb", label: "P/B", align: "right", render: (r) => fmtNum(r.priceToBook) },
          { key: "eps", label: "EPS", align: "right", render: (r) => fmtNum(r.eps) },
          { key: "dy", label: "Div Yld", align: "right", render: (r) => fmtPct(r.dividendYieldPct) },
        ]}
      />
    </div>
  );
}

/** RELS: other listings of the same issuer. */
export function RelsScreen({ panel, security }: ScreenProps) {
  const state = useData(`rels|${security}`, (s) => api.listings(security!, s));
  if (!state.data) return <DataState state={state} what="RELATED SECURITIES" />;
  return (
    <div className="col-flex" data-testid="rels-screen">
      <Section title="Listings of the Same Issuer" right="Click to load" />
      <DataTable
        panel={panel}
        rows={state.data}
        rowClass={(r) => (r.security === security ? "highlight" : "")}
        onRowClick={(r) => loadInPanel(panel.id, r.security)}
        columns={[
          { key: "s", label: "Security", render: (r) => <span className="menu-code">{r.security}</span> },
          { key: "n", label: "Name", render: (r) => <span className="white">{r.name}</span> },
          { key: "e", label: "Exchange", render: (r) => r.exchange ?? "--" },
        ]}
      />
    </div>
  );
}
