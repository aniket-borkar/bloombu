import { expect, test, type Download, type Locator, type Page } from "@playwright/test";

type MenuName = "Actions" | "Output" | "Settings";

async function login(page: Page) {
  await page.goto("/");
  await page.locator("#login").fill(`menus${Date.now()}`);
  await page.getByRole("button", { name: "GO", exact: true }).click();
  await expect(page.getByTestId("panel-1")).toBeVisible();
}

async function openMenu(page: Page, id: number, name: MenuName) {
  await page.getByTestId(`panel-${id}`).getByRole("button", { name, exact: true }).click();
  const menu = page.getByRole("menu", { name: `${name} panel ${id}`, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function run(page: Page, id: number, command: string) {
  const panel = page.getByTestId(`panel-${id}`);
  await panel.locator(".panel-title").click();
  await panel.getByTestId(`cmd-${id}`).fill(command);
  await page.keyboard.press("Enter");
  return panel;
}

async function downloadText(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Download did not contain a file");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function expectInViewport(page: Page, locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
}

test.beforeEach(async ({ page }) => login(page));

test("Actions operates on its own panel and respects navigation history", async ({ page }) => {
  const panel = page.getByTestId("panel-2");
  let menu = await openMenu(page, 2, "Actions");
  await expect(panel).toHaveClass(/focused/);
  await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Forward", exact: true })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Help", exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(panel.getByTestId("help-screen")).toBeVisible();
  await expect(page.getByTestId("panel-1").getByTestId("security-menu")).toBeVisible();

  menu = await openMenu(page, 2, "Actions");
  await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
  await expect(panel.getByTestId("security-menu")).toBeVisible();
  menu = await openMenu(page, 2, "Actions");
  await menu.getByRole("menuitem", { name: "Forward", exact: true }).click();
  await expect(panel.getByTestId("help-screen")).toBeVisible();
  menu = await openMenu(page, 2, "Actions");
  await menu.getByRole("menuitem", { name: "Security menu", exact: true }).click();
  await expect(panel.getByTestId("security-menu")).toBeVisible();
  await expect(panel.locator(".cmdline-security")).toHaveText("AAPL US Equity");
});

test("menu keyboard navigation owns focus and Escape returns to its trigger", async ({ page }) => {
  const panel = page.getByTestId("panel-2");
  const trigger = panel.getByRole("button", { name: "Actions", exact: true });
  const menu = await openMenu(page, 2, "Actions");
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem", { name: "Security menu", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Help", exact: true })).toBeFocused();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Pop out", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Help", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(panel).toHaveClass(/focused/);
  await expect(panel.getByTestId("security-menu")).toBeVisible();

  await trigger.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(panel.getByTestId("help-screen")).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test("outside clicks and switching panels dismiss the previous menu", async ({ page }) => {
  const actions = await openMenu(page, 1, "Actions");
  await openMenu(page, 2, "Settings");
  await expect(actions).toHaveCount(0);
  await expect(page.getByRole("menu")).toHaveCount(1);
  await page.getByTestId("panel-3").locator(".panel-title").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("panel-3")).toHaveClass(/focused/);

  await openMenu(page, 3, "Output");
  await page.getByTestId("cmd-3").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("cmd-3")).toBeFocused();

  // Dismissing onto the same panel's noninteractive chrome must restore typing.
  await openMenu(page, 3, "Actions");
  await page.getByTestId("panel-3").locator(".panel-title").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(page.getByTestId("cmd-3")).toBeFocused();
  await page.keyboard.type("HELP");
  await expect(page.getByTestId("cmd-3")).toHaveValue("HELP");
});

test("Settings selects link groups, layouts, workspaces and data sources", async ({ page }) => {
  let menu = await openMenu(page, 2, "Settings");
  await expect(menu.getByRole("menuitemradio", { name: "4 panels", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(menu.getByRole("menuitemradio", { name: "No link group", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "Blue link group", exact: true }).click();
  await expect(page.getByTestId("link-2")).toHaveClass(/blue/);
  menu = await openMenu(page, 3, "Settings");
  await menu.getByRole("menuitemradio", { name: "Blue link group", exact: true }).click();
  await run(page, 2, "MSFT US EQUITY DES");
  await expect(page.getByTestId("panel-3").locator(".cmdline-security")).toHaveText("MSFT US Equity");
  menu = await openMenu(page, 2, "Settings");
  await expect(menu.getByRole("menuitemradio", { name: "Blue link group", exact: true })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemradio", { name: "No link group", exact: true }).click();
  await expect(page.getByTestId("link-2")).toHaveClass(/none/);

  menu = await openMenu(page, 2, "Settings");
  await menu.getByRole("menuitemradio", { name: "1 panel", exact: true }).click();
  await expect(page.locator("section.panel")).toHaveCount(1);
  await expect(page.getByRole("menu")).toHaveCount(0);
  menu = await openMenu(page, 1, "Settings");
  await menu.getByRole("menuitemradio", { name: "4 panels", exact: true }).click();
  await expect(page.locator("section.panel")).toHaveCount(4);
  menu = await openMenu(page, 1, "Settings");
  await menu.getByRole("menuitem", { name: "Saved workspaces", exact: true }).click();
  await expect(page.getByTestId("panel-1").getByTestId("layout-screen")).toBeVisible();
  menu = await openMenu(page, 1, "Settings");
  await menu.getByRole("menuitem", { name: "Data sources", exact: true }).click();
  await expect(page.getByTestId("panel-1").getByTestId("src-screen")).toBeVisible();
});

test("Output copies only the chosen screen and reports clipboard rejection", async ({ page }) => {
  const panel = await run(page, 2, "HELP");
  await expect(panel.getByTestId("help-screen")).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { (window as Window & { panelCopied?: string }).panelCopied = text; } },
    });
  });
  let menu = await openMenu(page, 2, "Output");
  await menu.getByRole("menuitem", { name: "Copy current screen", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/cop/i);
  const copied = await page.evaluate(() => (window as Window & { panelCopied?: string }).panelCopied);
  expect(copied).toContain("AAPL US Equity");
  expect(copied).toContain("Keyboard");
  expect(copied).not.toContain("CL1 Comdty");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new DOMException("Clipboard permission denied", "NotAllowedError"); } },
    });
  });
  menu = await openMenu(page, 2, "Output");
  await menu.getByRole("menuitem", { name: "Copy current screen", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(/copy|clipboard/i);
  await expect(panel.getByTestId("help-screen")).toBeVisible();
});

test("Output downloads current screen text with its panel and security", async ({ page }) => {
  await run(page, 2, "HELP");
  const menu = await openMenu(page, 2, "Output");
  const downloaded = page.waitForEvent("download");
  await menu.getByRole("menuitem", { name: "Download current screen (.txt)", exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.txt$/i);
  expect(download.suggestedFilename()).toMatch(/2/);
  expect(download.suggestedFilename()).toMatch(/AAPL/i);
  expect(download.suggestedFilename()).toMatch(/HELP/i);
  const text = await downloadText(download);
  expect(text).toContain("AAPL US Equity");
  expect(text).toContain("Keyboard");
  expect(text).not.toContain("CL1 Comdty");
  await expect(page.getByRole("menu")).toHaveCount(0);
});

test("Actions pops the selected panel out with its current security and function", async ({ page, context }) => {
  await run(page, 2, "HELP");
  const menu = await openMenu(page, 2, "Actions");
  const opened = context.waitForEvent("page");
  await menu.getByRole("menuitem", { name: "Pop out", exact: true }).click();
  const popup = await opened;
  await popup.waitForLoadState();
  await expect(popup.locator("section.panel")).toHaveCount(1);
  await expect(popup.getByTestId("panel-1").locator(".cmdline-security")).toHaveText("AAPL US Equity");
  await expect(popup.getByTestId("help-screen")).toBeVisible();
  await popup.close();
});

test("menus stay within the viewport for nine panels and narrow screens", async ({ page }) => {
  let menu = await openMenu(page, 1, "Settings");
  await menu.getByRole("menuitemradio", { name: "9 panels", exact: true }).click();
  await expect(page.locator("section.panel")).toHaveCount(9);
  for (const name of ["Settings", "Actions", "Output"] as const) {
    menu = await openMenu(page, 9, name);
    await expectInViewport(page, menu);
    if (name === "Actions") {
      await expect(menu.getByRole("menuitem", { name: "Security menu", exact: true })).toBeDisabled();
      await expect(menu.getByRole("menuitem", { name: "Back", exact: true })).toBeDisabled();
    }
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 390, height: 600 });
  await expect(page.getByTestId("panel-9")).toBeVisible();
  for (const name of ["Actions", "Output", "Settings"] as const) {
    menu = await openMenu(page, 9, name);
    await expectInViewport(page, menu);
    await page.keyboard.press("Escape");
  }
  menu = await openMenu(page, 9, "Settings");
  await menu.getByRole("menuitem", { name: "Data sources", exact: true }).click();
  await expect(page.getByTestId("panel-9").getByTestId("src-screen")).toBeVisible();
});
