import type { HistoryRange } from "./functions";
import { createHandoff } from "./handoff";

export interface PendingBacktest {
  entry: string;
  exit: string;
  direction: "long" | "short";
  costBps: number;
  range: HistoryRange;
}

type Target = { panelId: number; security: string };
const handoff = createHandoff<PendingBacktest>();
const keyOf = (t: Target) => `${t.panelId}|${t.security}`;

/** Hand a strategy (e.g. one the AI analyst tested) to the BTST screen for this panel and security. */
export const setPendingBacktest = (target: Target, backtest: PendingBacktest) => handoff.give(keyOf(target), backtest);
export const takePendingBacktest = (target: Target) => handoff.take(keyOf(target));
/** Receive strategies handed to this already-mounted screen. */
export const onPendingBacktest = (target: Target, listener: (p: PendingBacktest) => void) => handoff.listen(keyOf(target), listener);
