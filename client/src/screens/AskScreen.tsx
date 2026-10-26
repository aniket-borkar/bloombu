import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { askStream, takePendingQuestion, type ClientAction, type Depth, type Source } from "../ai";
import { api, useData } from "../api";
import { usePanels } from "../store/panels";
import { setPendingBacktest } from "../terminal/backtestState";
import { isNumericCell, parseBlocks } from "../terminal/markdown";
import { setPendingDraft } from "../terminal/portfolioState";
import { setPendingBql } from "../terminal/sheetState";
import { captureInNotebook } from "../terminal/researchState";
import { openLink, type ScreenProps } from "./common";

type ActionState = "creating" | "created" | { error: string };
type DraftAlertAction = Extract<ClientAction, { type: "draft_alert" }>;

interface Turn {
  role: "user" | "assistant";
  content: string;
  depth?: Depth;
  tools: { name: string; summary: string; ok: boolean }[];
  sources: Source[];
  actions: ClientAction[];
  /** Progress of actions that change data (creating a drafted alert), by action index. */
  actionState: Record<number, ActionState>;
  error: string | null;
  provenance?: { security: string | null; provider: string | null; model: string | null; depth: Depth };
}

const MAX_SOURCES = 12;

function addSources(have: Source[], add: Source[] | undefined): Source[] {
  const seen = new Set(have.map((s) => `${s.label}|${s.url ?? ""}`));
  const fresh = (add ?? []).filter((s) => !seen.has(`${s.label}|${s.url ?? ""}`));
  return fresh.length ? [...have, ...fresh].slice(0, MAX_SOURCES) : have;
}

// Conversations and the DEEP toggle survive navigating away from ASK and back within a session.
const conversations = new Map<number, Turn[]>();
const deepPanels = new Set<number>();

async function aiStatus(signal: AbortSignal): Promise<{ enabled: boolean; provider: string | null; model: string | null; deepModel: string | null }> {
  const res = await fetch("/api/ai/status", { signal });
  return res.json();
}

/** Minimal formatting for model output: paragraphs, "- " bullets, | tables |, **bold** and `code`. */
function Rich({ text }: { text: string }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith("**") && part.endsWith("**") ? (
        <b key={i} className="white">
          {part.slice(2, -2)}
        </b>
      ) : part.startsWith("`") && part.endsWith("`") ? (
        <code key={i} className="yellow">
          {part.slice(1, -1)}
        </code>
      ) : (
        <Fragment key={i}>{part}</Fragment>
      ),
    );
  return (
    <>
      {parseBlocks(text).map((b, i) =>
        b.type === "table" ? (
          <table key={i} className="data-table ask-table" data-testid="ask-table">
            {b.header && (
              <thead>
                <tr>
                  {b.header.map((c, j) => (
                    <th key={j}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k} className={isNumericCell(c) ? "num" : undefined}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div key={i} className={b.bullet ? "ask-bullet" : "ask-line"}>
            {b.bullet ? "• " : ""}
            {inline(b.text)}
          </div>
        ),
      )}
    </>
  );
}

function actionLabel(a: ClientAction): string {
  switch (a.type) {
    case "open":
      return `Open ${a.security ? `${a.security} ` : ""}${a.fn}`;
    case "draft_portfolio":
      return `Review draft "${a.portfolio.name}" in PRTU`;
    case "open_backtest":
      return `Open ${a.security} backtest in BTST`;
    case "open_bql":
      return `Open in BQL: ${a.query.length > 60 ? `${a.query.slice(0, 57)}...` : a.query}`;
    case "draft_alert":
      return `Create alert: ${a.label}`;
  }
}

/** Drafted alerts are only created when the user confirms them. */
function AlertButton({ action, state, onCreate }: { action: DraftAlertAction; state: ActionState | undefined; onCreate: () => void }) {
  const created = state === "created";
  return (
    <>
      <button className="tool-button" data-testid="ask-action" disabled={created || state === "creating"} onClick={onCreate}>
        {created ? `Alert created: ${action.label}` : state === "creating" ? "Creating alert..." : actionLabel(action)}
      </button>
      {typeof state === "object" && <div className="cmdline-message">{state.error}</div>}
    </>
  );
}

function Sources({ sources }: { sources: Source[] }) {
  return (
    <div className="ask-sources" data-testid="ask-sources">
      <div>Sources:</div>
      {sources.map((s, i) => (
        <div key={i} className="ask-source">
          {s.url && /^https?:\/\//i.test(s.url) ? (
            <a href={s.url} onClick={(e) => (e.preventDefault(), openLink(s.url!))}>
              {s.label}
            </a>
          ) : (
            s.label
          )}
          {s.asOf ? ` (${s.asOf.slice(0, 10)})` : ""}
        </div>
      ))}
    </div>
  );
}

/** ASK: AI analyst that reads terminal data through tools and can open functions. */
export function AskScreen({ panel, security, fn }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const status = useData("ai-status", (s) => aiStatus(s), 300_000);
  const [turns, setTurns] = useState<Turn[]>(() => conversations.get(panel.id) ?? []);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [deep, setDeepState] = useState(() => deepPanels.has(panel.id));
  const abort = useRef<AbortController | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const contextFn = fn === "ASK" ? null : fn;

  const setDeep = (on: boolean) => {
    if (on) deepPanels.add(panel.id);
    else deepPanels.delete(panel.id);
    setDeepState(on);
  };

  useEffect(() => {
    conversations.set(panel.id, turns);
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [turns, panel.id]);

  useEffect(() => () => abort.current?.abort(), []);

  const otherPanel = () => {
    const { panels, layout } = usePanels.getState();
    const visible = panels.slice(0, layout).map((p) => p.id);
    return visible.find((id) => id !== panel.id) ?? panel.id;
  };

  const runAction = (a: ClientAction) => {
    const target = otherPanel();
    const s = usePanels.getState();
    switch (a.type) {
      case "open":
        if (a.security) s.execute(target, { kind: "load", security: a.security, fn: a.fn });
        else s.execute(target, { kind: "function", fn: a.fn });
        break;
      case "draft_portfolio":
        setPendingDraft(a.portfolio);
        s.execute(target, { kind: "function", fn: "PRTU" });
        break;
      case "open_backtest":
        setPendingBacktest({ panelId: target, security: a.security }, { entry: a.entry, exit: a.exit, direction: a.direction, costBps: a.costBps, range: a.range });
        s.execute(target, { kind: "load", security: a.security, fn: "BTST" });
        break;
      case "open_bql":
        setPendingBql(target, a.query);
        s.execute(target, { kind: "function", fn: "BQL" });
        break;
      case "draft_alert":
        s.execute(target, { kind: "function", fn: "ALRT" });
        break;
    }
    usePanels.getState().focus(panel.id);
  };

  const createAlert = async (turn: number, index: number, a: DraftAlertAction) => {
    const mark = (state: ActionState) => setTurns((all) => all.map((t, k) => (k === turn ? { ...t, actionState: { ...t.actionState, [index]: state } } : t)));
    mark("creating");
    const { security, kind, value, expr, note } = a.alert;
    try {
      await api.alerts.create(user, { security, kind, ...(value !== null ? { value } : {}), ...(expr ? { expr } : {}), ...(note ? { note } : {}) });
      mark("created");
      runAction(a);
    } catch (err) {
      mark({ error: (err as Error).message });
    }
  };

  const send = async (question: string, depth: Depth) => {
    if (!question.trim() || busy) return;
    const history = turns.filter((t) => t.content).map((t) => ({ role: t.role, content: t.content }));
    setTurns((t) => [
      ...t,
      { role: "user", content: question, depth, tools: [], sources: [], actions: [], actionState: {}, error: null },
      { role: "assistant", content: "", tools: [], sources: [], actions: [], actionState: {}, error: null,
        provenance: { security, provider: status.data?.provider ?? null, model: depth === "deep" ? status.data?.deepModel ?? status.data?.model ?? null : status.data?.model ?? null, depth },
      },
    ]);
    const patch = (f: (t: Turn) => Turn) => setTurns((all) => [...all.slice(0, -1), f(all[all.length - 1])]);
    setBusy(true);
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await askStream(
        { question, user, history, context: { security, fn: contextFn }, depth },
        (e) => {
          if (e.type === "text") patch((t) => ({ ...t, content: t.content + e.delta }));
          else if (e.type === "tool")
            patch((t) => ({ ...t, tools: [...t.tools, { name: e.name, summary: e.summary, ok: e.ok }], sources: addSources(t.sources, e.sources) }));
          else if (e.type === "action") {
            patch((t) => ({ ...t, actions: [...t.actions, e.action] }));
            if (e.action.type === "open" || e.action.type === "open_backtest") runAction(e.action);
          } else if (e.type === "error") patch((t) => ({ ...t, error: e.message }));
        },
        ctrl.signal,
      );
    } catch (err) {
      if (!ctrl.signal.aborted) patch((t) => ({ ...t, error: (err as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  // Questions typed on the command line as "? ..." or "?? ...".
  useEffect(() => {
    if (!status.data) return;
    const q = takePendingQuestion(panel.id);
    if (!q) return;
    setDeep(q.depth === "deep");
    if (status.data.enabled) void send(q.question, q.depth);
    else setDraft(q.question);
  }, [panel.askNonce, status.data]);

  const model = deep ? (status.data?.deepModel ?? status.data?.model) : status.data?.model;

  if (status.data && !status.data.enabled) {
    return (
      <div data-testid="ask-screen">
        <div className="yellow">THE AI ANALYST IS NOT CONFIGURED.</div>
        <p className="prose">
          Set these in .env and restart the server. Any OpenAI-compatible endpoint works, including a free local model with Ollama.
        </p>
        <pre className="setup">
          {`# Local and free (https://ollama.com):\nAI_PROVIDER=ollama\nAI_MODEL=llama3.1\n\n# Or a hosted model:\nAI_PROVIDER=openai        # or anthropic\nAI_API_KEY=...\nAI_MODEL=<model name>\n\n# Offline demo:\nAI_PROVIDER=mock`}
        </pre>
      </div>
    );
  }

  return (
    <div className="col-flex" data-testid="ask-screen">
      <div className="toolbar">
        <span className="gray">
          AI analyst{status.data?.provider ? ` (${status.data.provider}: ${model})` : ""}
          {security ? ` · context: ${security}${contextFn ? ` ${contextFn}` : ""}` : ""} · functions it opens appear in the next panel
        </span>
        <button
          className={deep ? "tool-button active" : "tool-button"}
          data-testid="ask-deep"
          aria-pressed={deep}
          title="Deep research: plans multi-step analyses with more tool calls (or type ?? question on any command line)"
          onClick={() => setDeep(!deep)}
          disabled={busy}
        >
          Deep
        </button>
        {turns.length > 0 && (
          <button className="tool-button" onClick={() => setTurns([])} disabled={busy}>
            Clear
          </button>
        )}
      </div>
      <div className="chat-log ask-log" ref={log} data-testid="ask-log">
        {!turns.length && (
          <div className="gray">
            Ask anything about markets, securities or your portfolios. Examples: "compare AAPL and MSFT margins", "why did oil move today?",
            "draft a 60/40 model portfolio", "what is my Core portfolio's biggest risk?". From any screen, type ? question on the command line, or
            ?? question for deep research that plans and runs a multi-step analysis.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={t.role === "user" ? "ask-user" : "ask-assistant"}>
            {t.role === "user" ? (
              <div>
                <span className="yellow">{user}&gt;</span> {t.depth === "deep" && <span>[DEEP] </span>}
                <span className="white">{t.content}</span>
              </div>
            ) : (
              <>
                {t.tools.map((tool, j) => (
                  <div key={j} className={tool.ok ? "ask-tool" : "ask-tool down"} data-testid="ask-tool">
                    {tool.ok ? "»" : "×"} {tool.summary}
                  </div>
                ))}
                <Rich text={t.content || (busy && i === turns.length - 1 ? "..." : "")} />
                {t.content && !(busy && i === turns.length - 1) && <button className="tool-button" data-testid="ask-capture" onClick={() => captureInNotebook(panel.id, {
                  kind: "note", title: `Research answer: ${turns[i - 1]?.content ?? "Market research"}`.slice(0, 200),
                  ...(t.provenance?.security ? { security: t.provenance.security } : {}), source: "AI analyst answer (verify against cited sources)",
                  data: { question: turns[i - 1]?.content ?? "", answer: t.content, sources: t.sources, provenance: t.provenance ?? null },
                })}>Capture answer in notebook</button>}
                {t.sources.length > 0 && <Sources sources={t.sources} />}
                {t.actions.map((a, j) =>
                  a.type === "draft_alert" ? (
                    <AlertButton key={j} action={a} state={t.actionState[j]} onCreate={() => void createAlert(i, j, a)} />
                  ) : (
                    <button key={j} className="tool-button" data-testid="ask-action" onClick={() => runAction(a)}>
                      {actionLabel(a)}
                    </button>
                  ),
                )}
                {t.error && <div className="cmdline-message">{t.error}</div>}
              </>
            )}
          </div>
        ))}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          const q = draft;
          setDraft("");
          void send(q, deep ? "deep" : "quick");
        }}
      >
        <input
          className="form-input grow"
          placeholder={busy ? "Thinking..." : deep ? "Deep research question (Enter to send, Esc for command line)" : "Ask a question (Enter to send, Esc for command line)"}
          value={draft}
          data-testid="ask-input"
          onChange={(e) => setDraft(e.target.value)}
        />
        {busy && (
          <button type="button" className="tool-button danger" onClick={() => abort.current?.abort()}>
            Stop
          </button>
        )}
      </form>
    </div>
  );
}
