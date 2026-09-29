import { expect, test, type Page } from "@playwright/test";

async function run(page: Page, command: string) {
  const cmd = page.getByTestId("cmd-1");
  await cmd.fill("");
  await cmd.pressSequentially(command);
  await page.keyboard.press("Enter");
}

test("TRADE fills paper orders, works limits, cancels, and feeds PORT", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").fill(`trader${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  const panel = page.getByTestId("panel-1");
  await run(page, "AAPL US EQUITY");
  await run(page, "TRADE");
  await expect(panel.getByTestId("trade-security")).toHaveValue("AAPL US Equity");

  await panel.getByTestId("trade-qty").fill("50");
  await panel.getByTestId("trade-submit").click();
  await expect(panel.getByTestId("trade-message")).toContainText("Filled BUY 50 AAPL US Equity @");
  await expect(panel.getByTestId("trade-positions").locator("tbody tr")).toHaveCount(1);
  await expect(page.getByTestId("alert-toast")).toContainText("Filled: BUY 50 AAPL US Equity");

  await panel.getByTestId("trade-sell").click();
  await panel.getByTestId("trade-type").selectOption("limit");
  await panel.getByTestId("trade-price").fill("99999");
  await panel.getByTestId("trade-submit").click();
  await expect(panel.getByTestId("trade-message")).toContainText("working: limit sell 50");
  const open = panel.getByTestId("trade-orders").locator("tbody tr", { hasText: "OPEN" });
  await expect(open).toHaveCount(1);
  await open.getByTitle("Cancel order").click();
  await expect(panel.getByTestId("trade-orders").locator("tbody tr", { hasText: "CANCELLED" })).toHaveCount(1);

  await panel.getByRole("button", { name: "Analyze in PORT" }).click();
  await expect(panel.getByTestId("port-select")).toHaveValue(/\d+/);
  await expect(panel.getByTestId("port-select").locator("option:checked")).toContainText("Paper");
});
