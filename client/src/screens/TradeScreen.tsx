import { useEffect, useMemo, useState } from "react";
import type { OrderType, PaperOrder } from "../../../server/src/types";
import { ApiError, api, useData, useQuote } from "../api";
import { useAlerts } from "../store/alerts";
import { usePanels } from "../store/panels";
import { rememberPortfolio } from "../terminal/portfolioState";
import { fmtIsoDateTime, fmtNum } from "../terminal/format";
import { Change, DataTable, KeyValues, Section, loadInPanel, type ScreenProps } from "./common";

const TYPES: OrderType[] = ["market", "limit", "stop"];
const MINOR: Record<string, number> = { GBp: 0.01, GBX: 0.01, ZAc: 0.01, ILA: 0.01 };

/** TRADE: paper trading against live quotes, with positions mirrored into a "Paper" portfolio for PORT. */
export function TradeScreen({ panel, security }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const alertsVersion = useAlerts((s) => s.version);
  const [version, setVersion] = useState(0);
  const account = useData(`paper|${user}|${version}|${alertsVersion}`, (s) => api.paper.account(user, s), 10_000);
  const [sec, setSec] = useState(security ?? "AAPL US Equity");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [qty, setQty] = useState("100");
  const [type, setType] = useState<OrderType>("market");
  const [price, setPrice] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [armedReset, setArmedReset] = useState(false);
  const quote = useQuote(sec.trim() ? sec : null);

  useEffect(() => {
    if (security) setSec(security);
  }, [security]);

  const a = account.data;
  const heldSecurities = useMemo(() => a?.positions.map((p) => p.security) ?? [], [a]);
  const marks = useData(heldSecurities.length ? `paper-marks|${heldSecurities.join(",")}` : null, (s) => api.quotes(heldSecurities, s), 15_000);
  const markOf = new Map((marks.data ?? []).map((q) => [q.security, q]));

  const submit = async () => {
    setMessage(null);
    const quantity = Number(qty);
    const px = Number(price);
    try {
      const o = await api.paper.place(user, {
        security: sec,
        side,
        quantity,
        type,
        ...(type === "limit" ? { limitPrice: px } : {}),
        ...(type === "stop" ? { stopPrice: px } : {}),
      });
      setMessage(
        o.status === "filled"
          ? { ok: true, text: `Filled ${o.side.toUpperCase()} ${fmtNum(o.quantity, 0)} ${o.security} @ ${fmtNum(o.fillPrice, 4)}` }
          : o.status === "open"
            ? { ok: true, text: `Order #${o.id} working: ${o.type} ${o.side} ${fmtNum(o.quantity, 0)} ${o.security}` }
            : { ok: false, text: `Order ${o.status}: ${o.reason ?? ""}` },
      );
      setVersion((v) => v + 1);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof ApiError ? err.message : (err as Error).message });
    }
  };

  const cancel = async (o: PaperOrder) => {
    await api.paper.cancel(user, o.id).catch(() => {});
    setVersion((v) => v + 1);
  };

  const analyze = async () => {
    const paper = (await api.portfolios(user).catch(() => [])).find((p) => p.name === "Paper");
    if (paper) rememberPortfolio(user, paper.id);
    usePanels.getState().execute(panel.id, { kind: "function", fn: "PORT" });
  };

  const reset = async () => {
    if (!armedReset) {
      setArmedReset(true);
      setMessage({ ok: false, text: "Reset clears every paper order and position. Click Reset again to confirm." });
      return;
    }
    setArmedReset(false);
    await api.paper.reset(user, a?.startingCash ?? 1_000_000);
    setMessage({ ok: true, text: "Paper account reset." });
    setVersion((v) => v + 1);
  };

  const q = quote.data;
  return (
    <div className="col-flex" data-testid="trade-screen">
      <Section title="Paper Trading" right="Simulated fills against live quotes · no real orders are sent" />
      <div className="toolbar">
        <input className="form-input" style={{ width: "18ch" }} value={sec} data-testid="trade-security" onChange={(e) => setSec(e.target.value)} />
        <button className={`tool-button${side === "buy" ? " primary" : ""}`} data-testid="trade-buy" onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={`tool-button${side === "sell" ? " danger" : ""}`} data-testid="trade-sell" onClick={() => setSide("sell")}>
          Sell
        </button>
        <input className="form-input" style={{ width: "10ch" }} value={qty} data-testid="trade-qty" onChange={(e) => setQty(e.target.value)} />
        <select className="form-select" value={type} data-testid="trade-type" onChange={(e) => setType(e.target.value as OrderType)}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {type !== "market" && (
          <input className="form-input" style={{ width: "10ch" }} placeholder={type === "limit" ? "limit" : "stop"} value={price} data-testid="trade-price" onChange={(e) => setPrice(e.target.value)} />
        )}
        <button className="tool-button primary" data-testid="trade-submit" onClick={() => void submit()}>
          Send {side === "buy" ? "Buy" : "Sell"}
        </button>
        <span className="gray">
          {q ? `Bid ${fmtNum(q.bid, 4)} / Ask ${fmtNum(q.ask, 4)} · Last ${fmtNum(q.last, 4)} ${q.currency ?? ""}` : sec.trim() ? "No quote" : ""}
        </span>
      </div>
      {message && (
        <div className={message.ok ? "white" : "yellow"} data-testid="trade-message">
          {message.text}
        </div>
      )}
      {a && (
        <>
          <Section
            title="Positions"
            right={
              <>
                <button className="tool-button" onClick={() => void analyze()} disabled={!a.positions.length}>
                  Analyze in PORT
                </button>{" "}
                <button className="tool-button danger" onClick={() => void reset()}>
                  Reset
                </button>
              </>
            }
          />
          <KeyValues columns={4} items={Object.entries(a.cash).map(([ccy, v]): [string, string] => [`Cash ${ccy}`, fmtNum(v, 2)])} />
          <DataTable
            paged={false}
            testId="trade-positions"
            rows={a.positions}
            onRowClick={(p) => loadInPanel(panel.id, p.security)}
            columns={[
              { key: "s", label: "Security", render: (p) => p.security },
              { key: "q", label: "Quantity", align: "right", render: (p) => fmtNum(p.quantity, 0) },
              { key: "c", label: "Avg Cost", align: "right", render: (p) => fmtNum(p.avgCost, 4) },
              { key: "l", label: "Last", align: "right", render: (p) => fmtNum(markOf.get(p.security)?.last ?? null, 4) },
              {
                key: "u",
                label: "Unrealized P&L",
                align: "right",
                render: (p) => {
                  const m = markOf.get(p.security);
                  const scale = MINOR[m?.currency ?? ""] ?? 1;
                  return <Change value={m?.last !== null && m?.last !== undefined ? (m.last - p.avgCost) * p.quantity * scale : null} />;
                },
              },
              { key: "ccy", label: "Ccy", render: (p) => p.currency },
            ]}
          />
          <Section title="Orders" />
          <DataTable
            paged={false}
            maxRows={100}
            testId="trade-orders"
            rows={a.orders}
            columns={[
              { key: "t", label: "Time", render: (o) => fmtIsoDateTime(new Date(o.filledAt ?? o.created).toISOString()) },
              { key: "s", label: "Security", render: (o) => o.security },
              { key: "side", label: "Side", render: (o) => <span className={o.side === "buy" ? "up" : "down"}>{o.side.toUpperCase()}</span> },
              { key: "q", label: "Qty", align: "right", render: (o) => fmtNum(o.quantity, 0) },
              { key: "type", label: "Type", render: (o) => (o.type === "market" ? "MKT" : `${o.type.toUpperCase()} ${fmtNum(o.limitPrice ?? o.stopPrice, 4)}`) },
              { key: "st", label: "Status", render: (o) => <span className={o.status === "filled" ? "white" : o.status === "open" ? "yellow" : "gray"}>{o.status.toUpperCase()}</span> },
              { key: "px", label: "Fill", align: "right", render: (o) => fmtNum(o.fillPrice, 4) },
              {
                key: "x",
                label: "",
                render: (o) =>
                  o.status === "open" ? (
                    <button className="row-remove" title="Cancel order" onClick={() => void cancel(o)}>
                      x
                    </button>
                  ) : (
                    (o.reason ?? "")
                  ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
