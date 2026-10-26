import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { Quote } from "../src/api";

const SECURITY = "EURUSD Curncy";
const URL = "wss://streamer.finance.yahoo.com/?version=2";
function quote(time: number, last: number): Quote {
  return { security: SECURITY, name: "EUR/USD", last, change: 0, changePct: 0, bid: null, ask: null,
    bidSize: null, askSize: null, open: null, high: null, low: null, prevClose: last, volume: null,
    currency: "USD", exchange: "CCY", marketState: "REGULAR", priceSession: "regular",
    time: new Date(time).toISOString(), delayMinutes: 0, source: "Yahoo Finance" };
}
function varint(input: bigint | number): Buffer {
  let value = BigInt(input); const bytes: number[] = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return Buffer.from(bytes);
}
function ticker(time: number, last: number): string {
  const id = Buffer.from("EURUSD=X"); const price = Buffer.alloc(4); price.writeFloatLE(last);
  const payload = Buffer.concat([varint(10), varint(id.length), id, varint(21), price, varint(24), varint(BigInt(time) * 2n), varint(56), varint(1)]);
  return JSON.stringify({ message: payload.toString("base64") });
}
async function fixture(page: Page, enabled: boolean, relayAvailable = true) {
  const received: { op?: string; securities?: string[] }[] = [];
  const requests: { subscribe?: string[]; unsubscribe?: string[] }[] = [];
  let policyRequests = 0;
  let relayQuote = quote(Date.now() - 10_000, 1.10);
  let relay: WebSocketRoute | undefined;
  let direct: WebSocketRoute | undefined;
  let connections = 0;
  await page.route("**/api/quote/EURUSD*", (route) => route.fulfill({ json: relayQuote }));
  await page.route("**/api/stream/routes?*", (route) => {
    policyRequests++;
    return route.fulfill({ json: { routes: [{ security: SECURITY, provider: enabled ? "yahoo" : null }] } });
  });
  await page.routeWebSocket("**/ws", (ws) => {
    relay = ws;
    if (!relayAvailable) { ws.close({ code: 1011, reason: "Fixture serverless host has no quote socket" }); return; }
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)); received.push(message);
      if (message.op === "sub" && message.securities.includes(SECURITY)) ws.send(JSON.stringify({ type: "quote", quote: relayQuote }));
    });
  });
  await page.routeWebSocket(URL, (ws) => {
    connections++; direct = ws;
    ws.onMessage((raw) => requests.push(JSON.parse(String(raw))));
  });
  await page.goto("/?popout=1&security=EURUSD%20Curncy");
  const panel = page.getByTestId("panel-1");
  await expect(panel.getByTestId("last-price")).toHaveText(/^1\.1000(?:0)?$/);
  await expect.poll(() => policyRequests).toBeGreaterThan(0);
  return { panel, received, requests, connections: () => connections, direct: () => direct!, relay: () => relay!,
    setRelay: (time: number, last: number) => { relayQuote = quote(time, last); } };
}

test("direct Yahoo updates FX through HTTP-authorized policy even without a server quote socket", async ({ page }) => {
  const f = await fixture(page, true, false);
  await expect.poll(() => f.requests.some((request) => request.subscribe?.includes("EURUSD=X"))).toBe(true);
  const at = Date.now();
  f.direct().send(ticker(at, 1.12));
  await expect(f.panel.getByTestId("last-price")).toHaveText("1.12000");
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Direct feed");
  // Sustained one-second native updates include changes hidden by four-decimal FX formatting.
  // This also crosses the HTTP fallback interval while its snapshot remains older.
  for (let i = 1; i <= 12; i++) {
    await page.waitForTimeout(1000);
    const price = 1.12 + i * 0.00001;
    f.direct().send(ticker(at + i * 1000, price));
    await expect(f.panel.getByTestId("last-price")).toHaveText(price.toFixed(5));
  }
  f.direct().send("{"); f.direct().send(JSON.stringify({ message: "malformed" }));
  f.direct().send(ticker(at - 1000, 1.01));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(f.panel.getByTestId("last-price")).toHaveText("1.12012");
  expect(f.connections()).toBe(1);
});

test("a direct Yahoo tick retires the relay and an interrupted public feed restores it", async ({ page }) => {
  const f = await fixture(page, true);
  await expect.poll(() => f.requests.some((request) => request.subscribe?.includes("EURUSD=X"))).toBe(true);
  expect(f.received.filter((message) => message.op === "unsub")).toHaveLength(0);
  const at = Date.now(); f.direct().send(ticker(at, 1.12));
  await expect(f.panel.getByTestId("last-price")).toHaveText(/^1\.1200(?:0)?$/);
  await expect.poll(() => f.received.some((message) => message.op === "unsub" && message.securities?.includes(SECURITY))).toBe(true);
  f.relay().send(JSON.stringify({ type: "quote", quote: quote(at - 1000, 1.01) }));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(f.panel.getByTestId("last-price")).toHaveText(/^1\.1200(?:0)?$/);
  f.setRelay(at + 1000, 1.13);
  f.direct().close({ code: 1011, reason: "Fixture public stream interruption" });
  await expect.poll(() => f.received.filter((message) => message.op === "sub" && message.securities?.includes(SECURITY)).length).toBeGreaterThanOrEqual(2);
  await expect(f.panel.getByTestId("last-price")).toHaveText(/^1\.1300(?:0)?$/);
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Server feed");
});

test("a provider policy that denies direct Yahoo opens no public connection", async ({ page }) => {
  const f = await fixture(page, false);
  await expect(f.panel.getByTestId("quote-route")).toHaveText("Server feed");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(f.connections()).toBe(0); expect(f.requests).toHaveLength(0);
  expect(f.received.filter((message) => message.op === "unsub")).toHaveLength(0);
});
