import type { AlertInfo, PortfolioInput } from "./api";

export type DraftAlert = Pick<AlertInfo, "security" | "kind" | "value" | "expr" | "note">;

export type ClientAction =
  | { type: "open"; security: string | null; fn: string }
  | { type: "draft_portfolio"; portfolio: PortfolioInput }
  | { type: "open_backtest"; security: string; entry: string; exit: string; direction: "long" | "short"; costBps: number; range: "1y" | "2y" | "5y" }
  | { type: "open_bql"; query: string }
  | { type: "draft_alert"; alert: DraftAlert; label: string };

export type Depth = "quick" | "deep";

export interface Source {
  label: string;
  url?: string;
  asOf?: string;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; summary: string; ok: boolean; sources?: Source[] }
  | { type: "action"; action: ClientAction }
  | { type: "error"; message: string }
  | { type: "done" };

export interface AskRequest {
  question: string;
  user: string;
  history: { role: "user" | "assistant"; content: string }[];
  context: { security: string | null; fn: string | null };
  depth: Depth;
}

/** POST a question and stream agent events (Server-Sent Events) until done. */
export async function askStream(req: AskRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch("/api/ai/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `AI request failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}

const pending = new Map<number, { question: string; depth: Depth }>();

/** Queue a question for the ASK screen that is about to open in `panelId`. */
export function setPendingQuestion(panelId: number, question: string, depth: Depth = "quick"): void {
  pending.set(panelId, { question, depth });
}

export function takePendingQuestion(panelId: number): { question: string; depth: Depth } | null {
  const q = pending.get(panelId) ?? null;
  pending.delete(panelId);
  return q;
}
