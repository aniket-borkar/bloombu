import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import type { Quote } from "../src/api";

const SECURITY = "AAPL US Equity";
const SOURCE_TIME = Date.parse("2026-10-26T14:30:00Z");
function quote(last: number, offset = 0): Quote {
  return {
    security: SECURITY, name: "Apple Inc.", last, change: last - 100, changePct: last - 100,
    bid: last - 0.01, ask: last + 0.01, bidSize: 1, askSize: 2,
    open: 100, high: 110, low: 90, prevClose: 100, volume: 1000,
    currency: "USD", exchange: "TEST", marketState: "REGULAR",
    time: new Date(SOURCE_TIME + offset).toISOString(), delayMinutes: 0, source: "Test source",
  };
}

async function fixture(page: Page, reply: (route: Route, count: number) => Promise<void>, initialPush?: Quote) {
  await page.clock.install();
  let requests = 0;
  let relay!: WebSocketRoute;
  await page.route("**/api/quote/AAPL*", (route) => reply(route, ++requests));
  await page.routeWebSocket("**/ws", (ws) => {
    relay = ws;
    ws.onMessage((raw) => {
      const msg = JSON.parse(String(raw));
      if (initialPush && msg.op === "sub" && msg.securities?.includes(SECURITY)) {
        ws.send(JSON.stringify({ type: "quote", quote: initialPush }));
      }
    });
    ws.send(JSON.stringify({ type: "stream.config", directKraken: false }));
  });
  await page.goto("/?popout=1&security=AAPL%20US%20Equity");
  const panel = page.getByTestId("panel-1");
  const price = panel.getByTestId("last-price");
  return {
    panel, price, requests: () => requests,
    push: (q: Quote) => relay.send(JSON.stringify({ type: "quote", quote: q })),
  };
}

test("an open but silent quote socket recovers through HTTP without disconnecting", async ({ page }) => {
  const f = await fixture(page, (route, count) => route.fulfill({ json: quote(99 + count, count * 1000) }), quote(100));
  await expect(f.price).toHaveText("100.00");
  await expect.poll(f.requests).toBe(1);
  await page.clock.fastForward(5000);
  expect(f.requests()).toBe(1);
  await page.clock.fastForward(5000);
  await expect(f.price).toHaveText("101.00");
  await expect.poll(f.requests).toBe(2);
  await expect(page.getByTestId("connection")).toHaveText("LIVE");
});

test("recent accepted quote messages suppress redundant HTTP checks", async ({ page }) => {
  const f = await fixture(page, (route) => route.fulfill({ json: quote(100) }), quote(100));
  await expect(f.price).toHaveText("100.00");
  await expect.poll(f.requests).toBe(1);
  for (let n = 1; n <= 5; n++) {
    f.push(quote(100 + n, n * 1000));
    await expect(f.price).toHaveText(`${100 + n}.00`);
    await page.clock.fastForward(4000);
  }
  expect(f.requests()).toBe(1);
});

test("safety polls retain the newer price across an old snapshot and a temporary missing quote", async ({ page }) => {
  const f = await fixture(page, (route, count) => {
    if (count === 2) return route.fulfill({ json: quote(99, -1000) });
    if (count === 3) return route.fulfill({ status: 404, json: { error: "UNKNOWN SECURITY" } });
    return route.fulfill({ json: quote(count >= 4 ? 102 : 101, count * 1000) });
  }, quote(101));
  await expect(f.price).toHaveText("101.00");
  await page.clock.fastForward(10_000);
  await expect.poll(f.requests).toBe(2);
  await expect(f.price).toHaveText("101.00");
  await page.clock.fastForward(5000);
  await expect.poll(f.requests).toBe(3);
  await expect(f.panel).toContainText("SHOWING LAST VALUE");
  await expect(f.panel.getByTestId("unknown-security")).toHaveCount(0);
  await expect(f.price).toHaveText("101.00");
  await page.clock.fastForward(5000);
  await expect(f.price).toHaveText("102.00");
  await expect(f.panel).not.toContainText("SHOWING LAST VALUE");
});

test("a hung safety request cannot overlap polls or prevent later recovery", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(page, async (route, count) => {
    if (count === 2) {
      await gate;
      await route.fulfill({ json: quote(101, 1000) }).catch(() => {});
      return;
    }
    await route.fulfill({ json: quote(count >= 3 ? 102 : 100, count * 1000) });
  }, quote(100));
  try {
    await expect(f.price).toHaveText("100.00");
    await page.clock.fastForward(10_000);
    await expect.poll(f.requests).toBe(2);
    await page.clock.fastForward(5000);
    expect(f.requests()).toBe(2);
    await page.clock.fastForward(5000);
    await expect(f.panel).toContainText("SHOWING LAST VALUE");
    await expect(f.price).toHaveText("100.00");
    await page.clock.fastForward(5000);
    await expect(f.price).toHaveText("102.00");
    await expect.poll(f.requests).toBe(3);
  } finally { release(); }
});
