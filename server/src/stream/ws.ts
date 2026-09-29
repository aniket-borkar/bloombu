import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { normalizeUser, type ChatService } from "../chat/chat.js";
import type { StreamClient, StreamHub } from "./hub.js";
import type { Presence } from "./presence.js";
import type { TradeHub, TradeMessage } from "./trades.js";

const HEARTBEAT_MS = 30_000;

export interface WsServices {
  chat?: ChatService;
  presence?: Presence;
  trades?: TradeHub;
  /**
   * With authentication on: the signed-in user for an upgrade request, or null
   * to refuse the connection. That user replaces any name sent in "hello".
   */
  authenticate?: (req: IncomingMessage) => string | null;
}

/**
 * Serve live quotes, time and sales, chat and per-user pushes on
 * `ws://<host>/ws`, dropping clients that stop answering pings. Messages with
 * `op: "chat.*"` go to chat, `op: "trades.*"` to the trade tape, `op: "hello"`
 * identifies the user, and everything else goes to the quote hub.
 */
export function attachWebSocket(server: Server, hub: StreamHub, services: WsServices = {}): WebSocketServer {
  const { chat, presence, trades, authenticate } = services;
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient: authenticate ? (info: { req: IncomingMessage }) => authenticate(info.req) !== null : undefined,
  });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws, req) => {
    const client: StreamClient = {
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
    };
    const signedIn = authenticate ? authenticate(req) : null;
    if (signedIn) presence?.register(client, signedIn);
    alive.set(ws, true);
    hub.connect(client);
    chat?.connect(client);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("message", (data) => {
      const raw = data.toString();
      if (raw.includes('"chat.') || raw.includes('"hello"') || raw.includes('"trades.')) {
        let msg: { op?: unknown; user?: unknown } | null = null;
        try {
          msg = JSON.parse(raw);
        } catch {
          msg = null;
        }
        const op = msg?.op;
        if (op === "hello") {
          const user = signedIn ?? normalizeUser(msg!.user);
          if (user) presence?.register(client, user);
          return;
        }
        if (trades && (op === "trades.sub" || op === "trades.unsub")) return trades.handleMessage(client, msg as TradeMessage);
        if (chat && typeof op === "string" && op.startsWith("chat.")) {
          return chat.handle(client, signedIn ? { ...(msg as { op: string }), user: signedIn } : (msg as { op: string }));
        }
      }
      hub.handleMessage(client, raw);
    });
    ws.on("close", () => {
      hub.disconnect(client);
      chat?.disconnect(client);
      trades?.disconnect(client);
      presence?.unregister(client);
    });
    ws.on("error", () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}
