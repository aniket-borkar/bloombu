import { useEffect, useMemo, useState } from "react";
import type { Trade } from "../../../server/src/types";
import { quoteStream } from "../stream";
import { usePanels } from "../store/panels";
import { fmtNum } from "../terminal/format";
import { DataTable, KeyValues, Section, type ScreenProps } from "./common";

const MAX_TRADES = 500;

export interface TapeStats {
  count: number;
  volume: number;
  vwap: number | null;
  buyVolume: number;
  sellVolume: number;
  high: number | null;
  low: number | null;
}

export function tapeStats(trades: Trade[]): TapeStats {
  let volume = 0;
  let notional = 0;
  let buyVolume = 0;
  let sellVolume = 0;
  let high: number | null = null;
  let low: number | null = null;
  for (const t of trades) {
    const size = t.size ?? 0;
    volume += size;
    notional += size * t.price;
    if (t.side === "buy") buyVolume += size;
    if (t.side === "sell") sellVolume += size;
    high = high === null ? t.price : Math.max(high, t.price);
    low = low === null ? t.price : Math.min(low, t.price);
  }
  return { count: trades.length, volume, vwap: volume > 0 ? notional / volume : null, buyVolume, sellVolume, high, low };
}

const clock = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "--" : `${d.toLocaleTimeString("en-GB", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** Crypto trades can be a few satoshis, so small fractional sizes get more decimals. */
export const sizeText = (v: number | null) => (v === null ? "--" : Number.isInteger(v) ? fmtNum(v, 0) : fmtNum(v, Math.abs(v) < 0.01 ? 8 : 4));

/** QR: time and sales from a real-time trade stream (Coinbase for crypto, Finnhub for US equities). */
export function QrScreen({ panel, security }: ScreenProps) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const setPageCount = usePanels((s) => s.setPageCount);

  useEffect(() => {
    const sec = security!;
    const offSnapshot = quoteStream.on("trades", (m) => {
      if (m.security !== sec) return;
      setAvailable(m.available as boolean);
      setTrades([...(m.trades as Trade[])].reverse().slice(0, MAX_TRADES));
    });
    const offTrade = quoteStream.on("trade", (m) => {
      if (m.security !== sec) return;
      setTrades((t) => [m.trade as Trade, ...t].slice(0, MAX_TRADES));
    });
    const offOpen = quoteStream.onOpen(() => quoteStream.send({ op: "trades.sub", security: sec }));
    return () => {
      offSnapshot();
      offTrade();
      offOpen();
      quoteStream.send({ op: "trades.unsub", security: sec });
    };
  }, [security]);

  useEffect(() => setPageCount(panel.id, 1), [panel.id, setPageCount]);
  const stats = useMemo(() => tapeStats(trades), [trades]);

  if (available === false) {
    return (
      <div data-testid="qr-screen">
        <div className="yellow">NO REAL-TIME TRADE STREAM FOR {security!.toUpperCase()}.</div>
        <p className="prose">
          Crypto (for example XBTUSD Curncy) streams free from Coinbase. For US equities, add a free FINNHUB_API_KEY and put finnhub in PROVIDERS. SRC
          &lt;GO&gt; shows what each data source covers.
        </p>
      </div>
    );
  }

  const buyPct = stats.buyVolume + stats.sellVolume > 0 ? (stats.buyVolume / (stats.buyVolume + stats.sellVolume)) * 100 : null;
  return (
    <div className="col-flex" data-testid="qr-screen">
      <Section title="Trade Recap" right={available ? "Live · newest first" : "Connecting..."} />
      <KeyValues
        columns={4}
        items={[
          ["Trades", fmtNum(stats.count, 0)],
          ["Volume", sizeText(stats.volume)],
          ["VWAP", stats.vwap === null ? "--" : fmtNum(stats.vwap, 2)],
          ["Buy / Sell", buyPct === null ? "--" : `${fmtNum(buyPct, 0)}% / ${fmtNum(100 - buyPct, 0)}%`],
          ["High", stats.high === null ? "--" : fmtNum(stats.high, 2)],
          ["Low", stats.low === null ? "--" : fmtNum(stats.low, 2)],
          ["Last", trades[0] ? fmtNum(trades[0].price, 2) : "--"],
          ["Source", trades[0]?.venue ?? "--"],
        ]}
      />
      <DataTable
        paged={false}
        maxRows={200}
        testId="qr-trades"
        rows={trades}
        rowClass={(t, i) => {
          const prev = trades[i + 1];
          return prev ? (t.price > prev.price ? "up" : t.price < prev.price ? "down" : "") : "";
        }}
        columns={[
          { key: "time", label: "Time", render: (t) => clock(t.time) },
          { key: "price", label: "Price", align: "right", render: (t) => fmtNum(t.price, 2) },
          { key: "size", label: "Size", align: "right", render: (t) => sizeText(t.size) },
          { key: "side", label: "Side", render: (t) => <span className={t.side === "buy" ? "up" : t.side === "sell" ? "down" : "gray"}>{t.side === "buy" ? "BUY" : t.side === "sell" ? "SELL" : "--"}</span> },
          { key: "venue", label: "Venue", render: (t) => t.venue ?? "--" },
        ]}
      />
    </div>
  );
}
