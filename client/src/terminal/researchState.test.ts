import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotebookInput } from "../../../server/src/research/notebooks";
import { usePanels } from "../store/panels";
import { captureInNotebook, getNotebookDraft, notebookMarkdown, rememberNotebookDraft, takeNotebookEvidence } from "./researchState";

afterEach(() => vi.unstubAllGlobals());

describe("research workflow", () => {
  it("captures an independent snapshot in the next visible panel", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "snapshot-id" });
    usePanels.setState({ user: "RESEARCH-UNIT", layout: 4, focused: 1 });
    const data = { assumptions: { growthPct: 5 }, value: 120 };
    captureInNotebook(1, { kind: "valuation", title: "Company model", security: "AAPL US Equity", data });
    data.assumptions.growthPct = 100;
    data.value = 500;
    expect(usePanels.getState().panels[1].screen.fn).toBe("NOTE");
    expect(usePanels.getState().focused).toBe(2);
    const captured = takeNotebookEvidence("RESEARCH-UNIT", 2);
    expect(captured?.data).toEqual({ assumptions: { growthPct: 5 }, value: 120 });
    expect(captured?.id).toBe("snapshot-id");
    expect(captured?.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(takeNotebookEvidence("RESEARCH-UNIT", 2)).toBeNull();
  });

  it("isolates drafts by user and panel", () => {
    const input: NotebookInput = { title: "Draft", security: null, thesis: "Retain this", bearCase: "", catalysts: "", reviewDate: null, evidence: [] };
    rememberNotebookDraft("OWNER", 3, { id: null, revision: null, input, dirty: true });
    expect(getNotebookDraft("OWNER", 3)?.input.thesis).toBe("Retain this");
    expect(getNotebookDraft("OTHER", 3)).toBeUndefined();
    expect(getNotebookDraft("OWNER", 4)).toBeUndefined();
  });

  it("exports citations, dates and model assumptions without breaking code fences", () => {
    const input: NotebookInput = {
      title: "Thesis", security: "AAPL US Equity", thesis: "Base case", bearCase: "Risks", catalysts: "Next results", reviewDate: "2027-01-01",
      evidence: [{ id: "one", kind: "source", title: "Annual report", source: "Company", url: "https://example.com/report", asOf: "2026-10-01", capturedAt: "2026-10-26T07:00:00Z", data: { note: "```quoted```", assumptions: { growthPct: 5 } } }],
    };
    const markdown = notebookMarkdown(input);
    expect(markdown).toContain("# Thesis");
    expect(markdown).toContain("Review date: 2027-01-01");
    expect(markdown).toContain("URL: https://example.com/report");
    expect(markdown).toContain('"growthPct": 5');
    expect(markdown).toContain("````json");
    expect(markdown.endsWith("````\n")).toBe(true);
  });
});
