import { useMemo } from "react";
import { api, useData } from "../api";
import { CompareChart, type CompareSeries } from "../components/CompareChart";
import { fmtIsoDate, fmtNum } from "../terminal/format";
import { DataState, DataTable, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

const VIEWS = ["Meetings", "Futures Strip"];
const signed = (v: number | null, d = 1) => (v === null ? "--" : `${v > 0 ? "+" : ""}${fmtNum(v, d)}`);

/** WIRP: FOMC meeting-by-meeting rate expectations implied by fed funds futures. */
export function WirpScreen({ panel }: ScreenProps) {
  const view = useOptions(panel, VIEWS.length);
  const state = useData("wirp", (s) => api.wirp(s), 60_000);
  const d = state.data;
  const series = useMemo<CompareSeries[]>(
    () =>
      d
        ? [
            { label: "After meeting", color: "#ffa028", points: d.meetings.map((m) => ({ t: Date.parse(m.date), v: m.impliedRatePct })) },
            { label: "Monthly avg", color: "#4d9bff", points: d.months.map((m, i) => ({ t: Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + i, 15), v: m.impliedRatePct })) },
          ]
        : [],
    [d],
  );

  if (!d) return <DataState state={state} what="RATE EXPECTATIONS" />;
  const range = d.targetLow !== null && d.targetHigh !== null ? `${fmtNum(d.targetLow, 2)}–${fmtNum(d.targetHigh, 2)}%` : "--";
  return (
    <div className="col-flex" data-testid="wirp-screen">
      <OptionBar panel={panel} labels={VIEWS} selected={view} extra={`Target ${range} · EFFR ${fmtNum(d.currentRatePct, 2)}%`} />
      {view === 0 ? (
        <>
          <Section title="United States · Federal Reserve" right="* = projections meeting" />
          <DataTable
            panel={panel}
            paged={false}
            testId="wirp-meetings"
            rows={d.meetings}
            onRowClick={(m) => m.contract && loadInPanel(panel.id, m.contract, "DES")}
            columns={[
              { key: "date", label: "Meeting", render: (m) => `${fmtIsoDate(m.date)}${m.sep ? "*" : ""}` },
              { key: "moves", label: "#Hikes/Cuts", align: "right", render: (m) => signed(m.movesPriced, 2) },
              {
                key: "prob",
                label: "% Hike/Cut",
                align: "right",
                render: (m) =>
                  m.probabilityPct === null ? "--" : <span className={m.direction === "hike" ? "up" : m.direction === "cut" ? "down" : ""}>{`${fmtNum(m.probabilityPct, 1)}%${m.direction && m.direction !== "hold" ? ` ${m.direction}` : ""}`}</span>,
              },
              { key: "step", label: "Step (bp)", align: "right", render: (m) => signed(m.stepBp) },
              { key: "cum", label: "Cum. (bp)", align: "right", render: (m) => signed(m.cumulativeBp) },
              { key: "rate", label: "Implied Rate", align: "right", render: (m) => (m.impliedRatePct === null ? "--" : `${fmtNum(m.impliedRatePct, 3)}%`) },
              { key: "contract", label: "Contract", render: (m) => m.contract ?? "--" },
            ]}
          />
          <div className="chart-area">
            <CompareChart series={series} unit="number" testId="wirp-chart" />
          </div>
        </>
      ) : (
        <DataTable
          panel={panel}
          testId="wirp-strip"
          rows={d.months}
          onRowClick={(m) => loadInPanel(panel.id, m.contract, "DES")}
          columns={[
            { key: "month", label: "Month", render: (m) => m.month },
            { key: "contract", label: "Contract", render: (m) => m.contract },
            { key: "price", label: "Price", align: "right", render: (m) => fmtNum(m.price, 3) },
            { key: "rate", label: "Implied Avg Rate", align: "right", render: (m) => (m.impliedRatePct === null ? "--" : `${fmtNum(m.impliedRatePct, 3)}%`) },
          ]}
        />
      )}
      <div className="screen-note">
        Method: each contract settles on the month&apos;s average effective rate; rates before and after each meeting are solved meeting by meeting (as CME
        FedWatch does). Probabilities assume 25bp moves. Futures prices may be delayed.
      </div>
    </div>
  );
}
