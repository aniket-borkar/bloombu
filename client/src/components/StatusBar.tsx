import { useEffect, useState } from "react";
import { fetchIndices, useLiveQuotes, usePolling, type Quote } from "../api";
import { authStatus, signOut } from "../auth";
import { useAlerts } from "../store/alerts";
import { connectionLabel, useConnection } from "../store/connection";
import { quoteStream } from "../stream";
import { decimalsFor, direction, fmtClock, fmtDate, fmtNum, fmtSigned } from "../terminal/format";
import { sectorOf, tickerOf } from "../terminal/sectors";

const MARKET_STATE: Record<string, [string, boolean]> = {
  REGULAR: ["US MKT OPEN", true],
  PRE: ["US PRE-MKT", false],
  PREPRE: ["US PRE-MKT", false],
  POST: ["US AFTER-HRS", false],
  POSTPOST: ["US AFTER-HRS", false],
  CLOSED: ["US MKT CLOSED", false],
};

const CONNECTION_CLASS = { LIVE: "conn-live", POLL: "conn-poll", OFFLINE: "conn-offline" } as const;

function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function TapeItem({ q }: { q: Quote }) {
  const d = decimalsFor(sectorOf(q.security), q.last);
  const dir = direction(q.change);
  return (
    <span className="tape-item">
      <span className="tape-name">{tickerOf(q.security)}</span>
      <span className="white">{fmtNum(q.last, d)} </span>
      <span className={dir}>{fmtSigned(q.changePct, 2, "%")}</span>
    </span>
  );
}

export function StatusBar() {
  const now = useClock();
  const { data: snapshot } = usePolling("indices", (signal) => fetchIndices(signal), 30_000, {
    pauseWhen: () => quoteStream.connected,
  });
  const data = useLiveQuotes(snapshot);
  const conn = useConnection(connectionLabel);
  const spx = data?.find((q) => q.security === "SPX Index");
  const [label, open] = MARKET_STATE[spx?.marketState ?? ""] ?? ["US MKT --", false];
  const tz = now.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop();
  const toast = useAlerts((s) => s.toasts[0]);
  const dismiss = useAlerts((s) => s.dismiss);
  const showToast = toast && now.getTime() - toast.time < 30_000;

  return (
    <div className="status-bar" data-testid="status-bar">
      <span>
        <span className={CONNECTION_CLASS[conn]} data-testid="connection" title="Data connection">
          {conn}
        </span>{" "}
        <span className={open ? "mkt-open" : "mkt-closed"}>{label}</span>
      </span>
      <div className="tape">
        {showToast ? (
          <button className="alert-toast" data-testid="alert-toast" title="Dismiss" onMouseDown={(e) => e.preventDefault()} onClick={() => dismiss(toast.id)}>
            ALERT {fmtClock(new Date(toast.time))}: {toast.message}
          </button>
        ) : data && data.length > 0 && (
          <div className="tape-inner">
            {[...data, ...data].map((q, i) => (
              <TapeItem key={`${q.security}-${i}`} q={q} />
            ))}
          </div>
        )}
      </div>
      <span className="white">
        {authStatus.authRequired && (
          <button className="popout" title="Sign out" data-testid="sign-out" onClick={() => void signOut()}>
            ⏻
          </button>
        )}{" "}
        {fmtDate(now)} {fmtClock(now)} {tz}
      </span>
    </div>
  );
}
