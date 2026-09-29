import { useLayoutEffect, useMemo } from "react";
import { api, fetchHistory, useData, useQuote, type Headline } from "../api";
import { PriceChart } from "../components/PriceChart";
import { usePanels } from "../store/panels";
import { decimalsFor, fmtBig, fmtInt, fmtIsoDate, fmtIsoDateTime, fmtNum, fmtPct } from "../terminal/format";
import { sectorOf } from "../terminal/sectors";
import { DataState, DataTable, KeyValues, OptionBar, Section, openLink, useOptions, type ScreenProps } from "./common";

/** DES: company description and key statistics (quote-based for non-equities). */
export function DesScreen({ security }: ScreenProps) {
  const state = useData(`profile|${security}`, (s) => api.profile(security!, s));
  const p = state.data;
  if (!p) return <DataState state={state} what="DESCRIPTION" />;
  const d = decimalsFor(sectorOf(security), p.high52);
  return (
    <div className="two-col" data-testid="des-screen">
      <Section title={p.name} right={p.source}>
        {p.summary ? (
          <p className="prose">{p.summary}</p>
        ) : (
          <p className="gray">No business description is provided for this security type.</p>
        )}
        <KeyValues
          columns={1}
          items={[
            ["Sector", p.sector ?? "--"],
            ["Industry", p.industry ?? "--"],
            ["Exchange", p.exchange ?? "--"],
            ["Currency", p.currency ?? "--"],
            ["Employees", p.employees !== null ? fmtInt(p.employees) : "--"],
            ["Location", p.address ?? "--"],
            ["Website", p.website ?? "--"],
          ]}
        />
      </Section>
      <Section title="Key Statistics">
        <KeyValues
          columns={1}
          items={[
            ["Market Cap", fmtBig(p.marketCap)],
            ["Enterprise Value", fmtBig(p.enterpriseValue)],
            ["Shares Outstanding", fmtBig(p.sharesOutstanding)],
            ["Float", fmtBig(p.floatShares)],
            ["P/E (TTM)", fmtNum(p.pe)],
            ["P/E (Forward)", fmtNum(p.forwardPe)],
            ["EPS (TTM)", fmtNum(p.eps)],
            ["Price/Book", fmtNum(p.priceToBook)],
            ["Beta", fmtNum(p.beta)],
            ["Dividend (Ann.)", fmtNum(p.dividendRate)],
            ["Dividend Yield", fmtPct(p.dividendYieldPct)],
            ["Ex-Dividend", fmtIsoDate(p.exDividendDate)],
            ["52W High", fmtNum(p.high52, d)],
            ["52W Low", fmtNum(p.low52, d)],
            ["Avg Volume", fmtBig(p.avgVolume)],
            ["Short % Float", fmtPct(p.shortFloatPct)],
            ["Next Earnings", fmtIsoDate(p.nextEarnings)],
          ]}
        />
      </Section>
    </div>
  );
}

/** MGMT: company officers. */
export function MgmtScreen({ panel, security }: ScreenProps) {
  const state = useData(`profile|${security}`, (s) => api.profile(security!, s));
  const officers = state.data?.officers ?? [];
  if (!state.data) return <DataState state={state} what="MANAGEMENT" />;
  if (!officers.length) return <div className="error-box">NO MANAGEMENT DATA FOR THIS SECURITY</div>;
  return (
    <Section title="Management" right={state.data.source}>
      <DataTable
        panel={panel}
        rows={officers}
        columns={[
          { key: "name", label: "Name", render: (o) => <span className="white">{o.name}</span> },
          { key: "title", label: "Title", render: (o) => o.title },
          { key: "age", label: "Age", align: "right", render: (o) => o.age ?? "--" },
          { key: "pay", label: "Total Pay", align: "right", render: (o) => fmtBig(o.totalPay) },
        ]}
      />
    </Section>
  );
}

/** BQ: composite quote with intraday chart, key statistics and headlines. */
export function BqScreen({ panel, security }: ScreenProps) {
  const { data: quote } = useQuote(security);
  const hist = useData(`bq-hist|${security}`, (s) => fetchHistory(security!, "5m", "1d", s), 60_000);
  const profile = useData(`profile|${security}`, (s) => api.profile(security!, s));
  const news = useData(`cn|${security}`, (s) => api.companyNews(security!, s), 300_000);
  const d = decimalsFor(sectorOf(security), quote?.last ?? null);
  const p = profile.data;
  return (
    <div className="two-col bq" data-testid="bq-screen">
      <div className="col-flex">
        <Section title="Intraday" right={hist.data ? `${hist.data.bars.length} bars` : undefined} />
        <div className="chart-area">
          {hist.data ? (
            <PriceChart bars={hist.data.bars} intraday decimals={d} onHover={() => {}} />
          ) : (
            <DataState state={hist} what="INTRADAY HISTORY" />
          )}
        </div>
      </div>
      <div className="col-flex">
        <Section title="Quote">
          <KeyValues
            items={[
              ["Last", fmtNum(quote?.last ?? null, d)],
              ["Bid / Ask", quote ? `${fmtNum(quote.bid, d)} / ${fmtNum(quote.ask, d)}` : "--"],
              ["Open", fmtNum(quote?.open ?? null, d)],
              ["Prev Close", fmtNum(quote?.prevClose ?? null, d)],
              ["Day High", fmtNum(quote?.high ?? null, d)],
              ["Day Low", fmtNum(quote?.low ?? null, d)],
              ["Volume", fmtBig(quote?.volume ?? null)],
              ["Avg Volume", fmtBig(p?.avgVolume)],
              ["52W High", fmtNum(p?.high52 ?? null, d)],
              ["52W Low", fmtNum(p?.low52 ?? null, d)],
              ["Market Cap", fmtBig(p?.marketCap)],
              ["P/E", fmtNum(p?.pe ?? null)],
              ["Div Yield", fmtPct(p?.dividendYieldPct)],
              ["Beta", fmtNum(p?.beta ?? null)],
            ]}
          />
        </Section>
        <Section title="Headlines">
          {news.data ? (
            <HeadlineList panel={panel} items={news.data.slice(0, 6)} paged={false} />
          ) : (
            <DataState state={news} what="NEWS" />
          )}
        </Section>
      </div>
    </div>
  );
}

function HeadlineList({ panel, items, paged = true }: { panel: ScreenProps["panel"]; items: Headline[]; paged?: boolean }) {
  return (
    <DataTable
      panel={paged ? panel : undefined}
      paged={paged}
      rows={items}
      testId="headlines"
      onRowClick={(h) => openLink(h.url)}
      columns={[
        { key: "n", label: "#", width: "3ch", render: (_h, i) => <span className="menu-code">{i + 1})</span> },
        { key: "time", label: "Time", width: "12ch", render: (h) => <span className="gray">{fmtIsoDateTime(h.time)}</span> },
        { key: "title", label: "Headline", render: (h) => <span className="white">{h.title}</span> },
        { key: "src", label: "Source", width: "18ch", render: (h) => <span className="gray">{h.source}</span> },
      ]}
    />
  );
}

/** Numbered headlines: `<n> <GO>` opens story n. */
function NewsList({ panel, state, what }: { panel: ScreenProps["panel"]; state: ReturnType<typeof useData<Headline[]>>; what: string }) {
  const items = state.data ?? [];
  useOptions(panel, items.length);
  const opened = panel.option;

  useLayoutEffect(() => {
    if (opened === null) return;
    openLink(items[opened]?.url ?? null);
    usePanels.getState().setOption(panel.id, null);
  }, [opened]);

  if (!state.data) return <DataState state={state} what={what} />;
  return (
    <>
      <div className="gray note-line">Type a headline number and press &lt;GO&gt; (or click) to open the story.</div>
      <HeadlineList panel={panel} items={items} />
    </>
  );
}

/** CN: company news. */
export function CnScreen({ panel, security }: ScreenProps) {
  const state = useData(`cn|${security}`, (s) => api.companyNews(security!, s), 300_000);
  return (
    <div className="col-flex" data-testid="news-screen">
      <NewsList panel={panel} state={state} what="COMPANY NEWS" />
    </div>
  );
}

/** TOP: top news from the provider's main feed. */
export function TopScreen({ panel }: ScreenProps) {
  const state = useData("top-news", (s) => api.topNews(s), 300_000);
  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    for (const h of state.data ?? []) counts.set(h.source, (counts.get(h.source) ?? 0) + 1);
    return ["All", ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 8)];
  }, [state.data]);
  const pick = useOptions(panel, sources.length, 0);
  const items = state.data && pick > 0 ? state.data.filter((h) => h.source === sources[pick]) : state.data;
  return (
    <div className="col-flex" data-testid="news-screen">
      <OptionBar panel={panel} labels={sources} selected={pick} extra={items ? `${items.length} stories` : undefined} testId="top-sources" />
      {items ? <HeadlineList panel={panel} items={items} /> : <DataState state={state} what="TOP NEWS" />}
    </div>
  );
}

const NEWS_TOPICS: [string, string][] = [
  ["Markets", "stock market"],
  ["Economy", "economy"],
  ["Rates", "interest rates Federal Reserve"],
  ["Technology", "technology stocks"],
  ["Energy", "oil energy"],
  ["Crypto", "bitcoin crypto"],
  ["Earnings", "earnings"],
  ["FX", "currency dollar"],
];

/** N: news by topic. The option bar selects the topic; stories open from the list. */
export function NScreen({ panel }: ScreenProps) {
  const topic = useOptions(panel, NEWS_TOPICS.length, 0);
  const [label, query] = NEWS_TOPICS[topic];
  const state = useData(`news|${query}`, (s) => api.news(query, s), 300_000);
  return (
    <div className="col-flex" data-testid="news-screen">
      <OptionBar panel={panel} labels={NEWS_TOPICS.map(([l]) => l)} selected={topic} extra={`${label} news`} />
      {state.data ? <HeadlineList panel={panel} items={state.data} /> : <DataState state={state} what="NEWS" />}
      <div className="gray note-line">Click a headline to open the story.</div>
    </div>
  );
}
