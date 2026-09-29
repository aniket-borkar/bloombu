import { expect, test, type Page } from "@playwright/test";

async function run(page: Page, command: string) {
  const cmd = page.getByTestId("cmd-1");
  await cmd.fill("");
  await cmd.pressSequentially(command);
  await page.keyboard.press("Enter");
}

test("CF from the EDGAR example plugin renders as a native function", async ({ page, context }) => {
  await context.route("https://www.sec.gov/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>filing</h1>" }));
  await page.goto("/");
  await page.locator("#login").fill(`plug${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  const panel = page.getByTestId("panel-1");

  await run(page, "AAPL US EQUITY");
  await expect(panel.getByText("Page 1/2")).toBeVisible();
  await page.keyboard.press("PageDown");
  await expect(panel.locator(".menu-item", { hasText: "Company Filings" })).toBeVisible();

  await run(page, "CF");
  const screen = panel.getByTestId("plugin-screen");
  await expect(screen.locator(".menu-title")).toHaveText("Sample Registrant Inc.");
  await expect(screen.getByTestId("option-bar").locator(".chart-opt")).toHaveCount(7);
  await expect(screen.getByText("Recent Filings (36)")).toBeVisible();
  await expect(screen.locator(".kv-item", { hasText: "Fiscal Year End" })).toContainText("Sep 30");

  await run(page, "3");
  await expect(screen.getByText("Current Reports Filings (6)")).toBeVisible();
  const firstRow = screen.getByTestId("plugin-table").locator("tbody tr").first();
  await expect(firstRow).toContainText("8-K");
  await expect(firstRow).toContainText("Results of operations");

  const [popup] = await Promise.all([context.waitForEvent("page"), firstRow.click()]);
  await popup.waitForURL(/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/doc\d+\.htm/);

  await run(page, "SPX INDEX CF");
  await expect(panel.getByTestId("wrong-sector")).toHaveText("CF IS AVAILABLE FOR EQUITY SECURITIES ONLY");
});
