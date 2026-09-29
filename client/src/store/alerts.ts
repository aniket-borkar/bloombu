import { create } from "zustand";
import { quoteStream } from "../stream";

export interface Toast {
  id: number;
  message: string;
  security: string | null;
  time: number;
}

interface AlertState {
  toasts: Toast[];
  /** Incremented on each alert so open ALRT screens refresh. */
  version: number;
  add: (message: string, security: string | null) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useAlerts = create<AlertState>((set) => ({
  toasts: [],
  version: 0,
  add: (message, security) =>
    set((s) => ({ toasts: [{ id: nextId++, message, security, time: Date.now() }, ...s.toasts].slice(0, 20), version: s.version + 1 })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Identify this browser's user on the socket and surface alert pushes. Returns a cleanup function. */
export function listenForAlerts(user: string): () => void {
  const offAlert = quoteStream.on("alert", (msg) => {
    const message = String(msg.message ?? "Alert triggered");
    const security = (msg.alert as { security?: string } | undefined)?.security ?? null;
    useAlerts.getState().add(message, security);
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification("BLMBU alert", { body: message });
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    }
  });
  const offFill = quoteStream.on("paper.fill", (msg) => {
    useAlerts.getState().add(String(msg.message ?? "Paper order updated"), (msg.order as { security?: string } | undefined)?.security ?? null);
  });
  const offOpen = quoteStream.onOpen(() => quoteStream.send({ op: "hello", user }));
  return () => {
    offAlert();
    offFill();
    offOpen();
  };
}
