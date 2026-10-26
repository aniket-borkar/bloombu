import type { Quote } from "../api";
import { sourceTimeNs } from "../../../server/src/sourceTime";

/** Source times may use different ISO offsets, so compare instants rather than strings. */
export function quoteTime(quote: Pick<Quote, "time">): number | null {
  if (!quote.time) return null;
  const time = Date.parse(quote.time);
  return Number.isFinite(time) ? time : null;
}

/** Keep a newer source observation when an older snapshot or tick arrives late. */
export function preferFreshQuote(previous: Quote | null | undefined, incoming: Quote): Quote {
  if (!previous || previous.security !== incoming.security) return incoming;
  const before = sourceTimeNs(previous.time);
  const after = sourceTimeNs(incoming.time);
  if (before !== null && (after === null || after < before)) return previous;
  // Equal trade times can still carry updated bid/ask values or a new source label.
  return incoming;
}

export function quoteAge(time: string | null, now: number): string {
  const sourceTime = quoteTime({ time });
  if (sourceTime === null) return "time unavailable";
  const seconds = Math.max(0, Math.floor((now - sourceTime) / 1000));
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s old`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m old`;
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h old`;
}
