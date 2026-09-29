import { FUNCTIONS } from "./functions";
import { SECTOR_TOKENS } from "./sectors";

export type Command =
  | { kind: "empty" }
  | { kind: "load"; security: string; fn: string | null }
  | { kind: "function"; fn: string }
  | { kind: "menuItem"; index: number }
  | { kind: "search"; query: string }
  | { kind: "ask"; question: string; depth?: "deep" }
  | { kind: "error"; message: string };

/** Input starting with "?" is a question for the AI analyst and keeps its case; "??" asks for deep research. */
export const isQuestion = (input: string) => input.trimStart().startsWith("?");

export function tokenize(input: string): string[] {
  return input
    .toUpperCase()
    .replace(/<\s*GO\s*>/g, " ")
    .replace(/[<>]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Canonical display form, e.g. "AAPL US Equity". Bare equity tickers default to the US composite. */
export function formatSecurity(body: string[], sectorToken: string): string {
  const sector = SECTOR_TOKENS[sectorToken];
  const parts = sector === "Equity" && body.length === 1 ? [...body, "US"] : body;
  return `${parts.join(" ")} ${sector}`;
}

export function parseCommand(input: string): Command {
  if (isQuestion(input)) {
    const body = input.trim().slice(1);
    const deep = body.startsWith("?");
    const question = (deep ? body.slice(1) : body).trim();
    if (!question) return { kind: "error", message: "TYPE A QUESTION AFTER ? (OR ?? FOR DEEP RESEARCH), E.G. ? HOW DID NVDA DO THIS YEAR" };
    return deep ? { kind: "ask", question, depth: "deep" } : { kind: "ask", question };
  }
  const tokens = tokenize(input);
  if (!tokens.length) return { kind: "empty" };

  if (tokens.length === 1 && /^\d+$/.test(tokens[0])) {
    return { kind: "menuItem", index: Number(tokens[0]) };
  }

  const sectorAt = tokens.findIndex((t) => t in SECTOR_TOKENS);
  if (sectorAt === 0) {
    return { kind: "error", message: "MISSING TICKER BEFORE MARKET SECTOR" };
  }
  if (sectorAt > 0) {
    const security = formatSecurity(tokens.slice(0, sectorAt), tokens[sectorAt]);
    const rest = tokens.slice(sectorAt + 1);
    if (!rest.length) return { kind: "load", security, fn: null };
    if (rest.length === 1 && rest[0] in FUNCTIONS) {
      return { kind: "load", security, fn: rest[0] };
    }
    return { kind: "error", message: `UNKNOWN FUNCTION: ${rest.join(" ")}` };
  }

  if (tokens.length === 1 && tokens[0] in FUNCTIONS) {
    return { kind: "function", fn: tokens[0] };
  }

  return { kind: "search", query: tokens.join(" ") };
}
