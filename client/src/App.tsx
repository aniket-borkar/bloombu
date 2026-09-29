import { useEffect, useState } from "react";
import { authStatus } from "./auth";
import { CommandPalette } from "./components/CommandPalette";
import { KeyLegend } from "./components/KeyLegend";
import { Panel } from "./components/Panel";
import { Splash } from "./components/Splash";
import { StatusBar } from "./components/StatusBar";
import { listenForAlerts } from "./store/alerts";
import { usePanels } from "./store/panels";
import { dispatch } from "./terminal/dispatch";
import { isFormField } from "./terminal/focus";
import { mapKey } from "./terminal/keymap";

export const DEFAULT_SECURITIES = ["SPX Index", "AAPL US Equity", "EURUSD Curncy", "CL1 Comdty"];

/** A popped-out window opens straight into one panel showing the given screen. */
export function applyPopoutParams(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get("popout") !== "1") return false;
  const s = usePanels.getState();
  s.login(authStatus.authRequired ? (authStatus.user ?? "") : (params.get("user") ?? ""));
  s.setLayout(1);
  const security = params.get("security");
  const fn = params.get("fn");
  if (security) s.execute(1, { kind: "load", security, fn });
  else if (fn) s.execute(1, { kind: "function", fn });
  return true;
}

export function App() {
  const panels = usePanels((s) => s.panels);
  const focused = usePanels((s) => s.focused);
  const loggedIn = usePanels((s) => s.loggedIn);
  const layout = usePanels((s) => s.layout);
  const user = usePanels((s) => s.user);
  const [palette, setPalette] = useState(false);

  useEffect(() => (loggedIn ? listenForAlerts(user) : undefined), [loggedIn, user]);

  useEffect(() => {
    if (!loggedIn) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.defaultPrevented) return;
      const s = usePanels.getState();
      if (isFormField(e.target)) {
        if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLElement).blur();
          s.refocus();
        }
        return;
      }
      const panel = s.panels.find((p) => p.id === s.focused)!;
      const action = mapKey(e, panel.input === "");
      if (!action) return;
      e.preventDefault();
      dispatch(action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [loggedIn]);

  if (!loggedIn) {
    return (
      <Splash
        onLogin={(name) => {
          const s = usePanels.getState();
          s.loadDefaults(DEFAULT_SECURITIES);
          s.login(name);
        }}
      />
    );
  }

  return (
    <div className="app">
      <main className={`grid layout-${layout}`}>
        {panels.slice(0, layout).map((p) => (
          <Panel key={p.id} panel={p} focused={p.id === focused} />
        ))}
      </main>
      <KeyLegend />
      <StatusBar />
      {palette && (
        <CommandPalette
          onClose={() => {
            setPalette(false);
            usePanels.getState().refocus();
          }}
        />
      )}
    </div>
  );
}
