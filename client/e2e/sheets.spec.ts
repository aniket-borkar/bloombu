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

  // Spill rows extend beyond the raw formula grid and must all copy to Excel.
  await cell(grid, 6, 0).click();
  await cell(grid, 9, 1).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+C");
  const lines = (await page.evaluate(() => navigator.clipboard.readText())).split("\n");
  expect(lines).toHaveLength(4);
  for (const line of lines) expect(line).toMatch(/^\d{4}-\d{2}-\d{2}\t[\d.]+$/);
});

test("SHEET saves pending edits when changing sheets or leaving the screen", async ({ page }) => {
  const user = `flush${Date.now()}`.toUpperCase();
  await login(page, user);
  for (const name of ["First", "Second"]) {
    await page.request.put(`/api/docs/sheet/${name}`, { data: { user, data: { cells: [[name]] } } });
  }
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await expect(cell(grid, 0, 0)).toHaveText("First");
  await cell(grid, 0, 0).dblclick();
  await panel.getByTestId("grid-input").fill("Before navigation");
  await page.keyboard.press("Enter");
  await panel.getByTestId("cmd-1").fill("HELP");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await (await page.request.get(`/api/docs/sheet/First?user=${user}`)).json()).cells[0][0]).toBe("Before navigation");

  await run(page, 1, "SHEET");
  await expect(cell(grid, 0, 0)).toHaveText("Before navigation");
  await cell(grid, 0, 0).dblclick();
  await panel.getByTestId("grid-input").fill("Before switching");
  await page.keyboard.press("Enter");
  await panel.getByRole("button", { name: /\d\) Second$/ }).click();
  await expect(cell(grid, 0, 0)).toHaveText("Second");
  await expect.poll(async () => (await (await page.request.get(`/api/docs/sheet/First?user=${user}`)).json()).cells[0][0]).toBe("Before switching");
});

test("SHEET ignores a late load for a previously selected sheet", async ({ page }) => {
  const user = `race${Date.now()}`.toUpperCase();
  await login(page, user);
  for (const name of ["A", "B", "C"]) {
    await page.request.put(`/api/docs/sheet/${name}`, { data: { user, data: { cells: [[name]] } } });
  }
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await expect(cell(grid, 0, 0)).toHaveText("A");
  let release!: () => void;
  let requested!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/docs/sheet/B?**", async (route) => {
    const response = await route.fetch();
    requested();
    await blocked;
    await route.fulfill({ response }).catch(() => {}); // Selecting C can abort B.
  });
  await panel.getByRole("button", { name: /\d\) B$/ }).click();
  await started;
  await panel.getByRole("button", { name: /\d\) C$/ }).click();
  await expect(cell(grid, 0, 0)).toHaveText("C");
  release();
  await expect(panel.getByTestId("sheet-status")).toHaveText("Opened C");
  await cell(grid, 0, 0).dblclick();
  await panel.getByTestId("grid-input").fill("C edited");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("sheet-status")).toHaveText("Saved C");
  expect((await (await page.request.get(`/api/docs/sheet/C?user=${user}`)).json()).cells[0][0]).toBe("C edited");
});

test("SHEET retains a failed save and retries it before switching sheets", async ({ page }) => {
  const user = `retry${Date.now()}`.toUpperCase();
  await login(page, user);
  for (const name of ["First", "Second"]) {
    await page.request.put(`/api/docs/sheet/${name}`, { data: { user, data: { cells: [[name]] } } });
  }
  let failWrites = true;
  await page.route("**/api/docs/sheet/First", async (route) => {
    if (route.request().method() === "PUT" && failWrites) {
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Save temporarily unavailable" }) });
    } else await route.continue();
  });
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await expect(cell(grid, 0, 0)).toHaveText("First");
  await cell(grid, 0, 0).dblclick();
  await panel.getByTestId("grid-input").fill("Keep this draft");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("sheet-status")).toContainText("Save failed");
  await panel.getByRole("button", { name: /\d\) Second$/ }).click();
  await expect(panel.getByTestId("sheet-status")).toContainText("Save failed");
  await expect(cell(grid, 0, 0)).toHaveText("Keep this draft");
  await expect(panel.getByRole("button", { name: /\d\) First$/ })).toHaveClass(/active/);

  failWrites = false;
  await panel.getByRole("button", { name: /\d\) Second$/ }).click();
  await expect(cell(grid, 0, 0)).toHaveText("Second");
  expect((await (await page.request.get(`/api/docs/sheet/First?user=${user}`)).json()).cells[0][0]).toBe("Keep this draft");
});

test("SHEET blocks edits during deletion so a pending save cannot recreate it", async ({ page }) => {
  const user = `delete${Date.now()}`.toUpperCase();
  await login(page, user);
  await page.request.put("/api/docs/sheet/Delete", { data: { user, data: { cells: [["original"]] } } });
  const panel = await run(page, 1, "SHEET");
  const grid = panel.getByTestId("sheet-grid");
  await expect(cell(grid, 0, 0)).toHaveText("original");
  let release!: () => void;
  let requested!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route("**/api/docs/sheet/Delete", async (route) => {
    if (route.request().method() === "PUT") {
      requested();
      await blocked;
    }
    await route.continue();
  });
  await cell(grid, 0, 0).dblclick();
  await panel.getByTestId("grid-input").fill("pending");
  await page.keyboard.press("Enter");
  const remove = panel.getByRole("button", { name: "Delete", exact: true });
  await remove.click();
  await remove.click();
  await started;
  await expect(remove).toBeDisabled();
  await cell(grid, 0, 0).dblclick();
  await expect(panel.getByTestId("grid-input")).toHaveCount(0);
  const deleted = page.waitForResponse((res) => res.request().method() === "DELETE" && res.url().includes("/api/docs/sheet/Delete"));
  release();
  await deleted;
  await expect(remove).toBeDisabled();
  // Cover the debounce interval after DELETE, when the old race issued a new PUT.
  await page.waitForTimeout(900);
  expect((await page.request.get(`/api/docs/sheet/Delete?user=${user}`)).status()).toBe(404);
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
