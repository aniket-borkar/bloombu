import { useEffect, useRef, useState } from "react";
import type { Notebook, NotebookEvidence, NotebookInput } from "../../../server/src/research/notebooks";
import { ApiError, api, useData } from "../api";
import { usePanels } from "../store/panels";
import { fmtIsoDateTime } from "../terminal/format";
import { downloadResearch, getNotebookDraft, notebookMarkdown, onNotebookEvidence, rememberNotebookDraft, takeNotebookEvidence, type NotebookDraft } from "../terminal/researchState";
import { DataState, Section, type ScreenProps } from "./common";

const blank = (security: string | null): NotebookDraft => ({
  id: null, revision: null, dirty: false,
  input: { title: "Research notebook", security, thesis: "", bearCase: "", catalysts: "", reviewDate: null, evidence: [] },
});
const fromNotebook = (notebook: Notebook): NotebookDraft => ({
  id: notebook.id, revision: notebook.revision, dirty: false,
  input: { title: notebook.title, security: notebook.security, thesis: notebook.thesis, bearCase: notebook.bearCase, catalysts: notebook.catalysts, reviewDate: notebook.reviewDate, evidence: notebook.evidence },
});

/** A thesis and its captured evidence, saved explicitly with optimistic concurrency. */
export function NotebookScreen({ panel, security }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const [editor, setEditorState] = useState<NotebookDraft>(() => getNotebookDraft(user, panel.id) ?? blank(security));
  const latest = useRef(editor);
  const [version, setVersion] = useState(0);
  const list = useData(`notebooks|${user}|${version}`, (signal) => api.notebooks.list(user, signal), 60_000);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<number | "new" | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [source, setSource] = useState({ title: "", source: "", url: "", asOf: "", note: "" });

  const update = (next: NotebookDraft | ((previous: NotebookDraft) => NotebookDraft)) => {
    const draft = typeof next === "function" ? next(latest.current) : next;
    latest.current = draft;
    rememberNotebookDraft(user, panel.id, draft);
    setEditorState(draft);
    setArmedDelete(false);
  };
  const edit = (patch: Partial<NotebookInput>) => update((previous) => ({ ...previous, input: { ...previous.input, ...patch }, dirty: true }));
  const tell = (text: string, failed = false) => { setMessage(text); setError(failed); };

  useEffect(() => {
    const append = (item: NotebookEvidence) => {
      update((previous) => {
        if (previous.input.evidence.some((e) => e.id === item.id)) return previous;
        const fresh = !previous.dirty && previous.id === null && !previous.input.evidence.length;
        return { ...previous, dirty: true, input: { ...previous.input,
          title: fresh ? item.title.slice(0, 120) : previous.input.title,
          security: fresh ? item.security ?? null : previous.input.security,
          evidence: [...previous.input.evidence, item],
        } };
      });
      tell("Evidence captured as an unsaved snapshot. Save the notebook to keep it on the server.");
    };
    const queued = takeNotebookEvidence(user, panel.id);
    if (queued) append(queued);
    return onNotebookEvidence(user, panel.id, append);
  }, [user, panel.id]);

  const open = async (id: number | "new", discard = false) => {
    if (busy) return;
    if (latest.current.dirty && !discard) {
      setPendingOpen(id);
      tell("Your draft has unsaved changes. Save it, export it, or explicitly discard it before opening another notebook.");
      return;
    }
    setPendingOpen(null);
    setBusy(true);
    try {
      const previous = latest.current;
      const opened = id === "new" ? blank(security) : fromNotebook(await api.notebooks.get(user, id));
      if (latest.current !== previous && latest.current.dirty) {
        tell("New evidence arrived while opening. Your draft is retained; save it before changing notebooks.");
        return;
      }
      update(opened);
      setConflict(false);
      tell(id === "new" ? "New notebook. Changes are saved only when you click Save." : "Opened saved notebook.");
    } catch (e) {
      tell((e as Error).message, true);
    } finally { setBusy(false); }
  };

  const save = async (copy = false) => {
    if (busy) return;
    const draft = latest.current;
    if (!draft.input.title.trim()) { tell("A notebook title is required.", true); return; }
    setBusy(true);
    try {
      const input = copy ? { ...draft.input, title: `${draft.input.title.slice(0, 115)} copy` } : draft.input;
      const saved = copy || draft.id === null
        ? await api.notebooks.create(user, input)
        : await api.notebooks.update(user, draft.id, draft.revision!, input);
      const newer = latest.current !== draft;
      update(newer ? { ...latest.current, id: saved.id, revision: saved.revision, dirty: true, input: { ...latest.current.input, title: saved.title } } : fromNotebook(saved));
      setConflict(false);
      setPendingOpen(null);
      setVersion((v) => v + 1);
      tell(`Saved "${saved.title}" · revision ${saved.revision}.${newer ? " New evidence is still unsaved." : ""}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      tell(e instanceof ApiError && e.status === 409 ? "This notebook changed in another session. Your draft is intact. Save a copy, or reload the latest version and discard this draft." : `Save failed: ${(e as Error).message}. Your draft is retained in this panel.`, true);
    } finally { setBusy(false); }
  };

  const remove = async () => {
    const draft = latest.current;
    if (busy || draft.id === null) return;
    if (!armedDelete) { setArmedDelete(true); tell("Click Delete again to permanently delete this saved notebook."); return; }
    setBusy(true);
    try {
      await api.notebooks.remove(user, draft.id, draft.revision!);
      update(latest.current === draft ? blank(security) : { ...latest.current, id: null, revision: null, dirty: true });
      setConflict(false);
      setVersion((v) => v + 1);
      tell("Notebook deleted.");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(true);
      tell((e as Error).message, true);
    } finally { setBusy(false); }
  };

  const addSource = () => {
    if (!source.title.trim()) { tell("Give the evidence a title.", true); return; }
    if (source.url && !/^https?:\/\//i.test(source.url.trim())) { tell("Evidence URLs must start with https:// or http://.", true); return; }
    const item: NotebookEvidence = {
      id: crypto.randomUUID(), kind: source.url.trim() ? "source" : "note", title: source.title.trim(), capturedAt: new Date().toISOString(),
      ...(editor.input.security ? { security: editor.input.security } : {}),
      ...(source.source.trim() ? { source: source.source.trim() } : {}),
      ...(source.url.trim() ? { url: source.url.trim() } : {}),
      ...(source.asOf ? { asOf: source.asOf } : {}),
      ...(source.note.trim() ? { data: { note: source.note.trim() } } : {}),
    };
    edit({ evidence: [...latest.current.input.evidence, item] });
    setSource({ title: "", source: "", url: "", asOf: "", note: "" });
    tell("Evidence added. Save the notebook to keep it on the server.");
  };

  return (
    <div className="research-screen" data-testid="note-screen">
      <Section title="Research Notebook" right={editor.id === null ? "Unsaved notebook" : `#${editor.id} · revision ${editor.revision}`} />
      <div className="toolbar">
        <label className="label">Saved <select className="form-select" data-testid="note-select" value={editor.id ?? ""} disabled={busy} onChange={(e) => { if (e.target.value) void open(Number(e.target.value)); }}>
          <option value="">Choose a notebook</option>{list.data?.map((notebook) => <option key={notebook.id} value={notebook.id}>{notebook.title}{notebook.security ? ` · ${notebook.security}` : ""}</option>)}
        </select></label>
        <button className="tool-button" disabled={busy} data-testid="note-new" onClick={() => void open("new")}>New</button>
        <button className="tool-button primary" disabled={busy || (conflict && editor.id !== null)} data-testid="note-save" onClick={() => void save()}>{busy ? "Working..." : "Save"}</button>
        <button className="tool-button" disabled={busy} data-testid="note-save-copy" onClick={() => void save(true)}>Save as copy</button>
        <button className="tool-button danger" disabled={busy || editor.id === null} onClick={() => void remove()}>Delete</button>
        {editor.dirty && <span className="yellow" data-testid="note-dirty">Unsaved changes</span>}
      </div>
      {message && <div className={error ? "cmdline-message research-message" : "research-copy gray"} data-testid="note-status">{message}</div>}
      {conflict && editor.id !== null && <button className="tool-button" data-testid="note-reload" disabled={busy} onClick={() => void open(editor.id!, true)}>Reload latest (discard draft)</button>}
      {pendingOpen !== null && <div className="toolbar"><button className="tool-button danger" disabled={busy} onClick={() => void open(pendingOpen, true)}>Discard draft and {pendingOpen === "new" ? "start new notebook" : "open notebook"}</button><button className="tool-button" onClick={() => setPendingOpen(null)}>Keep editing</button></div>}
      {list.error && <DataState state={list} what="SAVED NOTEBOOKS" />}
      <div className="form-grid">
        <label className="form-field"><span className="label">Title</span><input className="form-input" maxLength={120} disabled={busy} data-testid="note-title" value={editor.input.title} onChange={(e) => edit({ title: e.target.value })} /></label>
        <label className="form-field"><span className="label">Security (optional)</span><input className="form-input" disabled={busy} data-testid="note-security" value={editor.input.security ?? ""} placeholder="AAPL US Equity" onChange={(e) => edit({ security: e.target.value || null })} /></label>
        <label className="form-field"><span className="label">Review date</span><input className="form-input" type="date" disabled={busy} data-testid="note-review" value={editor.input.reviewDate ?? ""} onChange={(e) => edit({ reviewDate: e.target.value || null })} /></label>
      </div>
      {([['thesis', 'Investment thesis'], ['bearCase', 'Bear case / what would change your mind'], ['catalysts', 'Catalysts and questions to investigate']] as const).map(([key, label]) => <label className="research-text-field" key={key}><span className="label">{label}</span><textarea className="form-input research-textarea" rows={3} disabled={busy} maxLength={20_000} data-testid={`note-${key}`} value={editor.input[key]} onChange={(e) => edit({ [key]: e.target.value })} /></label>)}
      <Section title={`Evidence · ${editor.input.evidence.length}`} right="Captured snapshots retain their original assumptions" />
      {!editor.input.evidence.length && <p className="research-copy gray">Capture a run from VAL or SCEN, save an ASK answer, or add a source below. Source links are references; their content is not fetched automatically.</p>}
      {editor.input.evidence.map((item) => <article className="research-evidence" data-testid="note-evidence" key={item.id}>
        <div className="toolbar"><span className="white">{item.title}</span><span className="gray">{item.kind}</span><button className="row-remove" disabled={busy} aria-label={`Remove evidence ${item.title}`} onClick={() => edit({ evidence: latest.current.input.evidence.filter((e) => e.id !== item.id) })}>×</button></div>
        <div className="research-copy gray">{item.security ? `${item.security} · ` : ""}{item.source ? `${item.source} · ` : ""}Captured {fmtIsoDateTime(item.capturedAt)}{item.asOf ? ` · As of ${fmtIsoDateTime(item.asOf)}` : ""}</div>
        {item.url && /^https?:\/\//i.test(item.url) && <a className="research-link" href={item.url} target="_blank" rel="noopener noreferrer">{item.url}</a>}
        {item.data !== undefined && <details><summary className="gray">View captured data and assumptions</summary><pre className="research-snapshot">{JSON.stringify(item.data, null, 2)}</pre></details>}
      </article>)}
      <Section title="Add source or research note" />
      <div className="form-grid">
        <input className="form-input" disabled={busy} maxLength={200} placeholder="Evidence title" data-testid="note-source-title" value={source.title} onChange={(e) => setSource((s) => ({ ...s, title: e.target.value }))} />
        <input className="form-input" disabled={busy} maxLength={200} placeholder="Publisher or source (optional)" data-testid="note-source-publisher" value={source.source} onChange={(e) => setSource((s) => ({ ...s, source: e.target.value }))} />
        <input className="form-input" disabled={busy} maxLength={2048} placeholder="https://... (optional)" data-testid="note-source-url" value={source.url} onChange={(e) => setSource((s) => ({ ...s, url: e.target.value }))} />
        <label className="label">Source as of <input className="form-input" disabled={busy} type="date" data-testid="note-source-date" value={source.asOf} onChange={(e) => setSource((s) => ({ ...s, asOf: e.target.value }))} /></label>
        <textarea className="form-input research-textarea" rows={2} disabled={busy} placeholder="Observation, quote, or counter-evidence" data-testid="note-source-text" value={source.note} onChange={(e) => setSource((s) => ({ ...s, note: e.target.value }))} />
      </div>
      <div className="toolbar"><button className="tool-button" disabled={busy} data-testid="note-add-source" onClick={addSource}>Add evidence</button><button className="tool-button" data-testid="note-export-markdown" onClick={() => downloadResearch(`${editor.input.title || "research"}.md`, notebookMarkdown(editor.input), "text/markdown;charset=utf-8")}>Export Markdown</button><button className="tool-button" data-testid="note-export-json" onClick={() => downloadResearch(`${editor.input.title || "research"}.json`, JSON.stringify({ ...editor.input, id: editor.id, revision: editor.revision, exportedAt: new Date().toISOString() }, null, 2), "application/json")}>Export JSON</button></div>
      <p className="research-copy gray">Drafts survive navigation in this browser session. Click Save for durable storage. Exports include your current draft and captured evidence.</p>
    </div>
  );
}
