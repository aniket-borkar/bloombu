import { useEffect, useState } from "react";
import { api, useData } from "../api";
import { LAYOUTS, usePanels, type Workspace } from "../store/panels";
import { KeyValues, OptionBar, Section, useOptions, type ScreenProps } from "./common";

/** LAYOUT: panel count, link groups and saved workspaces. */
export function LayoutScreen({ panel }: ScreenProps) {
  const user = usePanels((s) => s.user);
  const layout = usePanels((s) => s.layout);
  const selected = useOptions(panel, LAYOUTS.length, LAYOUTS.indexOf(layout));
  const [version, setVersion] = useState(0);
  const saved = useData(`workspaces|${user}|${version}`, (s) => api.docs.list(user, "workspace", s));
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (panel.option === null) return;
    usePanels.getState().setLayout(LAYOUTS[selected]);
  }, [panel.option]);

  const save = async () => {
    const n = name.trim();
    if (!n) return;
    await api.docs.put(user, "workspace", n, usePanels.getState().snapshot());
    setName("");
    setVersion((v) => v + 1);
    setMessage(`Saved workspace "${n}".`);
  };

  const open = async (n: string) => {
    try {
      usePanels.getState().restore(await api.docs.get<Workspace>(user, "workspace", n));
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  const remove = async (n: string) => {
    await api.docs.remove(user, "workspace", n);
    setVersion((v) => v + 1);
  };

  return (
    <div className="col-flex" data-testid="layout-screen">
      <OptionBar panel={panel} labels={LAYOUTS.map((n) => `${n} panel${n > 1 ? "s" : ""}`)} selected={selected} testId="layout-options" />
      <Section title="Linked Panels" />
      <p className="prose">
        Click the square at the left of a panel's title bar to put it in a colored link group. Loading a security in a linked panel loads it in every
        panel of the same color, each keeping its own function (for example DES, GP and FA side by side).
      </p>
      <Section title="Saved Workspaces" right="Layout, screens and link groups" />
      <div className="toolbar">
        <input className="form-input" placeholder="Workspace name" value={name} data-testid="ws-name" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        <button className="tool-button primary" onClick={() => void save()} disabled={!name.trim()}>
          Save Current
        </button>
        {message && <span className="gray">{message}</span>}
      </div>
      <div className="toolbar">
        {saved.data?.length ? (
          saved.data.map((w) => (
            <span key={w.name} className="inline-quote">
              <button className="tool-button" data-testid="ws-open" onClick={() => void open(w.name)}>
                {w.name}
              </button>
              <button className="row-remove" title="Delete" onClick={() => void remove(w.name)}>
                x
              </button>
            </span>
          ))
        ) : (
          <span className="gray">No saved workspaces yet.</span>
        )}
      </div>
      <Section title="Shortcuts" />
      <KeyValues
        columns={1}
        items={[
          ["Ctrl/Cmd+K", "Command palette: functions, securities, portfolios, sheets, recent screens"],
          ["⧉ in a title bar", "Pop the panel out into its own window"],
          ["Tab / Shift+Tab", "Move between visible panels"],
        ]}
      />
    </div>
  );
}
