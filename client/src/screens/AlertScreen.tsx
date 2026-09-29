import { useState } from "react";
import { ApiError, api, useData, type AlertInfo } from "../api";
import { Grid } from "../components/Grid";
import { useAlerts } from "../store/alerts";
import { usePanels } from "../store/panels";
import { parseCommand } from "../terminal/commandParser";
import { fmtIsoDateTime, fmtNum } from "../terminal/format";
import { Section, loadInPanel, type ScreenProps } from "./common";

const KINDS: [AlertInfo["kind"], string][] = [
  ["above", "Price at or above"],
  ["below", "Price at or below"],
  ["pct_up", "Up % today"],
  ["pct_down", "Down % today"],
  ["volume_above", "Volume at or above"],
  ["rule", "Rule on daily bars"],
];

function describe(a: AlertInfo): string {
  const label = KINDS.find(([k]) => k === a.kind)?.[1] ?? a.kind;
  return a.kind === "rule" ? `${label}: ${a.expr}` : `${label} ${fmtNum(a.value, a.kind === "volume_above" ? 0 : 2)}`;
}

/** ALRT: server-side alerts with status-bar and browser notifications. */
export function AlertScreen({ panel, security }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const version = useAlerts((s) => s.version);
  const [bump, setBump] = useState(0);
  const list = useData(`alerts|${user}|${version}|${bump}`, (s) => api.alerts.list(user, s), 30_000);
  const [sec, setSec] = useState(security ?? "");
  const [kind, setKind] = useState<AlertInfo["kind"]>("above");
  const [value, setValue] = useState("");
  const [expr, setExpr] = useState("rsi(close, 14) < 30");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [permission, setPermission] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");

  const create = async () => {
    const cmd = parseCommand(sec);
    if (cmd.kind !== "load") {
      setMessage({ error: true, text: "Enter a security with its sector, e.g. AAPL US <EQUITY>" });
      return;
    }
    try {
      const a = await api.alerts.create(user, {
        security: cmd.security,
        kind,
        ...(kind === "rule" ? { expr } : { value: Number(value.replace(/,/g, "")) }),
        note: note || undefined,
      });
      setMessage({ error: false, text: `Alert set: ${describe(a)} on ${a.security}` });
      setValue("");
      setNote("");
      setBump((b) => b + 1);
    } catch (err) {
      setMessage({ error: true, text: err instanceof ApiError ? err.message : "Could not create the alert" });
    }
  };

  const active = list.data?.active ?? [];
  const triggered = list.data?.triggered ?? [];

  return (
    <div className="col-flex" data-testid="alrt-screen">
      <div className="toolbar">
        <label className="label">
          Security <input className="form-input" style={{ width: "18ch" }} value={sec} data-testid="alrt-security" onChange={(e) => setSec(e.target.value.toUpperCase())} />
        </label>
        <select className="form-select" value={kind} data-testid="alrt-kind" onChange={(e) => setKind(e.target.value as AlertInfo["kind"])}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        {kind === "rule" ? (
          <input className="form-input" style={{ width: "28ch" }} value={expr} data-testid="alrt-expr" onChange={(e) => setExpr(e.target.value)} />
        ) : (
          <input
            className="form-input"
            style={{ width: "12ch" }}
            placeholder={kind.startsWith("pct") ? "e.g. 3" : "value"}
            value={value}
            data-testid="alrt-value"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
        )}
        <input className="form-input" style={{ width: "16ch" }} placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="tool-button primary" data-testid="alrt-create" onClick={() => void create()}>
          Set Alert
        </button>
        {permission !== "granted" && permission !== "unsupported" && (
          <button className="tool-button" onClick={() => void Notification.requestPermission().then(setPermission)}>
            Enable Browser Notifications
          </button>
        )}
        {permission === "granted" && <span className="gray">browser notifications on</span>}
      </div>
      {message && (
        <div className={message.error ? "cmdline-message" : "gray note-line"} data-testid="alrt-message">
          {message.text}
        </div>
      )}
      <div className="two-col fixed" style={{ flex: 1, minHeight: 0 }}>
        <div className="col-flex">
          <Section title={`Active (${active.length})`} right="Checked server-side, even with the browser closed" />
          <Grid
            readOnly
            testId="alrt-active"
            columns={[
              { key: "s", label: "Security" },
              { key: "c", label: "Condition" },
              { key: "n", label: "Note" },
              { key: "x", label: "" },
            ]}
            rows={active.map((a) => [a.security, describe(a), a.note ?? "", "remove"])}
            onActivate={({ row, col }) => {
              const a = active[row];
              if (!a) return;
              if (col === 3) void api.alerts.remove(user, a.id).then(() => setBump((b) => b + 1));
              else loadInPanel(panel.id, a.security);
            }}
            cellClass={(_r, c) => (c === 3 ? "down" : undefined)}
          />
        </div>
        <div className="col-flex">
          <Section title="Triggered" right="Double-click to re-arm" />
          <Grid
            readOnly
            testId="alrt-triggered"
            columns={[
              { key: "t", label: "Time" },
              { key: "s", label: "Security" },
              { key: "c", label: "Condition" },
              { key: "v", label: "At", align: "right" },
            ]}
            rows={triggered.map((a) => [
              a.triggeredAt ? fmtIsoDateTime(new Date(a.triggeredAt).toISOString()) : "",
              a.security,
              describe(a),
              fmtNum(a.triggerValue, a.kind === "volume_above" ? 0 : 2),
            ])}
            onActivate={({ row }) => {
              const a = triggered[row];
              if (a) void api.alerts.rearm(user, a.id).then(() => setBump((b) => b + 1));
            }}
          />
        </div>
      </div>
    </div>
  );
}
