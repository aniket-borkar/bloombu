import type { ProviderPlugin } from "../providers/DataProvider.js";
import { normalizeSecurity } from "../symbology.js";
import type { Trade } from "../types.js";
import type { StreamClient } from "./hub.js";

export interface TradeSource {
  tradesPlugin(security: string): ProviderPlugin | null;
}

export type TradeMessage = { op: "trades.sub" | "trades.unsub"; security: string };

interface Feed {
  unsubscribe: () => void;
  buffer: Trade[];
  clients: Set<StreamClient>;
}

/**
 * Time and sales: one upstream trade subscription per security, shared by every
 * client watching it, with a recent-trades buffer sent to newcomers.
 */
export class TradeHub {
  private feeds = new Map<string, Feed>();
  private byClient = new Map<StreamClient, Set<string>>();

  constructor(
    private source: TradeSource,
    private bufferSize = 500,
  ) {}

  handleMessage(client: StreamClient, msg: TradeMessage): void {
    const security = typeof msg.security === "string" ? normalizeSecurity(msg.security) : null;
    if (!security) return client.send(JSON.stringify({ type: "error", message: "trades.sub needs a security" }));
    if (msg.op === "trades.sub") this.subscribe(client, security);
    else this.unsubscribe(client, security);
  }

  disconnect(client: StreamClient): void {
    for (const security of this.byClient.get(client) ?? []) this.unsubscribe(client, security);
    this.byClient.delete(client);
  }

  stats(): { feeds: number } {
    return { feeds: this.feeds.size };
  }

  private subscribe(client: StreamClient, security: string): void {
    let feed = this.feeds.get(security);
    if (!feed) {
      const plugin = this.source.tradesPlugin(security);
      if (!plugin?.subscribeTrades) {
        client.send(JSON.stringify({ type: "trades", security, available: false, trades: [] }));
        return;
      }
      const created: Feed = { unsubscribe: () => {}, buffer: [], clients: new Set() };
      this.feeds.set(security, created);
      created.unsubscribe = plugin.subscribeTrades(security, (trade) => {
        created.buffer.push(trade);
        if (created.buffer.length > this.bufferSize) created.buffer.shift();
        const msg = JSON.stringify({ type: "trade", security, trade });
        for (const c of created.clients) c.send(msg);
      });
      feed = created;
    }
    if (feed.clients.has(client)) return;
    feed.clients.add(client);
    let mine = this.byClient.get(client);
    if (!mine) this.byClient.set(client, (mine = new Set()));
    mine.add(security);
    client.send(JSON.stringify({ type: "trades", security, available: true, trades: feed.buffer }));
  }

  private unsubscribe(client: StreamClient, security: string): void {
    this.byClient.get(client)?.delete(security);
    const feed = this.feeds.get(security);
    if (!feed || !feed.clients.delete(client) || feed.clients.size) return;
    feed.unsubscribe();
    this.feeds.delete(security);
  }
}
