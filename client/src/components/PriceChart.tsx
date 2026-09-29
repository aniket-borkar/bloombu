import { useEffect, useRef } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Bar } from "../api";

interface Props {
  bars: Bar[];
  intraday: boolean;
  decimals: number;
  onHover: (bar: Bar | null) => void;
  /** Draw OHLC candlesticks instead of a close-price area (fixed for the chart's lifetime). */
  candles?: boolean;
}

/**
 * The chart library renders timestamps as UTC. Intraday bars are shifted by the
 * local offset so the axis shows local time; daily bars keep their UTC date.
 */
function chartTime(t: number, intraday: boolean): UTCTimestamp {
  const shifted = intraday ? t - new Date(t).getTimezoneOffset() * 60_000 : t;
  return Math.floor(shifted / 1000) as UTCTimestamp;
}

export function PriceChart({ bars, intraday, decimals, onHover, candles = false }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const price = useRef<ISeriesApi<"Area"> | ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const byTime = useRef(new Map<number, Bar>());
  const hover = useRef(onHover);
  hover.current = onHover;

  useEffect(() => {
    const c = createChart(el.current!, {
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
      timeScale: { borderColor: "#333333", secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    });
    price.current = candles
      ? c.addSeries(CandlestickSeries, {
          upColor: "#1ed760",
          downColor: "#ff433d",
          borderUpColor: "#1ed760",
          borderDownColor: "#ff433d",
          wickUpColor: "#1ed760",
          wickDownColor: "#ff433d",
        })
      : c.addSeries(AreaSeries, {
          lineColor: "#fb8b1e",
          topColor: "rgba(251, 139, 30, 0.35)",
          bottomColor: "rgba(251, 139, 30, 0.02)",
          lineWidth: 2,
          priceLineColor: "#fb8b1e",
        });
    price.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: "#3a3a3a",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    c.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    c.subscribeCrosshairMove((param) => {
      hover.current(param.time === undefined ? null : (byTime.current.get(param.time as number) ?? null));
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
    };
  }, [candles]);

  useEffect(() => {
    const c = chart.current;
    if (!c || !price.current || !volume.current) return;
    const map = new Map<number, Bar>();
    const kept: { time: UTCTimestamp; bar: Bar }[] = [];
    for (const b of bars) {
      const time = chartTime(b.t, intraday);
      if (kept.length && time <= kept[kept.length - 1].time) continue;
      map.set(time, b);
      kept.push({ time, bar: b });
    }
    byTime.current = map;
    hover.current(null);
    c.applyOptions({ timeScale: { timeVisible: intraday } });
    price.current.applyOptions({ priceFormat: { type: "price", precision: decimals, minMove: 10 ** -decimals } });
    if (candles) {
      (price.current as ISeriesApi<"Candlestick">).setData(
        kept.map(({ time, bar }) => ({ time, open: bar.o, high: bar.h, low: bar.l, close: bar.c })),
      );
    } else {
      (price.current as ISeriesApi<"Area">).setData(kept.map(({ time, bar }) => ({ time, value: bar.c })));
    }
    const vols = kept.map(({ time, bar }) => ({ time, value: bar.v ?? 0 }));
    volume.current.setData(vols.some((v) => v.value > 0) ? vols : []);
    c.timeScale().fitContent();
  }, [bars, intraday, decimals, candles]);

  return <div ref={el} className="chart-canvas" data-testid="price-chart" />;
}
