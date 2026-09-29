import type { LlmClient, Msg, ToolCall } from "./llm.js";

const STOP = new Set(["A", "I", "AND", "OR", "THE", "VS", "US", "TO", "OF", "IN", "IS", "FOR", "ME", "MY", "ON", "AT", "IT", "AI", "PE", "EPS", "ETF", "ASK"]);

function tickers(question: string): string[] {
  return [...new Set((question.match(/\b[A-Z]{1,5}\b/g) ?? []).filter((w) => !STOP.has(w)))].map((t) => `${t} US Equity`);
}

/**
 * Deterministic stand-in for a real model, used for development and CI. It
 * calls terminal tools based on keywords, then summarizes the tool results.
 */
export function createMockLlm(): LlmClient {
  return {
    name: "mock",
    model: "mock-analyst",
    async complete(messages: Msg[], tools, onText) {
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf("user");
      const question = (messages[lastUserIdx] as { content: string }).content;
      const results = messages.slice(lastUserIdx + 1).filter((m) => m.role === "tool") as Extract<Msg, { role: "tool" }>[];
      const available = new Set(tools.map((t) => t.name));

      if (!results.length && available.size) {
        const secs = tickers(question);
        const first = secs[0] ?? "AAPL US Equity";
        const calls: Omit<ToolCall, "id">[] = [];
        if (/portfolio/i.test(question) && /draft|create|build/i.test(question)) {
          const list = secs.length ? secs : ["AAPL US Equity", "MSFT US Equity"];
          calls.push({
            name: "draft_portfolio",
            args: { name: "AI Draft", kind: "model", holdings: list.map((s) => ({ security: s, weight: +(100 / list.length).toFixed(4) })) },
          });
        } else if (/portfolio/i.test(question)) {
          calls.push({ name: "list_portfolios", args: {} });
        } else if (/backtest/i.test(question)) {
          calls.push({ name: "run_backtest", args: { securities: secs.length ? secs : [first], entry: "close > sma(close, 50)", exit: "close < sma(close, 50)", range: "2y" } });
        } else if (/alert/i.test(question)) {
          calls.push({ name: "draft_alert", args: { security: first, kind: "rule", expr: "crossAbove(close, sma(close, 50))" } });
        } else if (/screen|bql/i.test(question)) {
          const list = (secs.length ? secs : ["AAPL US Equity", "MSFT US Equity"]).map((s) => `'${s}'`).join(", ");
          calls.push({ name: "run_bql", args: { query: `SELECT NAME, PX_LAST, PE_RATIO FROM list(${list}) ORDER BY PE_RATIO` } });
        } else if (/risk factor|filing|10-k/i.test(question)) {
          calls.push({ name: "compare_filings", args: { security: first } });
        } else if (/beta|correlat/i.test(question)) {
          calls.push({ name: "analyze_returns", args: { securities: secs.length ? secs : [first] } });
        } else if (secs.length) {
          calls.push({ name: "get_fields", args: { securities: secs, fields: ["PX_LAST", "CHG_PCT_1D", "PE_RATIO", "CUR_MKT_CAP"] } });
          calls.push({ name: "open_function", args: { function: /chart|graph/i.test(question) ? "GP" : "DES", security: secs[0] } });
        }
        if (calls.length) return { text: "", toolCalls: calls.filter((c) => available.has(c.name)).map((c, i) => ({ ...c, id: `mock_${i + 1}` })) };
      }

      const lines = results.map((r) => `- ${r.name}: ${r.content.replace(/\s+/g, " ").slice(0, 160)}`);
      const table = ["| Tool | Result characters |", "| --- | ---: |", ...results.map((r) => `| ${r.name} | ${r.content.length} |`)];
      const text = results.length
        ? `Mock analyst summary for "${question}":\n${lines.join("\n")}\n\n${table.join("\n")}\n(Simulated model output for testing.)`
        : `Mock analyst: I can answer questions about securities, markets and your portfolios. Try "compare AAPL and MSFT". (Simulated model output.)`;
      for (const word of text.match(/\S+\s*/g) ?? []) onText(word);
      return { text, toolCalls: [] };
    },
  };
}
