import type { NotebookEvidence, NotebookInput } from "../../../server/src/research/notebooks";
import { usePanels } from "../store/panels";
import { createHandoff } from "./handoff";

const evidence = createHandoff<NotebookEvidence>();
const evidenceKey = (user: string, panelId: number) => `${user}|${panelId}`;

/** Keep an unsaved research draft when its panel navigates to another function. */
export interface NotebookDraft {
  id: number | null;
  revision: number | null;
  input: NotebookInput;
  dirty: boolean;
}
const drafts = new Map<string, NotebookDraft>();
const workbenches = new Map<string, unknown>();
const workbenchKey = (user: string, panelId: number, fn: string, security: string | null) => `${user}|${panelId}|${fn}|${security ?? ""}`;
export const getResearchWorkbench = <T,>(user: string, panelId: number, fn: string, security: string | null = null) =>
  workbenches.get(workbenchKey(user, panelId, fn, security)) as T | undefined;
export const rememberResearchWorkbench = <T,>(user: string, panelId: number, fn: string, security: string | null, draft: T) =>
  workbenches.set(workbenchKey(user, panelId, fn, security), draft);
export const getNotebookDraft = (user: string, panelId: number) => drafts.get(evidenceKey(user, panelId));
export const rememberNotebookDraft = (user: string, panelId: number, draft: NotebookDraft) => drafts.set(evidenceKey(user, panelId), draft);
export const takeNotebookEvidence = (user: string, panelId: number) => evidence.take(evidenceKey(user, panelId));
export const onNotebookEvidence = (user: string, panelId: number, listener: (item: NotebookEvidence) => void) =>
  evidence.listen(evidenceKey(user, panelId), listener);

/** Capture a fixed snapshot, then open the notebook in the next visible panel. */
export function captureInNotebook(panelId: number, item: Omit<NotebookEvidence, "id" | "capturedAt">): void {
  const state = usePanels.getState();
  const target = state.layout === 1 ? panelId : (panelId % state.layout) + 1;
  const snapshot = JSON.parse(JSON.stringify(item)) as typeof item;
  evidence.give(evidenceKey(state.user, target), {
    ...snapshot,
    id: crypto.randomUUID(),
    capturedAt: new Date().toISOString(),
  });
  state.execute(target, { kind: "function", fn: "NOTE" });
  state.focus(target);
}

/** Export the thesis with citations and the actual assumptions behind captured models. */
export function notebookMarkdown(input: NotebookInput): string {
  const sections = [
    `# ${input.title}`,
    input.security ? `Security: ${input.security}` : "",
    input.reviewDate ? `Review date: ${input.reviewDate}` : "",
    `## Thesis\n\n${input.thesis}`,
    `## Bear case\n\n${input.bearCase}`,
    `## Catalysts\n\n${input.catalysts}`,
  ].filter(Boolean);
  if (input.evidence.length) sections.push("## Evidence");
  for (const item of input.evidence) {
    sections.push(`### ${item.title}`, `Kind: ${item.kind} · Captured: ${item.capturedAt}`);
    if (item.security) sections.push(`Security: ${item.security}`);
    if (item.source) sections.push(`Source: ${item.source}`);
    if (item.url) sections.push(`URL: ${item.url}`);
    if (item.asOf) sections.push(`As of: ${item.asOf}`);
    if (item.data !== undefined) {
      const data = JSON.stringify(item.data, null, 2);
      // Use a fence longer than any run inside user-provided evidence.
      const fence = "`".repeat(Math.max(3, ...[...data.matchAll(/`+/g)].map((m) => m[0].length + 1)));
      sections.push(`${fence}json\n${data}\n${fence}`);
    }
  }
  return `${sections.join("\n\n")}\n`;
}

export function downloadResearch(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
