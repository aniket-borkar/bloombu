import { createHandoff } from "./handoff";

let pendingSheet: string | null = null;

/** Open a specific sheet the next time a SHEET screen mounts (e.g. from the command palette). */
export function setPendingSheet(name: string): void {
  pendingSheet = name;
}

export function takePendingSheet(): string | null {
  const s = pendingSheet;
  pendingSheet = null;
  return s;
}

const bql = createHandoff<string>();

/** Load and run a query in this panel's BQL screen, e.g. one the AI analyst wrote. */
export const setPendingBql = (panelId: number, query: string) => bql.give(String(panelId), query);
export const takePendingBql = (panelId: number) => bql.take(String(panelId));
export const onPendingBql = (panelId: number, listener: (query: string) => void) => bql.listen(String(panelId), listener);
