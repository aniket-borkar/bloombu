import type { PortfolioInput } from "../api";

const lastKey = (user: string) => `blmbu.port.last.${user}`;

/** The portfolio most recently opened by this user in this browser. */
export function lastPortfolio(user: string): number | null {
  const v = Number(localStorage.getItem(lastKey(user)));
  return Number.isInteger(v) && v > 0 ? v : null;
}

export function rememberPortfolio(user: string, id: number): void {
  localStorage.setItem(lastKey(user), String(id));
}

let pendingDraft: PortfolioInput | null = null;

/** Hand an unsaved portfolio (e.g. drafted by ASK) to the next PRTU screen that opens. */
export function setPendingDraft(draft: PortfolioInput): void {
  pendingDraft = draft;
}

export function takePendingDraft(): PortfolioInput | null {
  const d = pendingDraft;
  pendingDraft = null;
  return d;
}
