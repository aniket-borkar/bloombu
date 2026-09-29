import type { ScreenRow } from "../../../server/src/types";
import { api, useData } from "../api";
import { setPendingQuestion } from "../ai";
import { usePanels } from "../store/panels";
import { rememberPortfolio } from "../terminal/portfolioState";
import { fmtBig, fmtIsoDate, fmtIsoDateTime, fmtNum } from "../terminal/format";
import { Change, DataState, DataTable, Section, loadInPanel, openLink, type ScreenProps } from "./common";

const SUMMARY_QUESTION =
  "Give me a concise morning briefing: the biggest market moves today, how my portfolios are doing, what rates are pricing for the next Fed meeting, and the most important headlines.";

/** BRIEF: a personalized one-screen briefing of markets, your portfolios, alerts, rates and news. */
export function BriefScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const state = useData(`brief|${user}`, (s) => api.brief(user, s), 60_000);
  const d = state.data;
  if (!d) return <DataState state={state} what="BRIEFING" />;

  const execute = (fn: string) => usePanels.getState().execute(panel.id, { kind: "function", fn });
  const movers = (title: string, rows: ScreenRow[], testId: string) => (
    <div className="col-flex">
      <Section title={title} />
      <DataTable
        paged={false}
        testId={testId}
        rows={rows}
        onRowClick={(r) => loadInPanel(panel.id, r.security)}
        columns={[
          { key: "s", label: "Security", render: (r) => r.security },
          { key: "l", label: "Last", align: "right", render: (r) => fmtNum(r.last, 2) },
          { key: "c", label: "Chg %", align: "right", render: (r) => <Change value={r.changePct} pct /> },
        ]}
      />
    </div>
  );

  return (
    <div className="col-flex" data-testid="brief-screen">
      <Section
        title={`Briefing for ${user} · ${fmtIsoDateTime(d.asOf)}`}
        right={
          <button
            className="tool-button primary"
            data-testid="brief-ai"
            onClick={() => {
              setPendingQuestion(panel.id, SUMMARY_QUESTION);
              execute("ASK");
            }}
          >
            AI summary
          </button>
        }
      />
      <div className="brief-grid">
        <div className="col-flex">
          <Section title="Markets" />
          <DataTable
            paged={false}
            testId="brief-markets"
            rows={d.markets}
            onRowClick={(r) => loadInPanel(panel.id, r.security)}
            columns={[
              { key: "n", label: "Market", render: (r) => r.name || r.security },
              { key: "l", label: "Last", align: "right", render: (r) => fmtNum(r.last, 2) },
              { key: "p", label: "Chg %", align: "right", render: (r) => <Change value={r.changePct} pct /> },
            ]}
          />
        </div>
        <div className="col-flex">
          {movers("Top Gainers", d.gainers, "brief-gainers")}
          {movers("Top Losers", d.losers, "brief-losers")}
        </div>
      </div>
      <Section title="Your Portfolios" right={d.portfolios.length ? "Click to open in PORT" : undefined} />
      {d.portfolios.length ? (
        <DataTable
          paged={false}
          testId="brief-portfolios"
          rows={d.portfolios}
          onRowClick={(p) => {
            rememberPortfolio(user, p.id);
            execute("PORT");
          }}
          columns={[
            { key: "n", label: "Portfolio", render: (p) => p.name },
            { key: "v", label: "Value", align: "right", render: (p) => `${fmtBig(p.marketValue)} ${p.baseCurrency}` },
            { key: "d", label: "Day P&L", align: "right", render: (p) => <Change value={p.dayPnl} /> },
            { key: "dp", label: "Day %", align: "right", render: (p) => <Change value={p.dayPct} pct /> },
            { key: "b", label: "Best", render: (p) => (p.best ? `${p.best.security} ${fmtNum(p.best.dayPnl, 0)}` : "--") },
            { key: "w", label: "Worst", render: (p) => (p.worst ? `${p.worst.security} ${fmtNum(p.worst.dayPnl, 0)}` : "--") },
          ]}
        />
      ) : (
        <div className="gray">No portfolios yet. PRTU &lt;GO&gt; to create one, or TRADE &lt;GO&gt; to start a paper account.</div>
      )}
      <Section title="Rates & Alerts" />
      <div className="kv" style={{ gridTemplateColumns: "repeat(3, minmax(0, 1fr))" }}>
        <div className="kv-item">
          <span className="label">Next FOMC</span>
          <span className="white">
            {d.nextFomc ? `${fmtIsoDate(d.nextFomc.date)} · ${d.nextFomc.impliedChangeBp === null ? "--" : `${d.nextFomc.impliedChangeBp > 0 ? "+" : ""}${fmtNum(d.nextFomc.impliedChangeBp, 1)}bp priced`}` : "--"}
          </span>
        </div>
        <div className="kv-item">
          <span className="label">UST 2s10s</span>
          <span className="white">{d.curve?.spreadBp !== null && d.curve?.spreadBp !== undefined ? `${fmtNum(d.curve.spreadBp, 1)}bp (10Y ${fmtNum(d.curve.tenYear, 3)}%)` : "--"}</span>
        </div>
        <div className="kv-item">
          <span className="label">Alerts</span>
          <span className="white">
            {d.alerts.active} active · {d.alerts.triggeredToday.length} triggered today
          </span>
        </div>
      </div>
      {d.alerts.triggeredToday.map((a) => (
        <div key={`${a.security}-${a.at}`} className="yellow">
          {fmtIsoDateTime(new Date(a.at).toISOString())} {a.description}
        </div>
      ))}
      <Section title="Headlines" right="TOP <GO> for more" />
      <DataTable
        paged={false}
        testId="brief-headlines"
        rows={d.headlines}
        onRowClick={(h) => openLink(h.url)}
        columns={[
          { key: "t", label: "Time", render: (h) => fmtIsoDateTime(h.time) },
          { key: "s", label: "Source", render: (h) => h.source },
          { key: "h", label: "Headline", render: (h) => <span className="white">{h.title}</span> },
        ]}
      />
    </div>
  );
}
