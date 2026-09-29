import { expect, test } from "@playwright/test";

test("ALRT fires server-side and shows a status-bar toast", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").fill(`alrt${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  const panel = page.getByTestId("panel-2");
  await panel.locator(".panel-title").click();
  await page.getByTestId("cmd-2").pressSequentially("AAPL US EQUITY ALRT");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("alrt-security")).toHaveValue("AAPL US Equity");

  await panel.getByTestId("alrt-value").fill("1");
  await panel.getByTestId("alrt-create").click();
  await expect(panel.getByTestId("alrt-message")).toContainText("Alert set: Price at or above 1.00 on AAPL US Equity");

  const toast = page.getByTestId("alert-toast");
  await expect(toast).toContainText("AAPL US Equity price at or above 1", { timeout: 15_000 });
  await expect(panel.getByTestId("alrt-triggered")).toContainText("AAPL US Equity");
  await toast.click();
  await expect(toast).toHaveCount(0);

  await panel.getByTestId("alrt-kind").selectOption("rule");
  await panel.getByTestId("alrt-expr").fill("sma(close)");
  await panel.getByTestId("alrt-create").click();
  await expect(panel.getByTestId("alrt-message")).toContainText("Rule: sma takes 2 arguments");
});
