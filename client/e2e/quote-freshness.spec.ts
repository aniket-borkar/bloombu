import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { Quote } from "../src/api";

function quote(time: string, last: number, source = "Test stream"): Quote {
  return {
    security: "AAPL US Equity", name: "Apple Inc.", last, change: last - 100, changePct: last - 100,
    bid: last - 0.01, ask: last + 0.01, bidSize: 100, askSize: 100,
    open: 100, high: 103, low: 99, prevClose: 100, volume: 1000,
    currency: "USD", exchange: "TEST", marketState: null, time, delayMinutes: 0, source,
  };
}

for (const lateResponse of ["older snapshot", "404 error"] as const) {
  test(`a newer live quote survives a late ${lateResponse}`, async ({ page }) => {
    const sourceTime = Date.now() - 5000;
    const live = quote(new Date(sourceTime).toISOString(), 101);
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    await page.route("**/api/quote/AAPL*", async (route) => {
      await snapshotGate;
      await route.fulfill(lateResponse === "older snapshot" ? {
        json: quote(new Date(sourceTime - 10_000).toISOString(), 100, "Yahoo Finance"),
      } : { status: 404, json: { error: "UNKNOWN SECURITY" } }).catch(() => {});
    });
    let socket: WebSocketRoute | undefined;
    await page.routeWebSocket("**/ws", (ws) => {
      socket = ws;
      ws.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.op === "sub" && message.securities.includes(live.security)) ws.send(JSON.stringify({ type: "quote", quote: live }));
      });
    });

    await page.goto("/?popout=1&security=AAPL%20US%20Equity");
    const panel = page.getByTestId("panel-1");
    const price = panel.getByTestId("last-price");
    await expect(price).toHaveText("101.00");
    await expect(panel.getByTestId("security-header")).toContainText("Test stream");
    await expect(panel.getByTestId("quote-age")).toHaveText(/\ds old/);
    await expect(page.getByTestId("connection")).toHaveAttribute("title", /socket is connected/);

    const response = page.waitForResponse((r) => r.url().includes("/api/quote/AAPL"));
    releaseSnapshot();
    await (await response).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(price).toHaveText("101.00");
    await expect(panel.getByTestId("unknown-security")).toHaveCount(0);

    socket!.send(JSON.stringify({ type: "quote", quote: quote(new Date(sourceTime + 1000).toISOString(), 103) }));
    await expect(price).toHaveText("103.00");
    socket!.send(JSON.stringify({ type: "quote", quote: quote(new Date(sourceTime - 1000).toISOString(), 99) }));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(price).toHaveText("103.00");

    // Source age advances even while the connected feed has no new trade.
    const age = await panel.getByTestId("quote-age").textContent();
    await expect(panel.getByTestId("quote-age")).not.toHaveText(age!);
  });
}
