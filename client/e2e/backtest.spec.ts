import { expect, test } from "@playwright/test";

test("BTST backtests a rule, reports errors, and saves strategies", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").fill(`bt${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  const panel = page.getByTestId("panel-1");
  await panel.locator(".panel-title").click();
  await page.getByTestId("cmd-1").pressSequentially("SPX INDEX BTST");
  await page.keyboard.press("Enter");

  await panel.getByRole("button", { name: "Golden Cross" }).click();
  await expect(panel.getByTestId("btst-entry")).toHaveValue("crossAbove(sma(close, 50), sma(close, 200))");
  await panel.getByTestId("btst-run").click();
  await expect(panel).toContainText("Strategy Return");
  await expect(panel.getByTestId("btst-chart").locator("canvas").first()).toBeVisible();
  await expect(panel.getByTestId("btst-trades").locator("tbody tr").first()).toBeVisible();

  await panel.getByTestId("btst-entry").fill("sma(close, 0) > 1");
  await panel.getByTestId("btst-run").click();
  await expect(panel.getByTestId("btst-error")).toContainText("Entry rule: sma: lookback must be a whole number");
  await expect(panel.getByTestId("btst-error")).toContainText("at character 12");

  await panel.getByTestId("btst-entry").fill("rsi(close, 14) < 35");
  await panel.getByPlaceholder("Save as...").fill("My RSI");
  await panel.getByPlaceholder("Save as...").press("Enter");
  await expect(panel.getByRole("button", { name: "★ My RSI" })).toBeVisible();
});
