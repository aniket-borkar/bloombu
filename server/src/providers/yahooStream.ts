import WebSocket from "ws";
import { sourceTimeNs } from "../sourceTime.js";
import { normalizeSecurity, toYahoo } from "../symbology.js";
import type { Quote } from "../types.js";
import type { ProviderPlugin } from "./DataProvider.js";
import { applyYahooTick, decodeYahooPricingMessage, mergeYahooSeed, yahooQuoteTime as stamp, YAHOO_MAX_FRAME as MAX_FRAME } from "./yahooWire.js";
export { decodeYahooPricingMessage } from "./yahooWire.js";

const URL = "wss://streamer.finance.yahoo.com/?version=2";
interface Watch { symbol: string; listeners: Set<(quote: Quote) => void> }
export interface YahooStreamOptions { wsUrl?: string }

/** One unofficial public Yahoo stream; silence and unavailable markets retain REST fallback in the hub. */
export function createYahooQuoteStream(options: YahooStreamOptions = {}): { subscribe: NonNullable<ProviderPlugin["subscribe"]>; seed(quotes: Quote[]): void } {
  const watches = new Map<string, Watch>();
  const latest = new Map<string, Quote>();
  const native = new Set<string>();
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let attempts = 0;
  const symbols = () => [...new Set([...watches.values()].map((watch) => watch.symbol))];
  const send = (op: "subscribe" | "unsubscribe", list: string[]) => {
    if (socket?.readyState === WebSocket.OPEN && list.length) socket.send(JSON.stringify({ [op]: list }));
  };
  const publish = (security: string, quote: Quote) => {
    latest.set(security, quote);
    for (const listener of watches.get(security)?.listeners ?? []) listener(quote);
  };
  const stop = () => {
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    retry = heartbeat = null;
    const previous = socket; socket = null;
    if (previous?.readyState === WebSocket.CONNECTING) previous.terminate(); else previous?.close();
    attempts = 0;
  };
  const connect = () => {
    if (socket || retry || !watches.size) return;
    const ws = new WebSocket(options.wsUrl ?? URL, { handshakeTimeout: 8000, maxPayload: MAX_FRAME, perMessageDeflate: false });
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws) return;
      send("subscribe", symbols());
      heartbeat = setInterval(() => send("subscribe", symbols()), 15_000);
      heartbeat.unref();
    });
    ws.on("message", (raw) => {
      if (socket !== ws) return;
      const frame = raw.toString();
      if (frame.length > MAX_FRAME) return;
      let message: unknown;
      try { message = JSON.parse(frame); } catch { return; }
      if (!message || typeof message !== "object" || !("message" in message) || typeof message.message !== "string") return;
      const tick = decodeYahooPricingMessage(message.message);
      if (!tick) return;
      attempts = 0;
      const time = sourceTimeNs(tick.time)!;
      for (const [security, watch] of watches) {
        if (watch.symbol !== tick.id) continue;
        const previous = latest.get(security);
        if (previous && time < stamp(previous)) continue;
        native.add(security);
        publish(security, applyYahooTick(security, tick, previous));
      }
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (watches.size) {
        retry = setTimeout(() => { retry = null; connect(); }, Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5)));
        retry.unref();
      }
    });
    ws.on("error", () => {}); // Close/backoff handles transport failures; do not log arbitrary upstream text.
  };
  return {
    seed(quotes) {
      for (const incoming of quotes) {
        const security = normalizeSecurity(incoming.security);
        if (!security || !toYahoo(security)) continue;
        const previous = latest.get(security);
        if (!previous || stamp(incoming) > stamp(previous) || (stamp(incoming) === stamp(previous) && !native.has(security))) native.delete(security);
        publish(security, mergeYahooSeed({ ...incoming, security }, previous, native.has(security)));
      }
      if (latest.size > 1024) for (const key of latest.keys()) {
        if (!watches.has(key)) latest.delete(key);
        if (latest.size <= 1024) break;
      }
    },
    subscribe(securities, onQuote) {
      const entries: { security: string; watch: Watch }[] = [];
      const fresh: string[] = [];
      for (const input of securities) {
        const security = normalizeSecurity(input);
        const symbol = toYahoo(input);
        if (!security || !symbol) continue;
        let watch = watches.get(security);
        if (!watch) {
          if (![...watches.values()].some((value) => value.symbol === symbol)) fresh.push(symbol);
          watches.set(security, (watch = { symbol, listeners: new Set() }));
        }
        watch.listeners.add(onQuote); entries.push({ security, watch });
        const cached = latest.get(security); if (cached) onQuote(cached);
      }
      send("subscribe", fresh);
      connect();
      let released = false;
      return () => {
        if (released) return; released = true;
        const removed: string[] = [];
        for (const { security, watch } of entries) {
          if (watches.get(security) !== watch || !watch.listeners.delete(onQuote) || watch.listeners.size) continue;
          watches.delete(security); latest.delete(security); native.delete(security);
          if (![...watches.values()].some((value) => value.symbol === watch.symbol)) removed.push(watch.symbol);
        }
        send("unsubscribe", [...new Set(removed)]);
        if (!watches.size) stop();
      };
    },
  };
}
