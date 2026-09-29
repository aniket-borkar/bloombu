import type express from "express";
import { normalizeUser } from "../chat/chat.js";
import { BqlError } from "../research/bql.js";
import { normalizeSecurity } from "../symbology.js";
import type { LlmClient, Msg, ToolCall } from "./llm.js";
import { TOOLS, TOOL_BY_NAME, ToolError, coerceArgs, pluginToolDefs, type ClientAction, type Source, type ToolContext, type ToolDef, type ToolOutput } from "./tools.js";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool"; name: string; args: Record<string, unknown>; summary: string; ok: boolean; sources?: Source[] }
  | { type: "action"; action: ClientAction }
  | { type: "error"; message: string }
  | { type: "done" };

/** Quick answers look a few things up; deep research (?? on the command line) plans and runs longer analyses. */
export type Depth = "quick" | "deep";

export const MAX_TOOL_ROUNDS = 6;
export const DEEP_TOOL_ROUNDS = 15;
const MAX_TOOL_RESULT: Record<Depth, number> = { quick: 8_000, deep: 16_000 };
const MAX_HISTORY = 12;

export function systemPrompt(context: { security: string | null; fn: string | null; user: string | null }, now: Date, depth: Depth = "quick"): string {
  return [
    "You are the analyst assistant inside BLMBU, a Bloomberg-style market terminal.",
    "Use the provided tools to fetch data; never invent prices, figures or dates. If a tool fails or data is missing, say so.",
    'Securities use Bloomberg-style tickers: "AAPL US Equity", "VOD LN Equity", "SPX Index", "EURUSD Curncy", "CL1 Comdty". Use search_securities when unsure.',
    "When the user asks to see, show, chart or open something, call open_function with the right mnemonic (GP chart, DES description, FA financials, ANR analysts, OMON options, GC yield curves, WEI world indices, PORT portfolios, MEMB index members, WIRP Fed rate probabilities, FRD FX forwards, QR live trades, TRADE paper trading, BRIEF daily briefing, SRC data sources).",
    "When asked to build or draft a portfolio, call draft_portfolio; the user reviews and saves it.",
    "To screen or filter securities, write a query with run_bql. When asked to set up an alert, call draft_alert; the user confirms it with a button.",
    "For questions about filings, disclosures, risk factors, guidance or long financial histories, use filing tools when they are available and cite the filing.",
    "For trading rules, signals, backtests, correlation, beta, factor exposure or risk, compute with run_backtest, evaluate_rule and analyze_returns instead of estimating, and point out in-sample bias and small samples.",
    "Call tools through the tool-calling interface, never by writing JSON in your reply, and pass lists as JSON arrays.",
    "Be concise: short paragraphs or bullet points, key numbers with units and dates. Mention that free data may be delayed when timing matters.",
    "This is information, not personalized investment advice.",
    depth === "deep"
      ? "This is a deep research request. For a multi-step question, first state a short numbered plan (2 to 5 steps), then carry it out with tools, running independent lookups in the same turn. Cite the source and date of each figure, and say what the evidence does not show."
      : "",
    `Current date: ${now.toISOString().slice(0, 10)}. User: ${context.user ?? "guest"}.`,
    context.security || context.fn
      ? `The user's panel currently shows ${[context.security, context.fn].filter(Boolean).join(" ")}; "this" or "it" likely refers to it.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A tool call written into the reply as JSON, as Llama models sometimes do: {"name": ..., "parameters": {...}}. */
export function parseTextToolCall(text: string, names: Set<string>): { name: string; args: Record<string, unknown> } | null {
  const body = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { name, parameters, arguments: argsField } = parsed as Record<string, unknown>;
  let args = parameters ?? argsField ?? {};
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (typeof name !== "string" || !names.has(name) || !args || typeof args !== "object" || Array.isArray(args)) return null;
  return { name, args: args as Record<string, unknown> };
}

/**
 * Streams reply text, holding it back from the first line that starts with
 * "{" or a code fence, which may turn out to be a tool call written as text.
 */
class HoldBack {
  private held: string | null = null;
  private lineStart = true;

  constructor(private emit: (delta: string) => void) {}

  push(delta: string): void {
    if (this.held !== null) {
      this.held += delta;
      return;
    }
    let i = 0;
    for (; i < delta.length; i++) {
      const ch = delta[i];
      if (this.lineStart && (ch === "{" || ch === "`")) break;
      if (ch === "\n") this.lineStart = true;
      else if (ch !== " " && ch !== "\t" && ch !== "\r") this.lineStart = false;
    }
    if (i > 0) this.emit(delta.slice(0, i));
    if (i < delta.length) this.held = delta.slice(i);
  }

  /** The held text (empty if none), resetting for the next turn. */
  take(): string {
    const held = this.held ?? "";
    this.held = null;
    this.lineStart = true;
    return held;
  }
}

export interface AgentRequest {
  question: string;
  history: { role: "user" | "assistant"; content: string }[];
  context: { security: string | null; fn: string | null };
  depth?: Depth;
}

type ToolRun = { call: ToolCall; args: Record<string, unknown>; content: string } & ({ out: ToolOutput } | { error: string });

export async function runAgent(
  llm: LlmClient,
  req: AgentRequest,
  ctx: ToolContext,
  emit: (e: AgentEvent) => void,
  signal: AbortSignal,
  tools: ToolDef[] = TOOLS,
  maxRounds = req.depth === "deep" ? DEEP_TOOL_ROUNDS : MAX_TOOL_ROUNDS,
): Promise<void> {
  const depth = req.depth ?? "quick";
  const limit = MAX_TOOL_RESULT[depth];
  const toolCtx: ToolContext = { ...ctx, maxResultChars: limit };
  const messages: Msg[] = [
    { role: "system", content: systemPrompt({ ...req.context, user: ctx.user }, new Date(ctx.now()), depth) },
    ...req.history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content }) as Msg),
    { role: "user", content: req.question },
  ];
  const specs = tools.map((t) => t.spec);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const names = new Set(byName.keys());
  const hold = new HoldBack((delta) => emit({ type: "text", delta }));

  try {
    for (let round = 0; round <= maxRounds; round++) {
      const finalRound = round === maxRounds;
      let streamed = false;
      const turn = await llm.complete(
        messages,
        finalRound ? [] : specs,
        (delta) => {
          streamed = true;
          hold.push(delta);
        },
        signal,
      );
      if (!streamed && turn.text) hold.push(turn.text);
      let text = turn.text;
      let calls = turn.toolCalls;
      const held = hold.take();
      if (held) {
        const textCall = !calls.length && !finalRound ? parseTextToolCall(held, names) : null;
        if (textCall) {
          calls = [{ id: `text-call-${round}`, ...textCall }];
          text = text.endsWith(held) ? text.slice(0, text.length - held.length).trimEnd() : text;
        } else {
          emit({ type: "text", delta: held });
        }
      }
      messages.push({ role: "assistant", content: text, toolCalls: calls });
      if (!calls.length || finalRound) break;
      const runs = await Promise.all(
        calls.map(async (call): Promise<ToolRun> => {
          const tool = byName.get(call.name) ?? TOOL_BY_NAME.get(call.name);
          const args = tool ? coerceArgs(tool.spec, call.args) : call.args;
          try {
            if (!tool) throw new ToolError(`Unknown tool ${call.name}`);
            const out = await tool.run(args, toolCtx);
            return { call, args, out, content: JSON.stringify(out.result) };
          } catch (err) {
            const error = err instanceof ToolError || err instanceof BqlError ? err.message : `tool failed: ${(err as Error).message}`;
            return { call, args, error, content: JSON.stringify({ error }) };
          }
        }),
      );
      for (const run of runs) {
        const { call, args } = run;
        if ("out" in run) {
          const { summary, action, sources } = run.out;
          emit({ type: "tool", name: call.name, args, summary, ok: true, ...(sources?.length ? { sources } : {}) });
          if (action) emit({ type: "action", action });
        } else {
          emit({ type: "tool", name: call.name, args, summary: run.error, ok: false });
        }
        const content = run.content.length > limit ? `${run.content.slice(0, limit)}... (truncated)` : run.content;
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
      }
    }
  } catch (err) {
    if (!signal.aborted) emit({ type: "error", message: (err as Error).message });
  }
  emit({ type: "done" });
}

export function registerAiRoutes(app: express.Express, llm: LlmClient | null, ctx: Omit<ToolContext, "user">, deepLlm: LlmClient | null = llm): void {
  const tools = [...TOOLS, ...pluginToolDefs(ctx.plugins)];

  app.get("/api/ai/status", (_req, res) => {
    res.json(
      llm
        ? { enabled: true, provider: llm.name, model: llm.model, deepModel: (deepLlm ?? llm).model }
        : { enabled: false, provider: null, model: null, deepModel: null },
    );
  });

  app.post("/api/ai/ask", async (req, res) => {
    if (!llm) {
      res.status(503).json({ error: "AI is not configured. Set AI_PROVIDER (openai, anthropic, ollama or mock) in .env." });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question || question.length > 4000) {
      res.status(400).json({ error: "question is required (up to 4000 characters)" });
      return;
    }
    const history = Array.isArray(body.history)
      ? (body.history as { role?: unknown; content?: unknown }[])
          .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
          .map((m) => ({ role: m.role as "user" | "assistant", content: (m.content as string).slice(0, 8000) }))
      : [];
    const context = (body.context ?? {}) as { security?: unknown; fn?: unknown };
    const depth: Depth = body.depth === "deep" ? "deep" : "quick";
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const emit = (e: AgentEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    await runAgent(
      depth === "deep" ? (deepLlm ?? llm) : llm,
      {
        question,
        history,
        context: {
          security: typeof context.security === "string" ? normalizeSecurity(context.security) : null,
          fn: typeof context.fn === "string" && /^[A-Z][A-Z0-9]{0,7}$/.test(context.fn) ? context.fn : null,
        },
        depth,
      },
      { ...ctx, user: normalizeUser(body.user) },
      emit,
      controller.signal,
      tools,
    );
    res.end();
  });
}
