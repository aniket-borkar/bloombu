import { useEffect, useState } from "react";
import type { Quote } from "../api";
import { decimalsFor, direction, fmtInt, fmtNum, fmtSigned, fmtTradeTime } from "../terminal/format";
import { sectorOf, tickerOf } from "../terminal/sectors";
import { quoteAge } from "../terminal/quoteFreshness";
import { publicCryptoSymbol } from "../publicCrypto";
import { quoteStream } from "../stream";

export function SecurityHeader({ quote }: { quote: Quote }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const sector = sectorOf(quote.security);
  const d = decimalsFor(sector, quote.last);
  const dir = direction(quote.change);
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "";
  const delayed = (quote.delayMinutes ?? 0) > 0;
  const extended = quote.priceSession === "pre" || quote.priceSession === "post";
  const session = quote.priceSession === "pre" ? "Pre-market" : quote.priceSession === "post" ? "After-hours"
    : quote.priceSession === "regular" ? (quote.marketState === "CLOSED" ? "Market closed · regular last"
      : ["PRE", "PREPRE", "POST", "POSTPOST"].includes(quote.marketState ?? "") ? "Regular close · extended quote unavailable" : "Regular session") : null;

  return (
    <div className="sec-header" data-testid="security-header">
      <div className="row">
        <span className="ticker">{tickerOf(quote.security)}</span>
        {quote.currency && <span className="gray">{quote.currency}</span>}
        <span className={dir}>{arrow}</span>
        <span className="last" data-testid="last-price">
          {fmtNum(quote.last, d)}
        </span>
        <span className={dir}>{extended && <span className="label">Day </span>}{fmtSigned(quote.change, d)}</span>
        <span className={dir}>{fmtSigned(quote.changePct, 2, "%")}</span>
        <span>
          <span className="label">At </span>
          <span className="white">{fmtTradeTime(quote.time)}</span>
          {delayed && <span className="gray"> d</span>}
        </span>
        {!!quote.volume && (
          <span>
            <span className="label">{extended ? "Reg Vol " : "Vol "}</span>
            <span className="white">{fmtInt(quote.volume)}</span>
          </span>
        )}
      </div>
      <div className="row">
        {(
          [
            [extended ? "Reg O" : "O", quote.open],
            [extended ? "Reg H" : "H", quote.high],
            [extended ? "Reg L" : "L", quote.low],
            ["Prev", quote.prevClose],
          ] as const
        ).map(([label, v]) => (
          <span key={label}>
            <span className="label">{label} </span>
            <span className="white">{fmtNum(v, d)}</span>
          </span>
        ))}
        {extended && <span><span className="label">Reg close </span><span className="white">{fmtNum(quote.regularClose ?? null, d)}</span></span>}
        {sector !== "Index" && (quote.bid !== null || quote.ask !== null) && (
          <span>
            <span className="label">Bid/Ask </span>
            <span className="white">
              {fmtNum(quote.bid, d)}/{fmtNum(quote.ask, d)}
            </span>
            {quote.bidSize !== null && quote.askSize !== null && (
              <span className="gray">
                {" "}
                {quote.bidSize}x{quote.askSize}
              </span>
            )}
          </span>
        )}
      </div>
      <div className="row">
        {session && <span className="gray" data-testid="quote-session" title={extended
          ? "Last and time use the extended-hours observation. Day change and Prev keep the previous-day reference. Reg O/H/L, Reg Vol and Reg close are regular-session values."
          : "Last regular-session quote. Extended-hours prices appear only when Yahoo supplies a newer valid observation."}>{session}</span>}
        <span className="white">{quote.name}</span>
        {quote.exchange && <span className="gray">{quote.exchange}</span>}
        <span className="gray">
          {quote.source}
          {delayed ? ` · delayed ${quote.delayMinutes} min` : ""}
        </span>
        <span className="gray" data-testid="quote-age" title="Age since the source's last trade timestamp. Quiet or closed markets can have old trades; this is not a measurement of network latency.">
          {quoteAge(quote.time, now)}
        </span>
        {publicCryptoSymbol(quote.security) && <span className="gray" data-testid="quote-route"
          title="Direct connects this browser to Kraken's public feed. Server feed uses the terminal relay. Neither route guarantees exchange-to-screen latency.">
          {quoteStream.routeFor(quote.security) === "direct" ? "Direct feed" : "Server feed"}
        </span>}
      </div>
    </div>
  );
}
