import { describe, expect, it } from "vitest";
import type { StreamClient } from "../stream/hub.js";
import { ChatService, dmRoom, roomFor } from "./chat.js";

function client() {
  const received: { type: string; [k: string]: unknown }[] = [];
  const c: StreamClient = { send: (d) => received.push(JSON.parse(d)) };
  return { c, received };
}

describe("ChatService", () => {
  it("delivers room messages to joined clients and persists history", () => {
    let t = 1000;
    const chat = new ChatService(":memory:", () => t++);
    const a = client();
    const b = client();
    chat.connect(a.c);
    chat.connect(b.c);
    chat.handle(a.c, { op: "chat.join", room: "#general", user: "alice" });
    chat.handle(a.c, { op: "chat.send", room: "#general", user: "alice", text: "  hello  " });
    chat.handle(b.c, { op: "chat.join", room: "#general", user: "bob" });

    expect(a.received.map((m) => m.type)).toEqual(["chat.history", "chat.message"]);
    expect(a.received[1].message).toMatchObject({ room: "#general", user: "ALICE", text: "hello", ts: 1000 });
    const history = b.received[0] as unknown as { messages: { text: string }[] };
    expect(history.messages.map((m) => m.text)).toEqual(["hello"]);

    chat.handle(b.c, { op: "chat.leave", room: "#general", user: "bob" });
    chat.handle(a.c, { op: "chat.send", room: "#general", user: "alice", text: "second" });
    expect(b.received).toHaveLength(1);
    chat.close();
  });

  it("restricts direct-message rooms to participants and lists them", () => {
    const chat = new ChatService(":memory:");
    const a = client();
    chat.connect(a.c);
    const room = dmRoom("BOB", "ALICE");
    expect(room).toBe("dm:ALICE:BOB");
    chat.handle(a.c, { op: "chat.send", room, user: "alice", text: "hi bob" });
    chat.handle(a.c, { op: "chat.join", room, user: "carol" });
    expect(a.received.at(-1)).toEqual({ type: "error", message: "invalid room" });
    expect(chat.rooms("BOB").map((r) => r.room)).toContain(room);
    expect(chat.rooms("CAROL").map((r) => r.room)).not.toContain(room);
    expect(chat.rooms("BOB").find((r) => r.room === room)?.last?.text).toBe("hi bob");
    chat.close();
  });

  it("validates users, rooms and message length", () => {
    const chat = new ChatService(":memory:");
    const a = client();
    chat.connect(a.c);
    chat.handle(a.c, { op: "chat.join", room: "#general", user: "bad user!" });
    chat.handle(a.c, { op: "chat.join", room: "general", user: "alice" });
    chat.handle(a.c, { op: "chat.send", room: "#general", user: "alice", text: "x".repeat(1001) });
    expect(a.received.map((m) => m.type)).toEqual(["error", "error", "error"]);
    expect(roomFor("dm:ALICE:BOB", "ALICE")).toBe("dm:ALICE:BOB");
    expect(roomFor("dm:BOB:ALICE", "ALICE")).toBeNull();
    chat.close();
  });
});
