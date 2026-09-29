import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, DEFAULT_SECURITIES, applyPopoutParams } from "./App";
import { loadAuthStatus } from "./auth";
import { loadPluginFunctions } from "./plugins";
import { usePanels } from "./store/panels";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./styles/terminal.css";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}

void Promise.all([loadPluginFunctions(), loadAuthStatus()]).then(([, auth]) => {
  const popout = applyPopoutParams(location.search);
  if (!popout && auth.authRequired && auth.user) {
    const s = usePanels.getState();
    s.loadDefaults(DEFAULT_SECURITIES);
    s.login(auth.user);
  }
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
