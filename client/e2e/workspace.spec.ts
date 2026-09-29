import { expect, test, type Page } from "@playwright/test";

async function run(page: Page, panelId: number, command: string) {
  const panel = page.getByTestId(`panel-${panelId}`);
  await panel.locator(".panel-title").click();
  const cmd = page.getByTestId(`cmd-${panelId}`);
  await cmd.fill("");
  await cmd.pressSequentially(command);
  await page.keyboard.press("Enter");
  return panel;
}

test("layouts, linked panels, palette, saved workspaces and pop-outs", async ({ page, context }) => {
  const user = `ws${Date.now()}`;
  await page.goto("/");
  await page.locator("#login").fill(user);
  await page.getByRole("button", { name: "GO" }).click();

  const layout = await run(page, 1, "LAYOUT");
  await run(page, 1, "5");
  await expect(page.locator("section.panel")).toHaveCount(9);
  await expect(layout.getByTestId("layout-options").getByTestId("opt-5")).toHaveClass(/active/);

  await run(page, 7, "AAPL US EQUITY DES");
  await run(page, 8, "AAPL US EQUITY GP");
  await page.getByTestId("link-7").click();
  await page.getByTestId("link-8").click();
  await expect(page.getByTestId("link-7")).toHaveClass(/amber/);
  await run(page, 7, "MSFT US EQUITY DES");
  await expect(page.getByTestId("panel-8").locator(".cmdline-security")).toHaveText("MSFT US Equity");
  await expect(page.getByTestId("panel-8").getByTestId("price-chart")).toBeVisible();

  // Command palette: jump panel 9 to a function by fuzzy search.
  await page.getByTestId("panel-9").locator(".panel-title").click();
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByTestId("palette-input").fill("world equity");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("panel-9").getByTestId("wei-screen")).toBeVisible();

  // Save the workspace, switch layout, then restore it.
  await layout.getByTestId("ws-name").fill("Nine");
  await layout.getByTestId("ws-name").press("Enter");
  await expect(layout.getByTestId("ws-open")).toHaveText("Nine");
  await run(page, 1, "1");
  await expect(page.locator("section.panel")).toHaveCount(1);
  await page.getByTestId("panel-1").getByTestId("ws-open").click();
  await expect(page.locator("section.panel")).toHaveCount(9);
  await expect(page.getByTestId("panel-8").locator(".cmdline-security")).toHaveText("MSFT US Equity");
  await expect(page.getByTestId("link-8")).toHaveClass(/amber/);

  // Pop a panel out into its own window.
  const [popup] = await Promise.all([context.waitForEvent("page"), page.getByTestId("panel-8").locator(".popout").click()]);
  await popup.waitForLoadState();
  await expect(popup.locator("section.panel")).toHaveCount(1);
  await expect(popup.getByTestId("panel-1").locator(".cmdline-security")).toHaveText("MSFT US Equity");
  await expect(popup.getByTestId("panel-1").getByTestId("price-chart")).toBeVisible();
});
