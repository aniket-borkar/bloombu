import { useEffect, useState } from "react";
import { useConnection } from "./store/connection";
import { quoteStream } from "./stream";
import type { HistoryInterval, HistoryRange } from "./terminal/functions";
import type {
  Analysts,
  ChatMessage,
  CorporateEvents,
  CurvePoint,
  Earnings,
  EconEvent,
  EconStats,
  FinancialStatement,
  FuturesChain,
  Headline,
  Holders,
  MoneyMarkets,
  OptionChain,
  Portfolio,
  PortfolioAnalytics,
  PortfolioHolding,
  PortfolioInput,
  PortfolioKind,
  PortfolioSummary,
  Profile,
  ScreenId,
  ScreenRow,
  Statement,
  StatementPeriod,
  Valuation,
  YieldCurve,
} from "../../server/src/types";
import type { PluginFunctionInfo, ScreenSpec } from "../../server/src/plugins/spec";
import type { Brief, ForwardCurve, MembersAnalysis, PaperAccount, PaperOrder, RateProbabilities, SourcesReport } from "../../server/src/types";

export type {
  Portfolio,
  PortfolioAnalytics,
  PortfolioHolding,
  PortfolioInput,
  PortfolioKind,
  PortfolioSummary,
  Analysts,
  ChatMessage,
  CorporateEvents,
  CurvePoint,
  Earnings,
  EconEvent,
  EconStats,
  FinancialStatement,
  FuturesChain,
  Headline,
  Holders,
  MoneyMarkets,
  OptionChain,
  Profile,
  ScreenId,
  ScreenRow,
  Statement,
  StatementPeriod,
  Valuation,
  YieldCurve,
};

export interface Quote {
  security: string;
  name: string;
  last: number | null;
  change: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  volume: number | null;
  currency: string | null;
  exchange: string | null;
  marketState: string | null;
  time: string | null;
  delayMinutes: number | null;
  source: string;
}

export interface SearchResult {
  security: string;
  name: string;
  sector: string;
  exchange: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The full error body, for extra fields such as a BQL error position. */
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: json !== undefined ? { "content-type": "application/json", ...rest.headers } : rest.headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch (err) {
    if ((err as Error).name !== "AbortError") useConnection.setState({ rest: false });
    throw err;
  }
  useConnection.setState({ rest: res.status < 500 });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const b = (body ?? {}) as Record<string, unknown>;
    throw new ApiError(res.status, typeof b.error === "string" ? b.error : `HTTP ${res.status}`, b);
  }
  return body as T;
}

const getJson = <T,>(url: string, signal?: AbortSignal) => request<T>(url, { signal });
const sendJson = <T,>(method: string, url: string, json?: unknown) => request<T>(url, { method, json });

export const fetchQuote = (security: string, signal?: AbortSignal) =>
  getJson<Quote>(`/api/quote/${encodeURIComponent(security)}`, signal);

export const searchSecurities = (q: string, signal?: AbortSignal) =>
  getJson<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`, signal);

export const fetchIndices = (signal?: AbortSignal) => getJson<Quote[]>("/api/indices", signal);

/** OHLCV bar; `t` is the bar start in Unix milliseconds. */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number | null;
}

export interface History {
  security: string;
  interval: HistoryInterval;
  range: HistoryRange;
  bars: Bar[];
}

export const fetchHistory = (security: string, interval: HistoryInterval, range: HistoryRange, signal?: AbortSignal) =>
  getJson<History>(`/api/history/${encodeURIComponent(security)}?interval=${interval}&range=${range}`, signal);

const sec = (s: string) => encodeURIComponent(s);
const list = (securities: string[]) => securities.map(sec).join(",");

export const api = {
  quotes: (securities: string[], signal?: AbortSignal) => getJson<Quote[]>(`/api/quotes?s=${list(securities)}`, signal),
  valuations: (securities: string[], signal?: AbortSignal) =>
    getJson<Valuation[]>(`/api/valuations?s=${list(securities)}`, signal),
  profile: (s: string, signal?: AbortSignal) => getJson<Profile>(`/api/profile/${sec(s)}`, signal),
  financials: (s: string, statement: Statement, period: StatementPeriod, signal?: AbortSignal) =>
    getJson<FinancialStatement>(`/api/financials/${sec(s)}?statement=${statement}&period=${period}`, signal),
  earnings: (s: string, signal?: AbortSignal) => getJson<Earnings>(`/api/earnings/${sec(s)}`, signal),
  analysts: (s: string, signal?: AbortSignal) => getJson<Analysts>(`/api/analysts/${sec(s)}`, signal),
  holders: (s: string, signal?: AbortSignal) => getJson<Holders>(`/api/holders/${sec(s)}`, signal),
  events: (s: string, signal?: AbortSignal) => getJson<CorporateEvents>(`/api/events/${sec(s)}`, signal),
  options: (s: string, expiration: string | null, signal?: AbortSignal) =>
    getJson<OptionChain>(`/api/options/${sec(s)}${expiration ? `?expiration=${encodeURIComponent(expiration)}` : ""}`, signal),
  related: (s: string, signal?: AbortSignal) => getJson<string[]>(`/api/related/${sec(s)}`, signal),
  listings: (s: string, signal?: AbortSignal) => getJson<SearchResult[]>(`/api/listings/${sec(s)}`, signal),
  futures: (s: string, signal?: AbortSignal) => getJson<FuturesChain>(`/api/futures/${sec(s)}`, signal),
  companyNews: (s: string, signal?: AbortSignal) => getJson<Headline[]>(`/api/news/company/${sec(s)}`, signal),
  news: (q: string, signal?: AbortSignal) => getJson<Headline[]>(`/api/news?q=${encodeURIComponent(q)}`, signal),
  topNews: (signal?: AbortSignal) => getJson<Headline[]>("/api/news/top", signal),
  screen: (id: ScreenId, signal?: AbortSignal) => getJson<ScreenRow[]>(`/api/screens/${id}`, signal),
  curve: (signal?: AbortSignal) => getJson<YieldCurve>("/api/curve", signal),
  curves: (signal?: AbortSignal) => getJson<YieldCurve[]>("/api/curves", signal),
  moneyMarkets: (signal?: AbortSignal) => getJson<MoneyMarkets>("/api/money-markets", signal),
  econStats: (signal?: AbortSignal) => getJson<EconStats>("/api/econ/stats", signal),
  econCalendar: (signal?: AbortSignal) => getJson<EconEvent[]>("/api/econ/calendar", signal),
  chatRooms: (user: string, signal?: AbortSignal) =>
    getJson<{ room: string; last: ChatMessage | null }[]>(`/api/chat/rooms?user=${encodeURIComponent(user)}`, signal),
  resolve: (inputs: string[]) => sendJson<Resolution[]>("POST", "/api/resolve", { inputs }),
  docs: {
    list: (user: string, kind: string, signal?: AbortSignal) =>
      getJson<{ name: string; updated: number }[]>(`/api/docs/${kind}?user=${encodeURIComponent(user)}`, signal),
    get: <T,>(user: string, kind: string, name: string, signal?: AbortSignal) =>
      getJson<T>(`/api/docs/${kind}/${encodeURIComponent(name)}?user=${encodeURIComponent(user)}`, signal),
    put: (user: string, kind: string, name: string, data: unknown) =>
      sendJson<null>("PUT", `/api/docs/${kind}/${encodeURIComponent(name)}`, { user, data }),
    remove: (user: string, kind: string, name: string) =>
      sendJson<null>("DELETE", `/api/docs/${kind}/${encodeURIComponent(name)}?user=${encodeURIComponent(user)}`),
  },
  bql: (query: string, user: string) =>
    sendJson<{ columns: string[]; rows: (number | string | null)[][]; universeSize: number }>("POST", "/api/bql", { query, user }),
  alerts: {
    list: (user: string, signal?: AbortSignal) => getJson<{ active: AlertInfo[]; triggered: AlertInfo[] }>(`/api/alerts?user=${encodeURIComponent(user)}`, signal),
    create: (user: string, input: { security: string; kind: string; value?: number; expr?: string; note?: string }) =>
      sendJson<AlertInfo>("POST", "/api/alerts", { user, ...input }),
    remove: (user: string, id: number) => sendJson<null>("DELETE", `/api/alerts/${id}?user=${encodeURIComponent(user)}`),
    rearm: (user: string, id: number) => sendJson<AlertInfo>("POST", `/api/alerts/${id}/rearm`, { user }),
  },
  members: (security: string, signal?: AbortSignal) => getJson<MembersAnalysis>(`/api/members/${sec(security)}`, signal),
  wirp: (signal?: AbortSignal) => getJson<RateProbabilities>("/api/wirp", signal),
  sources: (signal?: AbortSignal) => getJson<SourcesReport>("/api/sources", signal),
  brief: (user: string, signal?: AbortSignal) => getJson<Brief>(`/api/brief?user=${encodeURIComponent(user)}`, signal),
  auth: {
    me: (signal?: AbortSignal) => getJson<{ authRequired: boolean; user: string | null; signup: boolean }>("/api/auth/me", signal),
    login: (name: string, password: string) => sendJson<{ user: string | null }>("POST", "/api/auth/login", { name, password }),
    register: (name: string, password: string) => sendJson<{ user: string | null }>("POST", "/api/auth/register", { name, password }),
    logout: () => sendJson<{ user: null }>("POST", "/api/auth/logout", {}),
  },
  paper: {
    account: (user: string, signal?: AbortSignal) => getJson<PaperAccount>(`/api/paper?user=${encodeURIComponent(user)}`, signal),
    place: (user: string, order: { security: string; side: "buy" | "sell"; quantity: number; type: string; limitPrice?: number; stopPrice?: number }) =>
      sendJson<PaperOrder>("POST", "/api/paper/orders", { user, ...order }),
    cancel: (user: string, id: number) => sendJson<PaperOrder>("DELETE", `/api/paper/orders/${id}?user=${encodeURIComponent(user)}`),
    reset: (user: string, startingCash: number) => sendJson<PaperAccount>("POST", "/api/paper/reset", { user, startingCash }),
  },
  forwards: (security: string, signal?: AbortSignal) => getJson<ForwardCurve>(`/api/forwards/${sec(security)}`, signal),
  plugins: (signal?: AbortSignal) => getJson<{ plugins: { name: string; version: string | null }[]; functions: PluginFunctionInfo[] }>("/api/plugins", signal),
  runPlugin: (code: string, security: string | null, option: number, signal?: AbortSignal) =>
    getJson<ScreenSpec>(`/api/plugins/run/${encodeURIComponent(code)}?option=${option}${security ? `&security=${sec(security)}` : ""}`, signal),
  fieldList: (signal?: AbortSignal) => getJson<FieldInfo[]>("/api/fields/list", signal),
  fields: (securities: string[], fields: string[], signal?: AbortSignal) =>
    getJson<Record<string, Record<string, number | string | null>>>(
      `/api/fields?s=${list(securities)}&f=${fields.map(encodeURIComponent).join(",")}`,
      signal,
    ),
  portfolios: (user: string, signal?: AbortSignal) =>
    getJson<PortfolioSummary[]>(`/api/portfolios?user=${encodeURIComponent(user)}`, signal),
  portfolio: (user: string, id: number, signal?: AbortSignal) =>
    getJson<Portfolio>(`/api/portfolios/${id}?user=${encodeURIComponent(user)}`, signal),
  createPortfolio: (user: string, input: PortfolioInput) => sendJson<Portfolio>("POST", "/api/portfolios", { user, ...input }),
  updatePortfolio: (user: string, id: number, input: PortfolioInput) =>
    sendJson<Portfolio>("PUT", `/api/portfolios/${id}`, { user, ...input }),
  deletePortfolio: (user: string, id: number) =>
    sendJson<null>("DELETE", `/api/portfolios/${id}?user=${encodeURIComponent(user)}`),
  portfolioAnalytics: (user: string, id: number, range: string, benchmark: string, signal?: AbortSignal) =>
    getJson<PortfolioAnalytics>(
      `/api/portfolios/${id}/analytics?user=${encodeURIComponent(user)}&range=${range}&benchmark=${encodeURIComponent(benchmark)}`,
      signal,
    ),
  portfolioWhatIf: (user: string, id: number, holdings: PortfolioHolding[], range: string, benchmark: string) =>
    sendJson<{ current: PortfolioAnalytics; proposed: PortfolioAnalytics }>("POST", `/api/portfolios/${id}/whatif`, {
      user,
      holdings,
      range,
      benchmark,
    }),
  draftAnalytics: (portfolio: PortfolioInput, range: string, benchmark: string) =>
    sendJson<PortfolioAnalytics>("POST", "/api/portfolios/analytics", { portfolio, range, benchmark }),
};

export interface AlertInfo {
  id: number;
  user: string;
  security: string;
  kind: "above" | "below" | "pct_up" | "pct_down" | "volume_above" | "rule";
  value: number | null;
  expr: string | null;
  note: string | null;
  active: boolean;
  created: number;
  triggeredAt: number | null;
  triggerValue: number | null;
}

export interface FieldInfo {
  id: string;
  description: string;
  category: string;
  type: "number" | "string" | "date";
  source: string;
}

export interface Resolution {
  input: string;
  security: string | null;
  name: string | null;
  status: "ok" | "search" | "unresolved" | "empty";
  candidates: SearchResult[];
}

/** Fetch once per `key` and refresh every `refreshMs` (default: every 10 minutes). */
export function useData<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, refreshMs = 600_000) {
  return usePolling(key, load, refreshMs);
}

export const fetchHealth = () => getJson<{ ok: boolean; providers: string[] }>("/api/health");

interface Polled<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
}

interface PollingOptions<T> {
  /** Push updates between polls; returns an unsubscribe function. */
  subscribe?: (onData: (data: T) => void) => () => void;
  /** Skip scheduled polls while this returns true (the initial fetch always runs). */
  pauseWhen?: () => boolean;
}

/** Fetch `load` immediately and every `intervalMs`, keeping the last good value on transient errors. */
export function usePolling<T>(
  key: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  options: PollingOptions<T> = {},
): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, loading: !!key });

  useEffect(() => {
    if (!key) {
      setState({ data: null, error: null, loading: false });
      return;
    }
    let ctrl = new AbortController();
    let cancelled = false;
    setState({ data: null, error: null, loading: true });
    const run = () => {
      ctrl = new AbortController();
      load(ctrl.signal)
        .then((data) => !cancelled && setState({ data, error: null, loading: false }))
        .catch((error) => {
          if (cancelled || error.name === "AbortError") return;
          setState((s) => ({ data: error instanceof ApiError && error.status === 404 ? null : s.data, error, loading: false }));
        });
    };
    run();
    const timer = setInterval(() => {
      if (!options.pauseWhen?.()) run();
    }, intervalMs);
    const unsubscribe = options.subscribe?.((data) => {
      if (!cancelled) setState({ data, error: null, loading: false });
    });
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe?.();
      ctrl.abort();
    };
  }, [key, intervalMs]);

  return state;
}

/** REST snapshot, then live WebSocket updates; falls back to polling while the socket is down. */
export const useQuote = (security: string | null) =>
  usePolling(security, (signal) => fetchQuote(security!, signal), 15_000, {
    subscribe: (onData) => quoteStream.subscribe(security!, onData),
    pauseWhen: () => quoteStream.connected,
  });

/** Live overlay for a list of quotes: each entry is replaced by its latest streamed update. */
export function useLiveQuotes(quotes: Quote[] | null): Quote[] | null {
  const [live, setLive] = useState<Record<string, Quote>>({});
  const key = quotes?.map((q) => q.security).join("|") ?? "";

  useEffect(() => {
    if (!key) return;
    const unsubs = key.split("|").map((s) => quoteStream.subscribe(s, (q) => setLive((m) => ({ ...m, [q.security]: q }))));
    return () => unsubs.forEach((u) => u());
  }, [key]);

  return (
    quotes?.map((q) => {
      const l = live[q.security];
      return l && (l.time ?? "") >= (q.time ?? "") ? l : q;
    }) ?? null
  );
}
