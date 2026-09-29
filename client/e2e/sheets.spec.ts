import { expect, test, type Page } from "@playwright/test";

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function login(page: Page, user: string) {
  await page.goto("/");
  await page.locator("#login").fill(user);
  await page.getByRole("button", { name: "GO" }).click();
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

test("SHEET evaluates live BDP formulas, edits, saves and pastes", async ({ page }) => {
  await login(page, `sheet${Date.now()}`);
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await expect(cell(grid, 1, 0)).toHaveText("AAPL US Equity");
  await expect(cell(grid, 1, 1)).toHaveText(/^\d{1,3}(,\d{3})*\.\d{2}$/);
  await expect(cell(grid, 1, 3)).toHaveText(/^\d+\.\d{2}$/);
  await expect(cell(grid, 4, 6)).toHaveText(/^-?\d+\.\d{2}$/);

  await cell(grid, 6, 0).click();
  await page.keyboard.type("=B2*2");
  await page.keyboard.press("Enter");
  const b2 = Number((await cell(grid, 1, 1).textContent())!.replace(/,/g, ""));
  const a7 = Number((await cell(grid, 6, 0).textContent())!.replace(/,/g, ""));
  expect(Math.abs(a7 - 2 * b2)).toBeLessThan(2 * b2 * 0.01);
  await cell(grid, 6, 0).click();
  await expect(panel.getByTestId("formula-bar")).toContainText("=B2*2");

  await panel.getByTestId("sheet-new").fill("E2E Sheet");
  await panel.getByTestId("sheet-new").press("Enter");
  await expect(panel.getByRole("button", { name: /E2E Sheet/ })).toBeVisible();

  await cell(grid, 8, 0).click();
  await page.evaluate(() => navigator.clipboard.writeText("10\t20\n30\t=A9+B9+A10\n"));
  await page.keyboard.press("ControlOrMeta+V");
  await expect(cell(grid, 9, 1)).toHaveText("60");
  await expect(panel.getByTestId("sheet-status")).toContainText("Saved E2E Sheet");

  await cell(grid, 8, 0).click();
  await cell(grid, 9, 1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("10\t20\n30\t60");

  // Reopen: the sheet persists on the server.
  await run(page, 2, "SHEET");
  await expect(cell(page.getByTestId("panel-2").getByTestId("sheet-grid"), 9, 1)).toHaveText("60");
});

test("SHEET spills BDH history", async ({ page }) => {
  await login(page, `bdh${Date.now()}`);
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await cell(grid, 6, 0).click();
  await page.keyboard.type('=BDH("SPX Index","PX_LAST","1mo")');
  await page.keyboard.press("Enter");
  await expect(cell(grid, 6, 0)).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  await expect(cell(grid, 7, 1)).toHaveText(/^\d/);
});

test("BQL runs queries, reports errors with position, and copies results", async ({ page }) => {
  await login(page, `bql${Date.now()}`);
  const panel = await run(page, 1, "BQL");
  await panel.getByTestId("bql-input").fill("SELECT NAME, PX_LAST, CHG_PCT_1D FROM wei() ORDER BY CHG_PCT_1D DESC LIMIT 5");
  await panel.getByTestId("bql-run").click();
  const grid = panel.getByTestId("bql-grid");
  await expect(grid.locator("tbody tr")).toHaveCount(5);
  await expect(cell(grid, 0, 0)).toHaveText(/ Index$/);

  await cell(grid, 0, 0).click();
  await cell(grid, 1, 3).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+C");
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0].split("\t")).toHaveLength(4);
  expect(Number(lines[0].split("\t")[3])).toBeGreaterThanOrEqual(Number(lines[1].split("\t")[3]));

  await panel.getByTestId("bql-input").fill("SELECT NAME, BOGUS FROM wei()");
  await panel.getByTestId("bql-input").press("ControlOrMeta+Enter");
  await expect(panel.getByTestId("bql-error")).toContainText("Unknown field BOGUS");
  await expect(panel.getByTestId("bql-error")).toContainText("at character 14");
});
