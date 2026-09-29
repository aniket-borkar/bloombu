import { useMemo } from "react";
import type { MemberRow } from "../../../server/src/types";
import { api, useData } from "../api";
import { fmtBig, fmtNum } from "../terminal/format";
import { Change, DataState, DataTable, OptionBar, Section, loadInPanel, openLink, useOptions, type ScreenProps } from "./common";

const VIEWS = ["By Weight", "Movers", "Point Contributors", "Sectors"];

const SORTS: ((a: MemberRow, b: MemberRow) => number)[] = [
  (a, b) => (b.weightPct ?? -1) - (a.weightPct ?? -1),
  (a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity),
  (a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity),
];

/** MEMB: index members with estimated weights and each member's contribution to today's index move. */
export function MembScreen({ panel, security }: ScreenProps) {
  const view = useOptions(panel, VIEWS.length);
  const state = useData(`memb|${security}`, (s) => api.members(security!, s), 60_000);
  const d = state.data;
  const rows = useMemo(() => (d && view < 3 ? [...d.members].sort(SORTS[view]) : []), [d, view]);

  if (!d) return <DataState state={state} what="MEMBERS" />;
  const weightNote =
    d.weighting === "price" ? "price-weighted, like the index" : "weights estimated from full market cap; index providers also apply free-float and capping rules";
  return (
    <div className="col-flex" data-testid="memb-screen">
      <OptionBar panel={panel} labels={VIEWS} selected={view} />
      <Section
        title={`${d.name} · ${d.total} members`}
        right={
          <>
            {fmtNum(d.level, 2)} <Change value={d.change} /> <Change value={d.changePct} pct /> · <span className="up">{d.advancers}▲</span>{" "}
            <span className="down">{d.decliners}▼</span> · {d.priced}/{d.total} priced
          </>
        }
      />
      {view < 3 ? (
        <DataTable
          panel={panel}
          testId="memb-table"
          rows={rows}
          onRowClick={(r) => loadInPanel(panel.id, r.security)}
          columns={[
            { key: "n", label: "#", align: "right", width: "4ch", render: (_, i) => i + 1 },
            { key: "security", label: "Security", render: (r) => r.security },
            { key: "name", label: "Name", render: (r) => r.name },
            { key: "sector", label: "Sector", render: (r) => r.sector ?? "--" },
            { key: "last", label: "Last", align: "right", render: (r) => fmtNum(r.last, 2) },
            { key: "chg", label: "Chg %", align: "right", render: (r) => <Change value={r.changePct} pct /> },
            ...(d.weighting === "cap" ? [{ key: "cap", label: "Mkt Cap", align: "right" as const, render: (r: MemberRow) => fmtBig(r.marketCap) }] : []),
            { key: "weight", label: "Weight %", align: "right", render: (r) => fmtNum(r.weightPct, 2) },
            { key: "points", label: "Index Pts", align: "right", render: (r) => <Change value={r.points} /> },
          ]}
        />
      ) : (
        <DataTable
          panel={panel}
          testId="memb-sectors"
          rows={d.sectors}
          columns={[
            { key: "sector", label: "Sector", render: (s) => s.sector },
            { key: "count", label: "Members", align: "right", render: (s) => s.count },
            { key: "weight", label: "Weight %", align: "right", render: (s) => fmtNum(s.weightPct, 2) },
            { key: "points", label: "Index Pts", align: "right", render: (s) => <Change value={s.points} /> },
          ]}
        />
      )}
      <div className="screen-note">
        Members:{" "}
        {d.sourceUrl ? (
          <a href={d.sourceUrl} onClick={(e) => (e.preventDefault(), openLink(d.sourceUrl))}>
            {d.source}
          </a>
        ) : (
          d.source
        )}
        ; {weightNote}.
      </div>
    </div>
  );
}
