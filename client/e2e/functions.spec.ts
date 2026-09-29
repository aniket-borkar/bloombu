import { expect, test, type Page } from "@playwright/test";
import { FUNCTION_LIST } from "../src/terminal/functions";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").fill("tester");
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("panel-1")).toBeVisible();
});

async function run(page: Page, panelId: number, command: string) {
  const panel = page.getByTestId(`panel-${panelId}`);
  await panel.locator(".panel-title").click();
  const cmd = page.getByTestId(`cmd-${panelId}`);
  await cmd.fill("");
  await cmd.pressSequentially(command);
  await page.keyboard.press("Enter");
  return panel;
}

const SECURITY_FUNCTIONS: [string, string, string][] = [
  ["AAPL US EQUITY", "DES", "des-screen"],
  ["AAPL US EQUITY", "GP", "price-chart"],
  ["AAPL US EQUITY", "GIP", "price-chart"],
  ["AAPL US EQUITY", "BTST", "btst-screen"],
  ["SPX INDEX", "BTST", "btst-screen"],
  ["AAPL US EQUITY", "CF", "plugin-screen"],
  ["AAPL US EQUITY", "MGMT", "data-table"],
  ["AAPL US EQUITY", "BQ", "bq-screen"],
  ["AAPL US EQUITY", "HP", "hp-screen"],
  ["AAPL US EQUITY", "GPO", "price-chart"],
  ["AAPL US EQUITY", "CN", "news-screen"],
  ["AAPL US EQUITY", "FA", "fa-screen"],
  ["AAPL US EQUITY", "EE", "ee-screen"],
  ["AAPL US EQUITY", "ERN", "ern-screen"],
  ["AAPL US EQUITY", "ANR", "anr-screen"],
  ["AAPL US EQUITY", "HDS", "hds-screen"],
  ["AAPL US EQUITY", "DVD", "dvd-screen"],
  ["AAPL US EQUITY", "RV", "rv-screen"],
  ["AAPL US EQUITY", "OMON", "omon-screen"],
  ["AAPL US EQUITY", "RELS", "rels-screen"],
  ["AAPL US EQUITY", "BETA", "beta-screen"],
  ["AAPL US EQUITY", "TRA", "tra-screen"],
  ["AAPL US EQUITY", "OVML", "ovml-output"],
  ["AAPL US EQUITY", "SPLC", "unavailable"],
  ["AAPL US EQUITY", "QR", "qr-trades"],
  ["XBTUSD CURNCY", "QR", "qr-trades"],
  ["SPX INDEX", "DES", "des-screen"],
  ["SPX INDEX", "MEMB", "memb-table"],
  ["INDU INDEX", "MEMB", "memb-table"],
  ["EURUSD CURNCY", "FRD", "frd-table"],
  ["EURUSD CURNCY", "OVML", "ovml-output"],
  ["CL1 COMDTY", "CT", "ct-screen"],
  ["CT10 GOVT", "YAS", "yas-scenarios"],
];

for (const [security, fn, testId] of SECURITY_FUNCTIONS) {
  test(`${security} ${fn} renders`, async ({ page }) => {
    const panel = await run(page, 1, `${security} ${fn}`);
    await expect(panel.getByTestId(testId).first()).toBeVisible();
    await expect(panel.getByTestId("screen-error")).toHaveCount(0);
    await expect(panel.getByTestId("unknown-security")).toHaveCount(0);
  });
}

const MARKET_FUNCTIONS: [string, string][] = [
  ["WEI", "wei-screen"],
  ["W", "wei-screen"],
  ["WB", "wb-screen"],
  ["WCRS", "wcrs-screen"],
  ["FXC", "fxc-screen"],
  ["GC", "curve-chart"],
  ["BTMM", "btmm-screen"],
  ["GLCO", "glco-screen"],
  ["TOP", "headlines"],
  ["N", "headlines"],
  ["MOST", "most-screen"],
  ["IMAP", "imap-screen"],
  ["ECO", "eco-screen"],
  ["ECST", "ecst-screen"],
  ["EQS", "eqs-screen"],
  ["WIRP", "wirp-meetings"],
  ["TRADE", "trade-screen"],
  ["SRC", "src-providers"],
  ["BRIEF", "brief-markets"],
  ["MSG", "msg-screen"],
  ["IB", "ib-screen"],
  ["BLP", "blp-screen"],
  ["PORT", "port-screen"],
  ["PRTU", "prtu-screen"],
  ["FLDS", "flds-screen"],
  ["SHEET", "sheet-screen"],
  ["BQL", "bql-screen"],
  ["ASK", "ask-screen"],
  ["ALRT", "alrt-screen"],
  ["LAYOUT", "layout-screen"],
  ["HELP", "help-screen"],
];

for (const [fn, testId] of MARKET_FUNCTIONS) {
  test(`${fn} renders`, async ({ page }) => {
    const panel = await run(page, 2, fn);
    await expect(panel.getByTestId(testId).first()).toBeVisible();
    await expect(panel.getByTestId("screen-error")).toHaveCount(0);
  });
}

test("every function in the terminal has a render check", () => {
  const covered = new Set([...SECURITY_FUNCTIONS.map(([, fn]) => fn), ...MARKET_FUNCTIONS.map(([fn]) => fn)]);
  expect(FUNCTION_LIST.map((f) => f.code).filter((code) => !covered.has(code))).toEqual([]);
});

test("non-equity gets a clear message for equity-only functions", async ({ page }) => {
  const panel = await run(page, 1, "SPX INDEX FA");
  await expect(panel.getByTestId("wrong-sector")).toContainText("FA IS AVAILABLE FOR EQUITY SECURITIES ONLY");
});

test("numbered options switch views (FA balance sheet, MOST gainers)", async ({ page }) => {
  let panel = await run(page, 1, "AAPL US EQUITY FA");
  await expect(panel.getByTestId("fa-screen")).toContainText("Revenue");
  await run(page, 1, "2");
  await expect(panel.getByTestId("fa-screen")).toContainText("Total Assets");
  await expect(panel.getByTestId("opt-2")).toHaveClass(/active/);

  panel = await run(page, 2, "MOST");
  await run(page, 2, "2");
  await expect(panel.getByTestId("opt-2")).toHaveClass(/active/);
  await expect(panel.getByTestId("data-table")).toBeVisible();
});

test("OVML recalculates as inputs change and Esc returns to the command line", async ({ page }) => {
  const panel = await run(page, 1, "AAPL US EQUITY OVML");
  const output = panel.getByTestId("ovml-output");
  await expect(output).toBeVisible();
  await expect(panel.getByTestId("ovml-rate")).toHaveValue("4.240");
  await expect(panel.getByTestId("ovml-vol")).not.toHaveValue("25.00");
  const before = await output.locator("tbody tr").first().textContent();
  const vol = panel.getByTestId("ovml-vol");
  await vol.fill("80");
  await expect(output.locator("tbody tr").first()).not.toHaveText(before!);
  await expect(vol).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("cmd-1")).toBeFocused();
});

test("IB delivers a message to another panel in the same room", async ({ page }) => {
  const p1 = await run(page, 1, "IB");
  const p2 = await run(page, 2, "IB");
  await expect(p1.getByTestId("chat-input")).toBeEnabled();
  await expect(p2.getByTestId("chat-input")).toBeEnabled();
  const text = `hello from e2e ${Date.now()}`;
  await p1.getByTestId("chat-input").fill(text);
  await p1.getByTestId("chat-input").press("Enter");
  await expect(p1.getByTestId("chat-log")).toContainText(text);
  await expect(p2.getByTestId("chat-log")).toContainText(text);
  await expect(p2.getByTestId("chat-log")).toContainText("TESTER");
});

test("BLP adds a security to the monitor", async ({ page }) => {
  await page.evaluate(() => localStorage.removeItem("blmbu.monitor"));
  const panel = await run(page, 1, "BLP");
  await expect(panel.getByTestId("data-table")).toContainText("SPX");
  await panel.getByTestId("blp-add").fill("NVDA US <EQUITY>");
  await panel.getByTestId("blp-add").press("Enter");
  await expect(panel.getByTestId("data-table")).toContainText("NVDA US");
});

test("CT loads a specific contract", async ({ page }) => {
  const panel = await run(page, 1, "CL1 COMDTY CT");
  const first = panel.getByTestId("data-table").locator("tbody tr").first();
  const contract = (await first.locator("td").first().textContent())!.trim();
  await first.click();
  await expect(panel.locator(".cmdline-security")).toHaveText(contract);
  await expect(panel.getByTestId("last-price")).toBeVisible();
});
