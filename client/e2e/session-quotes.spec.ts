import { expect, test } from "@playwright/test";
import type { Quote } from "../src/api";

for (const session of ["pre", "post"] as const) {
  test(`shows the actual ${session}-market price and its regular-session references`, async ({ page }) => {
    const quote: Quote = {
      security: "AAPL US Equity", name: "Apple", last: session === "pre" ? 103 : 99,
      change: session === "pre" ? 3 : 1, changePct: session === "pre" ? 3 : 1.020408,
      bid: null, ask: null, bidSize: null, askSize: null, open: 99, high: 101, low: 97,
      prevClose: session === "pre" ? 100 : 98, regularClose: 100, volume: 1234, currency: "USD", exchange: "NASDAQ",
      marketState: session === "pre" ? "PRE" : "POST", priceSession: session,
      time: new Date(Date.now() - 1000).toISOString(), delayMinutes: 0, source: "Yahoo Finance",
    };
    await page.route("**/api/quote/AAPL*", (route) => route.fulfill({ json: quote }));
    await page.routeWebSocket("**/ws", () => {});
    await page.goto("/?popout=1&security=AAPL%20US%20Equity");
    const header = page.getByTestId("security-header");
    await expect(header.getByTestId("last-price")).toHaveText(session === "pre" ? "103.00" : "99.00");
    await expect(header.getByTestId("quote-session")).toHaveText(session === "pre" ? "Pre-market" : "After-hours");
    for (const label of ["Reg Vol", "Reg O", "Reg H", "Reg L"]) await expect(header.getByText(label, { exact: true })).toBeVisible();
    await expect(header.getByText("Reg close", { exact: true }).locator("..")).toContainText("100.00");
    await expect(header.getByText("Prev", { exact: true }).locator("..")).toContainText(session === "pre" ? "100.00" : "98.00");
  });
}
