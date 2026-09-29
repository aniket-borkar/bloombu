import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("panel-1")).toBeVisible();
});

test("loads AAPL US <EQUITY> <GO> and renders a price", async ({ page }) => {
  const cmd = page.getByTestId("cmd-1");
  await cmd.pressSequentially("aapl us");
  await page.keyboard.press("F8");
  await expect(cmd).toHaveValue("AAPL US <EQUITY> ");
  await page.keyboard.press("Enter");

  const panel = page.getByTestId("panel-1");
  await expect(panel.locator(".cmdline-security")).toHaveText("AAPL US Equity");
  await expect(panel.getByTestId("last-price")).toHaveText(/^\d[\d,]*\.\d{2}$/);
  await expect(panel.getByTestId("security-menu")).toContainText("DES");
});

test("menu item, MENU back, HELP and panel cycling", async ({ page }) => {
  const panel = page.getByTestId("panel-1");
  await expect(panel.getByTestId("security-menu")).toBeVisible();

  await page.getByTestId("cmd-1").pressSequentially("1");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("des-screen")).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(panel.getByTestId("security-menu")).toBeVisible();

  await page.keyboard.press("F1");
  await expect(panel.getByTestId("help-screen")).toBeVisible();

  await page.keyboard.press("Tab");
  await expect(page.getByTestId("panel-2")).toHaveClass(/focused/);
  await expect(page.getByTestId("cmd-2")).toBeFocused();
});

test("GP draws a price graph and switches ranges", async ({ page }) => {
  const panel = page.getByTestId("panel-2");
  await panel.locator(".panel-title").click();
  await page.getByTestId("cmd-2").pressSequentially("2");
  await page.keyboard.press("Enter");

  await expect(panel.getByTestId("chart-screen")).toBeVisible();
  await expect(panel.getByTestId("chart-opt-1Y")).toHaveClass(/active/);
  const chart = panel.getByTestId("price-chart");
  await expect(chart.locator("canvas").first()).toBeVisible();
  await expect(panel.getByTestId("chart-stats")).toContainText("1Y Chg");

  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(panel.getByTestId("chart-hover")).toContainText(/\d\d\/\d\d\/\d\d/);
  await page.mouse.move(0, 0);

  await page.getByTestId("cmd-2").pressSequentially("1");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("chart-opt-1D")).toHaveClass(/active/);
  await expect(panel.getByTestId("chart-stats")).toContainText("1D Chg");
  await expect(panel.getByTestId("last-price")).toBeVisible();
  await page.screenshot({ path: "test-results/gp.png" });

  await page.keyboard.press("Backspace");
  await expect(panel.getByTestId("security-menu")).toBeVisible();
});

test("reports an unknown security", async ({ page }) => {
  await page.getByTestId("cmd-1").pressSequentially("ZZZZQX US EQUITY");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("panel-1").getByTestId("unknown-security")).toBeVisible();
});

test("autocomplete finds securities by name", async ({ page }) => {
  await page.getByTestId("cmd-1").pressSequentially("microsoft");
  const ac = page.getByTestId("autocomplete");
  await expect(ac).toContainText("MSFT US Equity");
  await ac.getByText("MSFT US Equity").click();
  await expect(page.getByTestId("panel-1").locator(".cmdline-security")).toHaveText("MSFT US Equity");
});

test("streams price updates over the WebSocket without polling", async ({ page }) => {
  const quoteRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/quote/")) quoteRequests.push(r.url());
  });

  await expect(page.getByTestId("connection")).toHaveText("LIVE");
  const price = page.getByTestId("panel-1").getByTestId("last-price");
  await expect(price).toBeVisible();
  const before = await price.textContent();
  const restCallsBefore = quoteRequests.length;

  await expect(price).not.toHaveText(before!, { timeout: 15_000 });
  expect(quoteRequests.length).toBe(restCallsBefore);
});

test("screenshot", async ({ page }) => {
  await expect(page.getByTestId("panel-4").getByTestId("last-price")).toBeVisible();
  await expect(page.locator(".tape-item").first()).toBeVisible();
  await page.screenshot({ path: "test-results/terminal.png" });
});
