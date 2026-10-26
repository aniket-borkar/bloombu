import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { Quote } from "../src/api";

const SECURITY = "XBTUSD Curncy";

function quote(time: string, last: number): Quote {
  return {
    security: SECURITY, name: "Bitcoin USD", source: "Kraken", exchange: "Kraken", currency: "USD",
    last, change: 1, changePct: 0.001, bid: last - 1, ask: last + 1, bidSize: 1, askSize: 2,
    open: null, high: 81000, low: 79000, prevClose: last - 1, volume: 50,
    marketState: "REGULAR", time, delayMinutes: 0,
  };
}

function ticker(time: string, last: number) {
  return JSON.stringify({ channel: "ticker", type: "update", data: [{
    symbol: "BTC/USD", last, bid: last - 1, ask: last + 1, bid_qty: 1, ask_qty: 2,
    change: 1, change_pct: 0.001, high: 81000, low: 79000, volume: 50, timestamp: time,
  }] });
}

async function fixture(page: Page, directKraken: boolean) {
  const received: { op?: string; securities?: string[] }[] = [];
  const publicRequests: { method?: string; params?: { channel?: string; symbol?: string[] } }[] = [];
  let relayQuote = quote(new Date(Date.now() - 10_000).toISOString(), 80000);
  let relay: WebSocketRoute | undefined;
  let direct: WebSocketRoute | undefined;
  let directConnections = 0;
  await page.route("**/api/indices", (route) => route.fulfill({ json: [] }));
  await page.route("**/api/quote/XBTUSD*", (route) => route.fulfill({ json: relayQuote }));
  await page.route("**/api/stream/routes?*", (route) => route.fulfill({ json: {
    routes: [{ security: SECURITY, provider: directKraken ? "kraken" : null }],
  } }));
  await page.routeWebSocket("**/ws", (ws) => {
    relay = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      if (message.op === "sub" && message.securities.includes(SECURITY)) {
        ws.send(JSON.stringify({ type: "quote", quote: relayQuote }));
      }
    });
    ws.send(JSON.stringify({ type: "stream.config", directKraken }));
  });
  await page.routeWebSocket("wss://ws.kraken.com/v2", (ws) => {
    directConnections++;
    direct = ws;
    ws.onMessage((raw) => publicRequests.push(JSON.parse(String(raw))));
  });
  await page.goto("/?popout=1&security=XBTUSD%20Curncy");
  const panel = page.getByTestId("panel-1");
  await expect(panel.getByTestId("last-price")).toHaveText("80,000.00");
  return {
    panel, received, publicRequests,
    relay: () => relay!, direct: () => direct!, directConnections: () => directConnections,
    setRelay: (time: string, last: number) => { relayQuote = quote(time, last); },
    setPolicy: (enabled: boolean) => { directKraken = enabled; },
  };
}

test("a direct public tick replaces the relay and a closed public feed restores it", async ({ page }) => {
  const f = await fixture(page, true);
  await expect.poll(() => f.publicRequests.some((m) => m.method === "subscribe" && m.params?.channel === "ticker"
    && m.params.symbol?.includes("BTC/USD"))).toBe(true);
  // Subscription alone must not remove the working fallback before a valid tick.
  expect(f.received.filter((m) => m.op === "unsub" && m.securities?.includes(SECURITY))).toHaveLength(0);
  const directAt = Date.now() - 1000;
  f.direct().send(ticker(new Date(directAt).toISOString(), 80001));
  await expect(f.panel.getByTestId("last-price")).toHaveText("80,001.00");
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Direct feed");
  await expect.poll(() => f.received.some((m) => m.op === "unsub" && m.securities?.includes(SECURITY))).toBe(true);

  // An already queued relay event must not rewind a newer direct observation.
  f.relay().send(JSON.stringify({ type: "quote", quote: quote(new Date(directAt - 1000).toISOString(), 79000) }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(f.panel.getByTestId("last-price")).toHaveText("80,001.00");

  f.setRelay(new Date(directAt + 1000).toISOString(), 80002);
  f.direct().close({ code: 1011, reason: "Fixture upstream interruption" });
  await expect.poll(() => f.received.filter((m) => m.op === "sub" && m.securities?.includes(SECURITY)).length).toBeGreaterThanOrEqual(2);
  await expect(f.panel.getByTestId("last-price")).toHaveText("80,002.00");
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Server feed");
});

test("server policy must enable direct access before any public connection opens", async ({ page }) => {
  const f = await fixture(page, false);
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Server feed");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(f.directConnections()).toBe(0);
  expect(f.publicRequests).toHaveLength(0);
  expect(f.received.filter((m) => m.op === "unsub" && m.securities?.includes(SECURITY))).toHaveLength(0);
});

test("revoking direct-feed policy closes the public route and restores server updates", async ({ page }) => {
  const f = await fixture(page, true);
  await expect.poll(() => f.publicRequests.some((m) => m.method === "subscribe")).toBe(true);
  const at = Date.now() - 1000;
  f.direct().send(ticker(new Date(at).toISOString(), 80001));
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Direct feed");

  f.setRelay(new Date(at + 1000).toISOString(), 80003);
  f.setPolicy(false);
  f.relay().send(JSON.stringify({ type: "stream.config", directKraken: false }));
  await expect(f.panel.getByTestId("last-price")).toHaveText("80,003.00");
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Server feed");
  await expect.poll(() => f.received.filter((m) => m.op === "sub" && m.securities?.includes(SECURITY)).length).toBeGreaterThanOrEqual(2);
});
