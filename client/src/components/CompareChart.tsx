import { useEffect, useRef } from "react";
import { ColorType, CrosshairMode, LineSeries, createChart, type UTCTimestamp } from "lightweight-charts";

export interface CompareSeries {
  label: string;
  color: string;
  points: { t: number; v: number | null }[];
}

/** Lines on a daily time axis (portfolio vs benchmark, strategy vs buy-and-hold), in percent unless unit is "number". */
export function CompareChart({ series, unit = "pct", testId = "compare-chart" }: { series: CompareSeries[]; unit?: "pct" | "number"; testId?: string }) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chart = createChart(el.current!, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#000000" },
        textColor: "#9a9a9a",
        fontFamily: '"IBM Plex Mono", Consolas, Menlo, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: "#1a1a1a" }, horzLines: { color: "#1a1a1a" } },
      rightPriceScale: { borderColor: "#333333" },
      timeScale: { borderColor: "#333333" },
      crosshair: { mode: CrosshairMode.Normal },
    });
    for (const s of series) {
      const line = chart.addSeries(LineSeries, {
        color: s.color,
        lineWidth: 2,
        title: s.label,
        priceFormat: { type: "custom", formatter: (v: number) => (unit === "pct" ? `${v.toFixed(2)}%` : v.toLocaleString("en-US", { maximumFractionDigits: 2 })), minMove: 0.01 },
      });
      const seen = new Set<number>();
      line.setData(
        s.points
          .filter((p) => p.v !== null && Number.isFinite(p.v))
          .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.v as number }))
          .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true))),
      );
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series, unit]);

  return <div ref={el} className="chart-canvas" data-testid={testId} />;
}
