import { useEffect, useRef, useState } from "react";
import { api, useData, useLiveQuotes } from "../api";
import { dmRoom, roomLabel, useChatRoom } from "../chat";
import { sanitizeUser, usePanels } from "../store/panels";
import { parseCommand } from "../terminal/commandParser";
import { decimalsFor, fmtBig, fmtIsoDateTime, fmtNum, fmtTradeTime } from "../terminal/format";
import { sectorOf, tickerOf } from "../terminal/sectors";
import { Change, DataState, DataTable, OptionBar, Section, loadInPanel, useOptions, type ScreenProps } from "./common";

function ChatScreen({ panel, mode }: { panel: ScreenProps["panel"]; mode: "IB" | "MSG" }) {
  const user = usePanels((s) => s.user);
  const roomsState = useData(`chat-rooms|${user}`, (s) => api.chatRooms(user, s), 15_000);
  const [extra, setExtra] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState("");
  const listed = roomsState.data?.map((r) => r.room) ?? [];
  const rooms = [...new Set([...listed, ...extra])].filter((r) => mode === "IB" || r.startsWith("dm:"));
  const index = useOptions(panel, rooms.length, 0);
  const room = rooms[index] ?? null;
  const { messages, error, send } = useChatRoom(room, user);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages]);

  const openDm = () => {
    const other = sanitizeUser(to);
    if (!to.trim() || other === user) return;
    const r = dmRoom(user, other);
    setExtra((e) => (e.includes(r) ? e : [...e, r]));
    setTo("");
    const next = [...new Set([...rooms, r])].indexOf(r);
    setTimeout(() => usePanels.getState().execute(panel.id, { kind: "menuItem", index: next + 1 }), 0);
  };

  return (
    <div className="col-flex" data-testid={mode === "IB" ? "ib-screen" : "msg-screen"}>
      <OptionBar
        panel={panel}
        labels={rooms.map((r) => roomLabel(r, user))}
        selected={index}
        extra={`Signed in as ${user}`}
      />
      <div className="chat-log" ref={logRef} data-testid="chat-log">
        {!room ? (
          <div className="gray">{mode === "MSG" ? "NO CONVERSATIONS YET. START ONE BELOW." : "LOADING ROOMS..."}</div>
        ) : !messages.length ? (
          <div className="gray">NO MESSAGES IN {roomLabel(room, user)} YET</div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className="chat-line">
              <span className="gray">{fmtIsoDateTime(new Date(m.ts).toISOString())}</span>{" "}
              <span className={m.user === user ? "yellow" : "menu-code"}>{m.user}</span> <span className="white">{m.text}</span>
            </div>
          ))
        )}
      </div>
      {error && <div className="cmdline-message">{error}</div>}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (send(draft)) setDraft("");
        }}
      >
        <input
          className="form-input grow"
          placeholder={room ? `Message ${roomLabel(room, user)} (Enter to send, Esc for command line)` : "Select a room"}
          value={draft}
          maxLength={1000}
          disabled={!room}
          data-testid="chat-input"
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          openDm();
        }}
      >
        <span className="label">Direct message to</span>
        <input className="form-input" placeholder="LOGIN NAME" value={to} data-testid="chat-dm" onChange={(e) => setTo(e.target.value)} />
      </form>
    </div>
  );
}

/** IB: chat rooms and direct messages for users of this instance. */
export function IbScreen({ panel }: ScreenProps) {
  return <ChatScreen panel={panel} mode="IB" />;
}

/** MSG: direct-message conversations. */
export function MsgScreen({ panel }: ScreenProps) {
  return <ChatScreen panel={panel} mode="MSG" />;
}

const MONITOR_KEY = "blmbu.monitor";
const DEFAULT_MONITOR = ["SPX Index", "INDU Index", "CCMP Index", "AAPL US Equity", "MSFT US Equity", "EURUSD Curncy", "CL1 Comdty", "GC1 Comdty"];

function loadMonitor(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MONITOR_KEY) ?? "null");
    return Array.isArray(v) && v.every((s) => typeof s === "string") ? v : DEFAULT_MONITOR;
  } catch {
    return DEFAULT_MONITOR;
  }
}

/** BLP: a personal monitor (watchlist) with live quotes, saved in this browser. */
export function BlpScreen({ panel }: ScreenProps) {
  const [list, setList] = useState<string[]>(loadMonitor);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const state = useData(list.length ? `quotes|${list.join(",")}` : null, (s) => api.quotes(list, s), 60_000);
  const rows = useLiveQuotes(state.data);

  const save = (next: string[]) => {
    setList(next);
    localStorage.setItem(MONITOR_KEY, JSON.stringify(next));
  };

  const add = () => {
    const cmd = parseCommand(draft);
    if (cmd.kind !== "load") {
      setError("ENTER A SECURITY WITH ITS SECTOR, E.G. NVDA US <EQUITY> OR EURUSD CURNCY");
      return;
    }
    setError(null);
    setDraft("");
    if (!list.includes(cmd.security)) save([...list, cmd.security]);
  };

  const missing = state.data ? list.filter((s) => !state.data!.some((q) => q.security === s)) : [];

  return (
    <div className="col-flex" data-testid="blp-screen">
      <Section title="Monitor" right="Saved in this browser · click a row to load" />
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <span className="label">Add security</span>
        <input
          className="form-input grow"
          placeholder="e.g. NVDA US <EQUITY> (Enter to add, Esc for command line)"
          value={draft}
          data-testid="blp-add"
          onChange={(e) => setDraft(e.target.value.toUpperCase())}
        />
      </form>
      {error && <div className="cmdline-message">{error}</div>}
      {!list.length ? (
        <div className="gray">THE MONITOR IS EMPTY. ADD A SECURITY ABOVE.</div>
      ) : rows ? (
        <DataTable
          panel={panel}
          rows={rows}
          onRowClick={(q) => loadInPanel(panel.id, q.security)}
          columns={[
            { key: "s", label: "Security", render: (q) => <span className="menu-code">{tickerOf(q.security)}</span> },
            { key: "l", label: "Last", align: "right", render: (q) => <span className="white">{fmtNum(q.last, decimalsFor(sectorOf(q.security), q.last))}</span> },
            { key: "c", label: "Net Chg", align: "right", render: (q) => <Change value={q.change} decimals={decimalsFor(sectorOf(q.security), q.last)} /> },
            { key: "p", label: "%Chg", align: "right", render: (q) => <Change value={q.changePct} pct /> },
            { key: "b", label: "Bid", align: "right", render: (q) => fmtNum(q.bid, decimalsFor(sectorOf(q.security), q.last)) },
            { key: "a", label: "Ask", align: "right", render: (q) => fmtNum(q.ask, decimalsFor(sectorOf(q.security), q.last)) },
            { key: "v", label: "Volume", align: "right", render: (q) => fmtBig(q.volume) },
            { key: "t", label: "Time", align: "right", render: (q) => <span className="gray">{fmtTradeTime(q.time)}</span> },
            {
              key: "x",
              label: "",
              align: "right",
              render: (q) => (
                <button
                  className="row-remove"
                  title="Remove"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    save(list.filter((s) => s !== q.security));
                  }}
                >
                  x
                </button>
              ),
            },
          ]}
        />
      ) : (
        <DataState state={state} what="MONITOR QUOTES" />
      )}
      {missing.length > 0 && (
        <div className="gray note-line">
          No data for: {missing.join(", ")}{" "}
          <button className="link-button" onClick={() => save(list.filter((s) => !missing.includes(s)))}>
            remove
          </button>
        </div>
      )}
    </div>
  );
}

const UNAVAILABLE: Record<string, string> = {
  SPLC: "Supply-chain relationships (suppliers, customers, revenue exposure) come from proprietary research datasets. No free source provides them.",
};

/** Functions that cannot be supported with free data. */
export function UnavailableScreen({ fn }: ScreenProps) {
  return (
    <div data-testid="unavailable">
      <div className="yellow">{fn} IS NOT AVAILABLE FROM FREE DATA SOURCES.</div>
      <p className="prose">{UNAVAILABLE[fn] ?? "This function needs licensed data."}</p>
      <div className="screen-note">Press &lt;MENU&gt; (Backspace) to return.</div>
    </div>
  );
}

export const UNAVAILABLE_FUNCTIONS = Object.keys(UNAVAILABLE);
