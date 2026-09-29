import { create } from "zustand";

export type SocketState = "connecting" | "open" | "closed";

interface Connection {
  socket: SocketState;
  /** Whether the most recent REST request reached a working server. */
  rest: boolean;
}

export const useConnection = create<Connection>(() => ({ socket: "closed", rest: true }));

export type ConnectionLabel = "LIVE" | "POLL" | "OFFLINE";

export function connectionLabel(c: Connection): ConnectionLabel {
  if (c.socket === "open") return "LIVE";
  return c.rest ? "POLL" : "OFFLINE";
}
