import { expect, test, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function login(page: Page, user: string) {
  await page.goto("/");
  await page.locator("#login").fill(user);
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("panel-1")).toBeVisible();
}

async function run(page: Page, panelId: number, command: string) {
  const panel = page.getByTestId(`panel-${panelId}`);
  await panel.locator(".panel-title").click();
  const cmd = page.getByTestId(`cmd-${panelId}`);
  await cmd.fill("");
  await cmd.pressSequentially(command);
  await page.keyboard.press("Enter");
  return panel;
}

const cell = (grid: ReturnType<Page["getByTestId"]>, row: number, col: number) => grid.locator(`td[data-cell="${row}:${col}"]`);

test("paste holdings from Excel into PRTU, save, and analyze in PORT", async ({ page }) => {
  const user = `port${Date.now()}`;
  await login(page, user);
  const panel = await run(page, 1, "PRTU");
  const grid = panel.getByTestId("prtu-grid");
  await expect(grid).toBeVisible();

  await cell(grid, 0, 0).click();
  await page.evaluate(() =>
    navigator.clipboard.writeText("Symbol\tQuantity\tAvg Cost\tDate\nAAPL\t100\t150\t1/2/2024\nmicrosoft\t50\t300\t\nVOD.L\t1000\t80\t\n"),
  );
  await page.keyboard.press("ControlOrMeta+V");
  await expect(panel.getByTestId("prtu-info")).toContainText("Pasted 3 rows");
  await expect(cell(grid, 0, 4)).toHaveText("AAPL US Equity");
  await expect(cell(grid, 1, 4)).toHaveText("MSFT US Equity");
  await expect(cell(grid, 2, 4)).toHaveText("VOD LN Equity");
  await expect(cell(grid, 0, 3)).toHaveText("1/2/2024");

  // Type a fourth row directly into the grid.
  await cell(grid, 3, 0).click();
  await page.keyboard.type("IBM");
  await page.keyboard.press("Tab");
  await page.keyboard.type("25");
  await page.keyboard.press("Enter");
  await expect(cell(grid, 3, 4)).toHaveText("IBM US Equity");

  await panel.getByTestId("prtu-name").fill("E2E Global");
  await panel.getByTestId("prtu-save").click();
  await expect(panel.getByTestId("prtu-info")).toContainText('Saved "E2E Global" with 4 holdings');

  await panel.getByRole("button", { name: "Analyze in PORT" }).click();
  const holdings = panel.getByTestId("port-holdings");
  await expect(holdings).toContainText("AAPL US Equity");
  await expect(holdings).toContainText("TOTAL");
  await expect(holdings).toContainText("GBP (minor)");

  // Copy two rows of the holdings table as TSV for Excel.
  await cell(holdings, 0, 0).click();
  await cell(holdings, 1, 5).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+C");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const lines = copied.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0].split("\t")[0]).toBe("AAPL US Equity");
  expect(lines[0].split("\t")).toHaveLength(6);
  expect(Number(lines[0].split("\t")[5])).toBeGreaterThan(0);

  await page.keyboard.press("Escape");
  await run(page, 1, "2");
  await expect(panel.getByTestId("port-chart").locator("canvas").first()).toBeVisible();
  await run(page, 1, "3");
  await expect(panel.getByTestId("port-risk")).toBeVisible();
  await expect(panel).toContainText("Volatility (ann.)");
  await run(page, 1, "4");
  await expect(panel.getByTestId("exp-country")).toContainText("United Kingdom");
  await run(page, 1, "5");
  await expect(panel.getByTestId("port-attrib")).toContainText("IBM US Equity");
  await run(page, 1, "6");
  const whatIf = panel.getByTestId("whatif-grid");
  await expect(cell(whatIf, 0, 0)).toHaveText("AAPL US Equity");
  await cell(whatIf, 0, 1).dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("500");
  await page.keyboard.press("Enter");
  await panel.getByTestId("whatif-run").click();
  await expect(panel.getByTestId("whatif-result")).toContainText("Volatility %");
  await expect(panel.getByTestId("whatif-result")).toContainText("Sector:");
});

test("weights-only paste creates a model portfolio", async ({ page }) => {
  await login(page, `model${Date.now()}`);
  const panel = await run(page, 1, "PRTU");
  const grid = panel.getByTestId("prtu-grid");
  await cell(grid, 0, 0).click();
  await page.evaluate(() => navigator.clipboard.writeText("Ticker,Weight %\nSPX Index,60\nEURUSD Curncy,40\n"));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(panel.getByTestId("prtu-info")).toContainText("switched to a model portfolio");
  await expect(cell(grid, 1, 2)).toHaveText("EURUSD Curncy");
  await expect(cell(grid, 0, 6)).toHaveText("600,000");
  await panel.getByTestId("prtu-name").fill("Sixty Forty");
  await panel.getByTestId("prtu-save").click();
  await expect(panel.getByTestId("prtu-info")).toContainText("Saved");
});

test("unknown tickers are flagged with suggestions and block saving", async ({ page }) => {
  await login(page, `bad${Date.now()}`);
  const panel = await run(page, 1, "PRTU");
  const grid = panel.getByTestId("prtu-grid");
  await cell(grid, 0, 0).click();
  await page.keyboard.type("ZZZZQX");
  await page.keyboard.press("Tab");
  await page.keyboard.type("10");
  await page.keyboard.press("Enter");
  await expect(cell(grid, 0, 4)).toHaveText("NOT FOUND");
  await expect(cell(grid, 0, 0)).toHaveClass(/invalid/);
  await panel.getByTestId("prtu-save").click();
  await expect(panel.getByTestId("prtu-error")).toContainText('could not identify "ZZZZQX"');
});
