import { useEffect, useState } from "react";
import type { ChatMessage } from "./api";
import { quoteStream } from "./stream";

/** Direct-message room id for two users, independent of order (matches the server). */
export function dmRoom(a: string, b: string): string {
  return `dm:${[a, b].sort().join(":")}`;
}

/** Display name for a room: public rooms as-is, DMs as the other participant. */
export function roomLabel(room: string, user: string): string {
  if (!room.startsWith("dm:")) return room;
  const [, a, b] = room.split(":");
  return `@${a === user ? b : a}`;
}

// Joins are reference-counted per room because all panels share one socket.
const joined = new Map<string, { count: number; user: string }>();

quoteStream.onOpen(() => {
  for (const [room, { user }] of joined) quoteStream.send({ op: "chat.join", room, user });
});

function join(room: string, user: string): () => void {
  const entry = joined.get(room);
  if (entry) {
    entry.count++;
    quoteStream.send({ op: "chat.join", room, user });
  } else {
    joined.set(room, { count: 1, user });
    quoteStream.send({ op: "chat.join", room, user });
  }
  return () => {
    const e = joined.get(room);
    if (!e) return;
    if (--e.count > 0) return;
    joined.delete(room);
    quoteStream.send({ op: "chat.leave", room, user });
  };
}

export function useChatRoom(room: string | null, user: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
    if (!room) return;
    const offHistory = quoteStream.on("chat.history", (m) => {
      if (m.room === room) setMessages(m.messages as ChatMessage[]);
    });
    const offMessage = quoteStream.on("chat.message", (m) => {
      const msg = m.message as ChatMessage;
      if (msg.room === room) setMessages((prev) => (prev.some((p) => p.id === msg.id) ? prev : [...prev, msg]));
    });
    const offError = quoteStream.on("error", (m) => setError(String(m.message)));
    const leave = join(room, user);
    return () => {
      offHistory();
      offMessage();
      offError();
      leave();
    };
  }, [room, user]);

  const send = (text: string) => {
    if (!room || !text.trim()) return false;
    const ok = quoteStream.send({ op: "chat.send", room, user, text: text.trim() });
    if (!ok) setError("NOT CONNECTED. MESSAGE NOT SENT");
    return ok;
  };

  return { messages, error, send };
}
