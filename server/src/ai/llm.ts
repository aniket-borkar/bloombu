export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Msg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface LlmTurn {
  text: string;
  toolCalls: ToolCall[];
}

export interface LlmClient {
  readonly name: string;
  readonly model: string;
  complete(messages: Msg[], tools: ToolSpec[], onText: (delta: string) => void, signal: AbortSignal): Promise<LlmTurn>;
}

export class LlmError extends Error {}

/** Incremental Server-Sent Events decoder: feed text chunks, get complete events. */
export class SseDecoder {
  private buffer = "";

  push(chunk: string): { event: string | null; data: string }[] {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    const out: { event: string | null; data: string }[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) >= 0) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) out.push({ event, data: data.join("\n") });
    }
    return out;
  }
}

async function* readStream(res: Response, signal: AbortSignal): AsyncGenerator<{ event: string | null; data: string }> {
  if (!res.body) throw new LlmError("empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  try {
    while (true) {
      if (signal.aborted) throw new LlmError("aborted");
      const { value, done } = await reader.read();
      if (done) break;
      for (const e of sse.push(decoder.decode(value, { stream: true }))) yield e;
    }
    for (const e of sse.push("\n\n")) yield e;
  } finally {
    reader.releaseLock();
  }
}

const MAX_ATTEMPTS = 3;
/** A longer retry-after (such as an exhausted daily quota) fails right away instead of stalling the answer. */
const MAX_RETRY_WAIT_MS = 20_000;

/** Wait before retry number `attempt` (from 1): the retry-after header in seconds or as a date, else 1 s, 2 s, 4 s. */
export function retryDelayMs(retryAfter: string | null, attempt: number, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** (attempt - 1);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new LlmError("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new LlmError("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** POST, retrying rate limits (429) and provider errors (5xx) up to MAX_ATTEMPTS times. */
async function postWithRetry(url: string, init: { headers: Record<string, string>; body: string }, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: init.headers, body: init.body, signal });
    if (res.ok || attempt >= MAX_ATTEMPTS || (res.status !== 429 && res.status < 500)) return res;
    const wait = retryDelayMs(res.headers.get("retry-after"), attempt);
    if (wait > MAX_RETRY_WAIT_MS) return res;
    await res.body?.cancel();
    await sleep(wait, signal);
  }
}

async function failure(res: Response, provider: string): Promise<LlmError> {
  const text = await res.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text);
    detail = j.error?.message ?? j.message ?? detail;
  } catch {
    // keep raw text
  }
  return new LlmError(`${provider} returned ${res.status}: ${detail}`);
}

const parseArgs = (s: string): Record<string, unknown> => {
  if (!s.trim()) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

// ---------------------------------------------------------------- OpenAI-compatible

export interface OpenAiChunk {
  choices?: { delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
  error?: { message?: string };
}

/** Accumulates streamed chat-completion chunks into text and tool calls. */
export class OpenAiAccumulator {
  text = "";
  private calls = new Map<number, { id: string; name: string; args: string }>();

  add(chunk: OpenAiChunk, onText: (d: string) => void): void {
    if (chunk.error) throw new LlmError(chunk.error.message ?? "provider error");
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      this.text += delta.content;
      onText(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const c = this.calls.get(tc.index) ?? { id: "", name: "", args: "" };
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
      this.calls.set(tc.index, c);
    }
  }

  result(): LlmTurn {
    return {
      text: this.text,
      toolCalls: [...this.calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, args: parseArgs(c.args) })),
    };
  }
}

export function toOpenAiMessages(messages: Msg[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

export function createOpenAiClient(opts: { baseUrl: string; apiKey: string; model: string; name: string }): LlmClient {
  return {
    name: opts.name,
    model: opts.model,
    async complete(messages, tools, onText, signal) {
      const res = await postWithRetry(
        `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            messages: toOpenAiMessages(messages),
            stream: true,
            ...(tools.length
              ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: "auto" }
              : {}),
          }),
        },
        signal,
      );
      if (!res.ok) throw await failure(res, opts.name);
      const acc = new OpenAiAccumulator();
      for await (const { data } of readStream(res, signal)) {
        if (data === "[DONE]") break;
        acc.add(JSON.parse(data) as OpenAiChunk, onText);
      }
      return acc.result();
    },
  };
}

// ---------------------------------------------------------------- Anthropic

export interface AnthropicEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; text?: string };
  delta?: { type: string; text?: string; partial_json?: string };
  error?: { message?: string };
}

export class AnthropicAccumulator {
  text = "";
  private blocks = new Map<number, { type: string; id: string; name: string; json: string }>();

  add(e: AnthropicEvent, onText: (d: string) => void): void {
    if (e.type === "error") throw new LlmError(e.error?.message ?? "provider error");
    if (e.type === "content_block_start" && e.index !== undefined && e.content_block) {
      const b = e.content_block;
      this.blocks.set(e.index, { type: b.type, id: b.id ?? "", name: b.name ?? "", json: "" });
      if (b.type === "text" && b.text) {
        this.text += b.text;
        onText(b.text);
      }
    } else if (e.type === "content_block_delta" && e.index !== undefined && e.delta) {
      if (e.delta.type === "text_delta" && e.delta.text) {
        this.text += e.delta.text;
        onText(e.delta.text);
      } else if (e.delta.type === "input_json_delta") {
        const b = this.blocks.get(e.index);
        if (b) b.json += e.delta.partial_json ?? "";
      }
    }
  }

  result(): LlmTurn {
    return {
      text: this.text,
      toolCalls: [...this.blocks.entries()]
        .filter(([, b]) => b.type === "tool_use")
        .sort(([a], [b]) => a - b)
        .map(([, b]) => ({ id: b.id, name: b.name, args: parseArgs(b.json) })),
    };
  }
}

export function toAnthropicRequest(messages: Msg[]): { system: string; messages: unknown[] } {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const out: { role: "user" | "assistant"; content: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const block = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      const last = out[out.length - 1];
      if (last?.role === "user" && (last.content[0] as { type?: string })?.type === "tool_result") last.content.push(block);
      else out.push({ role: "user", content: [block] });
    } else if (m.role === "assistant") {
      const content: unknown[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: "user", content: [{ type: "text", text: m.content }] });
    }
  }
  return { system, messages: out };
}

export function createAnthropicClient(opts: { baseUrl: string; apiKey: string; model: string }): LlmClient {
  return {
    name: "anthropic",
    model: opts.model,
    async complete(messages, tools, onText, signal) {
      const { system, messages: msgs } = toAnthropicRequest(messages);
      const res = await postWithRetry(
        `${opts.baseUrl.replace(/\/$/, "")}/v1/messages`,
        {
          headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: 2048,
            system,
            messages: msgs,
            stream: true,
            ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
          }),
        },
        signal,
      );
      if (!res.ok) throw await failure(res, "anthropic");
      const acc = new AnthropicAccumulator();
      for await (const { data } of readStream(res, signal)) acc.add(JSON.parse(data) as AnthropicEvent, onText);
      return acc.result();
    },
  };
}
