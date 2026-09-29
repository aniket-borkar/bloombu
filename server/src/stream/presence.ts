import type { StreamClient } from "./hub.js";

/** Which login name each WebSocket client belongs to, for per-user pushes (alerts). */
export class Presence {
  private users = new Map<StreamClient, string>();

  register(client: StreamClient, user: string): void {
    this.users.set(client, user);
  }

  unregister(client: StreamClient): void {
    this.users.delete(client);
  }

  sendTo(user: string, payload: unknown): number {
    const data = JSON.stringify(payload);
    let sent = 0;
    for (const [client, u] of this.users) {
      if (u === user) {
        client.send(data);
        sent++;
      }
    }
    return sent;
  }
}
