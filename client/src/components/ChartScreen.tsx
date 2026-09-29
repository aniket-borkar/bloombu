import { useEffect, useState } from "react";
import { ApiError, fetchHistory, usePolling, type Bar } from "../api";
import { usePanels, type PanelState } from "../store/panels";
import { CHART_OPTIONS } from "../terminal/functions";
import { decimalsFor, direction, fmtBarTime, fmtInt, fmtNum, fmtSigned } from "../terminal/format";
import { sectorOf } from "../terminal/sectors";
import { PriceChart } from "./PriceChart";

interface Props {
  panel: PanelState;
  security: string;
  fn: string;
}

function RangeStats({ bars, intraday, decimals, label }: { bars: Bar[]; intraday: boolean; decimals: number; label: string }) {
  const first = bars[0];
  const last = bars[bars.length - 1];
  let hi = first;
  let lo = first;
  let sum = 0;
  for (const b of bars) {
    if (b.h > hi.h) hi = b;
    if (b.l < lo.l) lo = b;
    sum += b.c;
  }
  const change = last.c - first.o;
  const dir = direction(change);
  return (
    <div className="chart-stats" data-testid="chart-stats">
      <span>
        <span className="label">Last </span>
        <span className="white">{fmtNum(last.c, decimals)}</span>
      </span>
      <span>
        <span className="label">{label} Chg </span>
        <span className={dir}>
          {fmtSigned(change, decimals)} {fmtSigned((change / first.o) * 100, 2, "%")}
        </span>
      </span>
      <span>
        <span className="label">High </span>
        <span className="white">{fmtNum(hi.h, decimals)}</span>
        <span className="gray"> on {fmtBarTime(hi.t, intraday)}</span>
      </span>
      <span>
        <span className="label">Low </span>
        <span className="white">{fmtNum(lo.l, decimals)}</span>
        <span className="gray"> on {fmtBarTime(lo.t, intraday)}</span>
      </span>
      <span>
        <span className="label">Avg </span>
        <span className="white">{fmtNum(sum / bars.length, decimals)}</span>
      </span>
    </div>
  );
}

function HoverStats({ bar, intraday, decimals }: { bar: Bar; intraday: boolean; decimals: number }) {
  return (
    <div className="chart-stats" data-testid="chart-hover">
      <span className="yellow">{fmtBarTime(bar.t, intraday)}</span>
      {(
        [
          ["O", bar.o],
          ["H", bar.h],
          ["L", bar.l],
          ["C", bar.c],
        ] as const
      ).map(([k, v]) => (
        <span key={k}>
          <span className="label">{k} </span>
          <span className="white">{fmtNum(v, decimals)}</span>
        </span>
      ))}
      {!!bar.v && (
        <span>
          <span className="label">Vol </span>
          <span className="white">{fmtInt(bar.v)}</span>
        </span>
      )}
    </div>
  );
}

export function ChartScreen({ panel, security, fn }: Props) {
  const { execute, setOptionCount } = usePanels.getState();
  const cfg = CHART_OPTIONS[fn];
  useEffect(() => {
    setOptionCount(panel.id, cfg.options.length);
  }, [panel.id, cfg.options.length, setOptionCount]);
  const index = Math.min(panel.option ?? cfg.defaultIndex, cfg.options.length - 1);
  const opt = cfg.options[index];
  const intraday = opt.interval !== "1d" && opt.interval !== "1wk";
  const [hover, setHover] = useState<Bar | null>(null);

  const { data, error, loading } = usePolling(
    `${security}|${opt.interval}|${opt.range}`,
    (signal) => fetchHistory(security, opt.interval, opt.range, signal),
    60_000,
  );
  const bars = data?.bars ?? null;
  const decimals = decimalsFor(sectorOf(security), bars?.[bars.length - 1]?.c ?? null);

  return (
    <div className="chart-screen" data-testid="chart-screen">
      <div className="chart-options">
        {cfg.options.map((o, i) => (
          <button
            key={o.label}
            className={`chart-opt${i === index ? " active" : ""}`}
            data-testid={`chart-opt-${o.label}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => execute(panel.id, { kind: "menuItem", index: i + 1 })}
          >
            <span className="chart-opt-num">{i + 1})</span> {o.label}
          </button>
        ))}
        <span className="gray chart-interval">{opt.interval} bars</span>
      </div>
      {bars && bars.length > 0 ? (
        <>
          {hover ? (
            <HoverStats bar={hover} intraday={intraday} decimals={decimals} />
          ) : (
            <RangeStats bars={bars} intraday={intraday} decimals={decimals} label={opt.label} />
          )}
          <div className="chart-area">
            <PriceChart key={fn} bars={bars} intraday={intraday} decimals={decimals} onHover={setHover} candles={fn === "GPO"} />
          </div>
        </>
      ) : (
        <div className={error ? "error-box" : "gray"} data-testid="chart-message">
          {loading
            ? "LOADING HISTORY..."
            : error instanceof ApiError && error.status === 404
              ? "NO PRICE HISTORY AVAILABLE FOR THIS SECURITY AND RANGE"
              : "HISTORY DATA SOURCE UNAVAILABLE"}
        </div>
      )}
    </div>
  );
}
