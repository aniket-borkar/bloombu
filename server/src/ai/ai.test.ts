import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { HistoryCache } from "../history/cache.js";
import { emptyRegistry } from "../plugins/loader.js";
import { PortfolioService } from "../portfolio/service.js";
import { PortfolioStore, validatePortfolio } from "../portfolio/store.js";
import { createMockProvider } from "../providers/mock.js";
import { ProviderRouter } from "../providers/router.js";
import { FieldService } from "../research/fields.js";
import { DEEP_TOOL_ROUNDS, parseTextToolCall, registerAiRoutes, runAgent, systemPrompt, type AgentEvent } from "./agent.js";
import { createDeepLlm, createLlm } from "./index.js";
import {
  AnthropicAccumulator,
  OpenAiAccumulator,
  SseDecoder,
  createAnthropicClient,
  createOpenAiClient,
  retryDelayMs,
  toAnthropicRequest,
  toOpenAiMessages,
  type LlmClient,
  type Msg,
} from "./llm.js";
import { createMockLlm } from "./mockLlm.js";
import { TOOL_BY_NAME, coerceArgs, type ToolContext, type ToolDef } from "./tools.js";

const T = Date.UTC(2026, 8, 25, 15, 30);
const router = new ProviderRouter([createMockProvider(() => T)], () => {});
const history = new HistoryCache(":memory:", (s, i, f, t) => router.history(s, i, f, t), () => T);
const portfolios = new PortfolioStore(":memory:");
portfolios.create("ALICE", validatePortfolio({ name: "Core", kind: "positions", holdings: [{ security: "AAPL US Equity", quantity: 10 }] }));
const ctxBase = { router, fields: new FieldService(router), history, portfolios, portfolioService: new PortfolioService(router, history, () => T), now: () => T };
const ctx: ToolContext = { ...ctxBase, user: "ALICE" };

describe("SseDecoder", () => {
  it("reassembles events split across chunks", () => {
    const d = new SseDecoder();
    expect(d.push("event: a\ndata: {\"x\"")).toEqual([]);
    expect(d.push(":1}\n\ndata: second\r\n\r\ndata: tail")).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: null, data: "second" },
    ]);
    expect(d.push("\n\n")).toEqual([{ event: null, data: "tail" }]);
  });
});

describe("stream accumulators", () => {
  it("builds OpenAI text and tool calls from deltas", () => {
    const acc = new OpenAiAccumulator();
    const text: string[] = [];
    const chunks = [
      { choices: [{ delta: { content: "Hel" } }] },
      { choices: [{ delta: { content: "lo" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_fields", arguments: '{"secur' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ities":["AAPL US Equity"]}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "c2", function: { name: "open_function", arguments: '{"function":"GP"}' } }] } }] },
    ];
    for (const c of chunks) acc.add(c, (d) => text.push(d));
    expect(text.join("")).toBe("Hello");
    expect(acc.result()).toEqual({
      text: "Hello",
      toolCalls: [
        { id: "c1", name: "get_fields", args: { securities: ["AAPL US Equity"] } },
        { id: "c2", name: "open_function", args: { function: "GP" } },
      ],
    });
  });

  it("builds Anthropic text and tool_use blocks", () => {
    const acc = new AnthropicAccumulator();
    const events = [
      { type: "message_start" },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu1", name: "get_profile" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"security":' } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"MSFT US Equity"}' } },
      { type: "message_stop" },
    ];
    for (const e of events) acc.add(e, () => {});
    expect(acc.result()).toEqual({ text: "Checking", toolCalls: [{ id: "tu1", name: "get_profile", args: { security: "MSFT US Equity" } }] });
    expect(() => acc.add({ type: "error", error: { message: "overloaded" } }, () => {})).toThrow("overloaded");
  });
});

describe("message mapping", () => {
  const msgs: Msg[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
    { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", args: { k: 1 } }, { id: "b", name: "y", args: {} }] },
    { role: "tool", toolCallId: "a", name: "x", content: "ra" },
    { role: "tool", toolCallId: "b", name: "y", content: "rb" },
  ];

  it("maps to OpenAI chat format", () => {
    const out = toOpenAiMessages(msgs) as Record<string, unknown>[];
    expect(out[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "a", type: "function", function: { name: "x", arguments: '{"k":1}' } },
        { id: "b", type: "function", function: { name: "y", arguments: "{}" } },
      ],
    });
    expect(out[3]).toEqual({ role: "tool", tool_call_id: "a", content: "ra" });
  });

  it("maps to Anthropic format, merging consecutive tool results", () => {
    const { system, messages } = toAnthropicRequest(msgs);
    expect(system).toBe("sys");
    expect(messages).toEqual([
      { role: "user", content: [{ type: "text", text: "q" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "x", input: { k: 1 } }, { type: "tool_use", id: "b", name: "y", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "ra" },
          { type: "tool_result", tool_use_id: "b", content: "rb" },
        ],
      },
    ]);
  });
});

describe("streaming clients against a fake provider", () => {
  let fake: Server;
  let url: string;
  const seen: { path: string; headers: Record<string, unknown>; body: Record<string, unknown> }[] = [];
  let flakyCalls = 0;

  beforeAll(async () => {
    fake = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        seen.push({ path: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
        if (req.url === "/v1/chat/completions" && req.headers.authorization === "Bearer bad") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "invalid key" } }));
          return;
        }
        if ((req.url === "/flaky/v1/chat/completions" && flakyCalls++ === 0) || req.url === "/down/v1/chat/completions") {
          const limited = req.url.startsWith("/flaky");
          res.writeHead(limited ? 429 : 503, { "content-type": "application/json", "retry-after": "0" });
          res.end(JSON.stringify({ error: { message: limited ? "slow down" : "overloaded" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (req.url?.endsWith("/chat/completions")) {
          res.write('data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n');
          res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t","function":{"name":"get_quotes","arguments":"{}"}}]}}]}\n\n');
          res.end("data: [DONE]\n\n");
        } else {
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Yo"}}\n\n');
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        }
      });
    });
    await new Promise<void>((r) => fake.listen(0, r));
    url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    fake.close();
  });

  it("streams from an OpenAI-compatible endpoint (incl. Ollama)", async () => {
    const llm = createOpenAiClient({ baseUrl: `${url}/v1`, apiKey: "k", model: "m1", name: "ollama" });
    const deltas: string[] = [];
    const turn = await llm.complete([{ role: "user", content: "q" }], [{ name: "get_quotes", description: "d", parameters: { type: "object" } }], (d) => deltas.push(d), new AbortController().signal);
    expect(turn).toEqual({ text: "Hi ", toolCalls: [{ id: "t", name: "get_quotes", args: {} }] });
    expect(deltas).toEqual(["Hi "]);
    const req = seen.at(-1)!;
    expect(req.headers.authorization).toBe("Bearer k");
    expect(req.body).toMatchObject({ model: "m1", stream: true, tool_choice: "auto" });
  });

  it("reports provider errors with the provider's message", async () => {
    const llm = createOpenAiClient({ baseUrl: `${url}/v1`, apiKey: "bad", model: "m1", name: "openai" });
    const before = seen.length;
    await expect(llm.complete([{ role: "user", content: "q" }], [], () => {}, new AbortController().signal)).rejects.toThrow("openai returned 401: invalid key");
    expect(seen.length - before).toBe(1);
  });

  it("retries rate limits and provider errors, then gives up after three attempts", async () => {
    const flaky = createOpenAiClient({ baseUrl: `${url}/flaky/v1`, apiKey: "k", model: "m1", name: "openai" });
    let before = seen.length;
    expect((await flaky.complete([{ role: "user", content: "q" }], [], () => {}, new AbortController().signal)).text).toBe("Hi ");
    expect(seen.length - before).toBe(2);

    const down = createOpenAiClient({ baseUrl: `${url}/down/v1`, apiKey: "k", model: "m1", name: "openai" });
    before = seen.length;
    await expect(down.complete([{ role: "user", content: "q" }], [], () => {}, new AbortController().signal)).rejects.toThrow("openai returned 503: overloaded");
    expect(seen.length - before).toBe(3);
  });

  it("waits as long as retry-after says, else backs off exponentially", () => {
    expect(retryDelayMs("2", 1)).toBe(2000);
    expect(retryDelayMs(new Date(10_000).toUTCString(), 1, 4_000)).toBe(6_000);
    expect(retryDelayMs(null, 1)).toBe(1000);
    expect(retryDelayMs("soon", 3)).toBe(4000);
  });

  it("streams from the Anthropic Messages API", async () => {
    const llm = createAnthropicClient({ baseUrl: url, apiKey: "ak", model: "claude-x" });
    const turn = await llm.complete([{ role: "system", content: "s" }, { role: "user", content: "q" }], [], () => {}, new AbortController().signal);
    expect(turn.text).toBe("Yo");
    const req = seen.at(-1)!;
    expect(req.path).toBe("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("ak");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.body).toMatchObject({ model: "claude-x", system: "s", stream: true, max_tokens: 2048 });
  });
});

async function collect(llm: LlmClient, question: string, c: ToolContext = ctx, maxRounds?: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  await runAgent(llm, { question, history: [], context: { security: null, fn: null } }, c, (e) => events.push(e), new AbortController().signal, undefined, maxRounds);
  return events;
}

describe("runAgent with the mock model", () => {
  it("calls tools, emits an action, then answers", async () => {
    const events = await collect(createMockLlm(), "compare AAPL and MSFT on a chart");
    const tools = events.filter((e) => e.type === "tool") as Extract<AgentEvent, { type: "tool" }>[];
    expect(tools.map((t) => [t.name, t.ok])).toEqual([
      ["get_fields", true],
      ["open_function", true],
    ]);
    expect(events.find((e) => e.type === "action")).toEqual({ type: "action", action: { type: "open", security: "AAPL US Equity", fn: "GP" } });
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toContain("get_fields");
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("drafts portfolios and lists the user's portfolios", async () => {
    const draft = await collect(createMockLlm(), "draft a portfolio of AAPL and NVDA");
    const action = draft.find((e) => e.type === "action") as Extract<AgentEvent, { type: "action" }>;
    expect(action.action).toMatchObject({ type: "draft_portfolio", portfolio: { kind: "model", holdings: [{ security: "AAPL US Equity" }, { security: "NVDA US Equity" }] } });
    const list = await collect(createMockLlm(), "what portfolios do I have?");
    expect(list.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("Core");
  });

  it("scripts the research tools the end-to-end tests exercise", async () => {
    const action = async (q: string) => (await collect(createMockLlm(), q)).find((e) => e.type === "action") as Extract<AgentEvent, { type: "action" }> | undefined;
    expect((await action("backtest a trend rule on AAPL"))?.action).toMatchObject({ type: "open_backtest", security: "AAPL US Equity", entry: "close > sma(close, 50)" });
    expect((await action("set an alert when AAPL crosses its 50 day average"))?.action).toMatchObject({ type: "draft_alert", alert: { security: "AAPL US Equity", kind: "rule" } });
    expect((await action("screen AAPL and MSFT with bql"))?.action).toMatchObject({ type: "open_bql", query: expect.stringContaining("list('AAPL US Equity', 'MSFT US Equity')") });
    const beta = await collect(createMockLlm(), "what is the beta of AAPL");
    expect(beta.find((e) => e.type === "tool")).toMatchObject({ name: "analyze_returns", ok: true });
    expect(beta.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("| Tool | Result characters |");
  });

  it("reports tool errors to the model instead of failing", async () => {
    const scripted: LlmClient = {
      name: "scripted",
      model: "s",
      async complete(messages) {
        const last = messages[messages.length - 1];
        if (last.role === "tool") return { text: `saw: ${last.content}`, toolCalls: [] };
        return { text: "", toolCalls: [{ id: "1", name: "get_profile", args: { security: "not a ticker" } }] };
      },
    };
    const events = await collect(scripted, "q");
    expect(events.find((e) => e.type === "tool")).toMatchObject({ ok: false });
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toContain("is not a security");
  });

  it("stops calling tools after the round limit and forces a final answer", async () => {
    let calls = 0;
    const looping: LlmClient = {
      name: "loop",
      model: "l",
      async complete(_m, tools, onText) {
        calls++;
        if (!tools.length) {
          onText("final");
          return { text: "final", toolCalls: [] };
        }
        return { text: "", toolCalls: [{ id: String(calls), name: "get_yield_curve", args: {} }] };
      },
    };
    const events = await collect(looping, "q", ctx, 2);
    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === "tool")).toHaveLength(2);
    expect(events.find((e) => e.type === "text")).toEqual({ type: "text", delta: "final" });
  });

  it("surfaces provider failures as an error event", async () => {
    const failing: LlmClient = { name: "f", model: "f", complete: async () => Promise.reject(new Error("anthropic returned 529: overloaded")) };
    const events = await collect(failing, "q");
    expect(events).toEqual([{ type: "error", message: "anthropic returned 529: overloaded" }, { type: "done" }]);
  });
});

describe("deep research", () => {
  it("runs a round's tool calls concurrently, reporting them in order with their sources", async () => {
    let active = 0;
    let peak = 0;
    const slow = (name: string): ToolDef => ({
      spec: { name, description: name, parameters: { type: "object", properties: {} } },
      async run() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return { result: { name }, summary: `ran ${name}`, sources: name === "slow_a" ? [{ label: "Test feed", asOf: "2026-09-25" }] : undefined };
      },
    });
    const llm: LlmClient = {
      name: "x",
      model: "x",
      async complete(messages) {
        if (messages[messages.length - 1].role === "tool") return { text: "done", toolCalls: [] };
        return { text: "", toolCalls: [{ id: "1", name: "slow_a", args: {} }, { id: "2", name: "slow_b", args: {} }] };
      },
    };
    const events: AgentEvent[] = [];
    const req = { question: "q", history: [], context: { security: null, fn: null } };
    await runAgent(llm, req, ctx, (e) => events.push(e), new AbortController().signal, [slow("slow_a"), slow("slow_b")]);
    expect(peak).toBe(2);
    const tools = events.filter((e) => e.type === "tool") as Extract<AgentEvent, { type: "tool" }>[];
    expect(tools.map((t) => t.name)).toEqual(["slow_a", "slow_b"]);
    expect(tools[0].sources).toEqual([{ label: "Test feed", asOf: "2026-09-25" }]);
    expect(tools[1]).not.toHaveProperty("sources");
  });

  it("gives deep questions more tool rounds and a planning prompt", async () => {
    let calls = 0;
    let system = "";
    const looping: LlmClient = {
      name: "loop",
      model: "l",
      async complete(messages, tools, onText) {
        calls++;
        system = (messages[0] as { content: string }).content;
        if (!tools.length) {
          onText("final");
          return { text: "final", toolCalls: [] };
        }
        return { text: "", toolCalls: [{ id: String(calls), name: "get_yield_curve", args: {} }] };
      },
    };
    const req = { question: "q", history: [], context: { security: null, fn: null }, depth: "deep" as const };
    await runAgent(looping, req, ctx, () => {}, new AbortController().signal);
    expect(calls).toBe(DEEP_TOOL_ROUNDS + 1);
    expect(system).toContain("deep research request");
    expect(systemPrompt({ security: null, fn: null, user: null }, new Date(T))).not.toContain("deep research");
  });
});

describe("small local models", () => {
  const textOf = (events: AgentEvent[]) => events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");

  it("coerces string arguments to the arrays and numbers the schema declares", () => {
    const fields = TOOL_BY_NAME.get("get_fields")!.spec;
    expect(coerceArgs(fields, { securities: "AAPL US Equity", fields: "['PX_LAST', 'PE_RATIO']" })).toEqual({
      securities: ["AAPL US Equity"],
      fields: ["PX_LAST", "PE_RATIO"],
    });
    expect(coerceArgs(fields, { securities: '["AAPL US Equity", "MSFT US Equity"]', fields: "PX_LAST, PE_RATIO" })).toEqual({
      securities: ["AAPL US Equity", "MSFT US Equity"],
      fields: ["PX_LAST", "PE_RATIO"],
    });
    const draft = TOOL_BY_NAME.get("draft_portfolio")!.spec;
    expect(coerceArgs(draft, { name: "x", holdings: "[{'security': 'SPY US Equity', 'weight': 60}]", notional: "1,000,000" })).toEqual({
      name: "x",
      holdings: [{ security: "SPY US Equity", weight: 60 }],
      notional: 1_000_000,
    });
  });

  it("recognizes tool calls written as JSON text", () => {
    const names = new Set(["get_fields"]);
    expect(parseTextToolCall('{"name": "get_fields", "parameters": {"securities": ["AAPL US Equity"]}}', names)).toEqual({
      name: "get_fields",
      args: { securities: ["AAPL US Equity"] },
    });
    expect(parseTextToolCall('```json\n{"name": "get_fields", "arguments": "{\\"fields\\": [\\"PX_LAST\\"]}"}\n```', names)).toEqual({
      name: "get_fields",
      args: { fields: ["PX_LAST"] },
    });
    expect(parseTextToolCall('{"name": "delete_everything", "parameters": {}}', names)).toBeNull();
    expect(parseTextToolCall("{not json", names)).toBeNull();
  });

  it("runs a tool call the model wrote as text, without showing the JSON", async () => {
    const seen: Msg[][] = [];
    const llama: LlmClient = {
      name: "llama",
      model: "l",
      async complete(messages, _tools, onText) {
        seen.push(messages);
        if (messages[messages.length - 1].role === "tool") {
          onText("Apple trades as ");
          onText("AAPL US Equity.");
          return { text: "Apple trades as AAPL US Equity.", toolCalls: [] };
        }
        const parts = ["Let me look that up.\n\n", '{"name": "search_securities", ', '"parameters": {"query": "apple"}}'];
        for (const p of parts) onText(p);
        return { text: parts.join(""), toolCalls: [] };
      },
    };
    const events = await collect(llama, "what is apple's ticker?");
    expect(textOf(events)).toBe("Let me look that up.\n\nApple trades as AAPL US Equity.");
    expect(events.find((e) => e.type === "tool")).toMatchObject({ name: "search_securities", ok: true });
    expect(seen[1].find((m) => m.role === "assistant")).toEqual({
      role: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ id: "text-call-0", name: "search_securities", args: { query: "apple" } }],
    });
  });

  it("still shows JSON-looking text that is not a tool call", async () => {
    const llm: LlmClient = {
      name: "x",
      model: "x",
      async complete(_m, _t, onText) {
        onText('Example:\n{"a": 1}');
        return { text: 'Example:\n{"a": 1}', toolCalls: [] };
      },
    };
    expect(textOf(await collect(llm, "q"))).toBe('Example:\n{"a": 1}');
  });
});

describe("AI routes", () => {
  let server: Server;
  let base: string;
  let off: Server;
  let offBase: string;
  let deepCalls = 0;
  const mock = createMockLlm();
  const deep: LlmClient = {
    name: "mock",
    model: "mock-deep",
    complete: (...args) => {
      deepCalls++;
      return mock.complete(...args);
    },
  };

  beforeAll(async () => {
    server = createApp({ router, history, routes: [(a) => registerAiRoutes(a, mock, ctxBase, deep)] }).listen(0);
    off = createApp({ router, history, routes: [(a) => registerAiRoutes(a, null, ctxBase)] }).listen(0);
    await Promise.all([server, off].map((s) => new Promise((r) => s.once("listening", r))));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    offBase = `http://127.0.0.1:${(off.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
    off.close();
  });

  it("streams agent events as SSE", async () => {
    const res = await fetch(`${base}/api/ai/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "show me IBM", user: "alice", context: { security: "AAPL US Equity", fn: "DES" } }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = new SseDecoder().push(await res.text()).map((e) => JSON.parse(e.data));
    expect(events.map((e) => e.type)).toContain("action");
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(deepCalls).toBe(0);
    expect(await (await fetch(`${base}/api/ai/status`)).json()).toEqual({ enabled: true, provider: "mock", model: "mock-analyst", deepModel: "mock-deep" });
  });

  it("answers deep questions with the deep research model", async () => {
    const res = await fetch(`${base}/api/ai/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "compare AAPL and MSFT", user: "alice", depth: "deep" }),
    });
    await res.text();
    expect(deepCalls).toBeGreaterThan(0);
  });

  it("explains how to enable AI when it is not configured", async () => {
    const res = await fetch(`${offBase}/api/ai/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "q" }) });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("AI_PROVIDER");
    expect((await fetch(`${base}/api/ai/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(400);
  });
});

describe("plugin AI tools", () => {
  it("are offered to the model and run with the router, a signal and cleaned-up sources", async () => {
    let seenSignal: AbortSignal | null = null;
    const plugins = {
      ...emptyRegistry(),
      aiTools: [
        {
          plugin: "demo",
          tool: {
            spec: { name: "demo_lookup", description: "Look something up", parameters: { type: "object", properties: { q: { type: "string" } } } },
            run: (args: Record<string, unknown>, c: { router: unknown; signal: AbortSignal }) => {
              expect(c.router).toBe(router);
              seenSignal = c.signal;
              return {
                result: { answer: `found ${args.q}` },
                summary: "Looked it up",
                sources: [{ label: "Doc", url: "https://example.com/doc", asOf: "2026-09-01" }, { label: "Bad link", url: "javascript:alert(1)" }, { url: "https://no-label" }],
              };
            },
          },
        },
      ],
    };
    const offered: string[][] = [];
    const llm: LlmClient = {
      name: "p",
      model: "p",
      async complete(messages, tools) {
        offered.push(tools.map((t) => t.name));
        if (messages[messages.length - 1].role === "tool") return { text: "done", toolCalls: [] };
        return { text: "", toolCalls: [{ id: "1", name: "demo_lookup", args: { q: "x" } }] };
      },
    };
    const app = createApp({ router, history, routes: [(a) => registerAiRoutes(a, llm, { ...ctxBase, plugins })] }).listen(0);
    await new Promise((r) => app.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/api/ai/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "look it up", user: "alice" }),
      });
      const events = new SseDecoder().push(await res.text()).map((e) => JSON.parse(e.data) as AgentEvent);
      expect(offered[0]).toContain("demo_lookup");
      expect(offered[0]).toContain("run_bql");
      expect(events.find((e) => e.type === "tool")).toEqual({
        type: "tool",
        name: "demo_lookup",
        args: { q: "x" },
        summary: "Looked it up",
        ok: true,
        sources: [{ label: "Doc", url: "https://example.com/doc", asOf: "2026-09-01" }, { label: "Bad link" }],
      });
      expect(seenSignal).toBeInstanceOf(AbortSignal);
    } finally {
      app.close();
    }
  });
});

describe("AI config", () => {
  it("validates provider settings", () => {
    expect(loadConfig({}).ai.provider).toBeNull();
    expect(loadConfig({ AI_PROVIDER: "mock" }).ai.provider).toBe("mock");
    expect(loadConfig({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.1" }).ai).toMatchObject({ provider: "ollama", model: "llama3.1" });
    expect(() => loadConfig({ AI_PROVIDER: "openai", AI_MODEL: "x" })).toThrow(/AI_API_KEY/);
    expect(() => loadConfig({ AI_PROVIDER: "anthropic", AI_API_KEY: "k" })).toThrow(/AI_MODEL/);
    expect(() => loadConfig({ AI_PROVIDER: "gemini" })).toThrow(/Unknown AI_PROVIDER/);
  });

  it("builds a separate deep research client only when AI_MODEL_DEEP names another model", () => {
    const ai = loadConfig({ AI_PROVIDER: "openai", AI_API_KEY: "k", AI_MODEL: "grok-4.3", AI_MODEL_DEEP: "grok-4.7" }).ai;
    expect(ai.deepModel).toBe("grok-4.7");
    const quick = createLlm(ai)!;
    expect(quick.model).toBe("grok-4.3");
    expect(createDeepLlm(ai, quick)!.model).toBe("grok-4.7");
    const plain = loadConfig({ AI_PROVIDER: "openai", AI_API_KEY: "k", AI_MODEL: "grok-4.3" }).ai;
    const only = createLlm(plain);
    expect(createDeepLlm(plain, only)).toBe(only);
    expect(createDeepLlm(loadConfig({}).ai, null)).toBeNull();
  });
});
