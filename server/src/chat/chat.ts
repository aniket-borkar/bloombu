import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import type { StreamClient } from "../stream/hub.js";
import type { ChatMessage } from "../types.js";

export const PUBLIC_ROOMS = ["#general", "#markets", "#research", "#trading"];
const USER_RE = /^[A-Z0-9._-]{1,24}$/;
const ROOM_RE = /^#[a-z0-9-]{1,24}$/;
const MAX_TEXT = 1000;
const HISTORY = 200;

export function normalizeUser(user: unknown): string | null {
  if (typeof user !== "string") return null;
  const u = user.trim().toUpperCase();
  return USER_RE.test(u) ? u : null;
}

/** Direct-message room id for two users, independent of order. */
export function dmRoom(a: string, b: string): string {
  return `dm:${[a, b].sort().join(":")}`;
}

/** Validate a room id; direct-message rooms may only be used by their participants. */
export function roomFor(room: unknown, user: string): string | null {
  if (typeof room !== "string") return null;
  if (ROOM_RE.test(room)) return room;
  const m = room.match(/^dm:([A-Z0-9._-]{1,24}):([A-Z0-9._-]{1,24})$/);
  if (m && (m[1] === user || m[2] === user) && dmRoom(m[1], m[2]) === room) return room;
  return null;
}

type ChatOp = { op: string; room?: unknown; user?: unknown; text?: unknown };

/**
 * Chat rooms and direct messages for users of one self-hosted instance. Users
 * identify themselves by login name; there is no authentication.
 */
export class ChatService {
  private db: DatabaseSync;
  private members = new Map<StreamClient, Set<string>>();

  constructor(
    file: string,
    private now: () => number = Date.now,
  ) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.db = openDatabase(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT NOT NULL,
        user TEXT NOT NULL,
        text TEXT NOT NULL,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages (room, id);
    `);
  }

  close(): void {
    this.db.close();
  }

  connect(client: StreamClient): void {
    this.members.set(client, new Set());
  }

  disconnect(client: StreamClient): void {
    this.members.delete(client);
  }

  handle(client: StreamClient, msg: ChatOp): void {
    const rooms = this.members.get(client);
    if (!rooms) return;
    const user = normalizeUser(msg.user);
    if (!user) return this.error(client, "chat requires a login name of 1-24 letters, digits, '.', '_' or '-'");
    const room = roomFor(msg.room, user);
    if (!room) return this.error(client, "invalid room");

    if (msg.op === "chat.join") {
      rooms.add(room);
      client.send(JSON.stringify({ type: "chat.history", room, messages: this.history(room) }));
    } else if (msg.op === "chat.leave") {
      rooms.delete(room);
    } else if (msg.op === "chat.send") {
      const text = typeof msg.text === "string" ? msg.text.trim() : "";
      if (!text) return;
      if (text.length > MAX_TEXT) return this.error(client, `message longer than ${MAX_TEXT} characters`);
      this.post(room, user, text);
    } else {
      this.error(client, `unknown op ${msg.op}`);
    }
  }

  post(room: string, user: string, text: string): ChatMessage {
    const ts = this.now();
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO chat_messages (room, user, text, ts) VALUES (?, ?, ?, ?)")
      .run(room, user, text, ts);
    const message: ChatMessage = { id: Number(lastInsertRowid), room, user, text, ts };
    const payload = JSON.stringify({ type: "chat.message", message });
    for (const [client, rooms] of this.members) {
      if (rooms.has(room)) client.send(payload);
    }
    return message;
  }

  history(room: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT id, room, user, text, ts FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT ?")
      .all(room, HISTORY) as unknown as ChatMessage[];
    return rows.reverse().map((r) => ({ ...r }));
  }

  /** Public rooms plus the user's direct-message rooms, each with its latest message. */
  rooms(user: string): { room: string; last: ChatMessage | null }[] {
    const latest = (room: string) =>
      (this.db
        .prepare("SELECT id, room, user, text, ts FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT 1")
        .get(room) as ChatMessage | undefined) ?? null;
    const escapedUser = user.replace(/[!%_]/g, "!$&");
    const dms = (
      this.db
        .prepare("SELECT DISTINCT room FROM chat_messages WHERE room LIKE 'dm:%' AND (room LIKE ? ESCAPE '!' OR room LIKE ? ESCAPE '!')")
        .all(`dm:${escapedUser}:%`, `dm:%:${escapedUser}`) as { room: string }[]
    ).map((r) => r.room);
    return [...PUBLIC_ROOMS, ...dms].map((room) => {
      const last = latest(room);
      return { room, last: last ? { ...last } : null };
    });
  }

  private error(client: StreamClient, message: string): void {
    client.send(JSON.stringify({ type: "error", message }));
  }
}
