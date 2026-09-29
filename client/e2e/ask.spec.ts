import { expect, test } from "@playwright/test";

test("? on the command line asks the AI analyst, which opens functions and drafts portfolios", async ({ page }) => {
  await page.goto("/");
  await page.locator("#login").fill(`ai${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();

  const p1 = page.getByTestId("panel-1");
  await p1.locator(".panel-title").click();
  await page.getByTestId("cmd-1").pressSequentially("? compare AAPL and MSFT on a chart");
  await expect(page.getByTestId("cmd-1")).toHaveValue("? compare AAPL and MSFT on a chart");
  await page.keyboard.press("Enter");

  const log = p1.getByTestId("ask-log");
  await expect(log).toContainText("compare AAPL and MSFT on a chart");
  await expect(p1.getByTestId("ask-tool").first()).toContainText("Fetched PX_LAST");
  await expect(log).toContainText("Mock analyst summary");
  await expect(p1.getByTestId("ask-action")).toContainText("Open AAPL US Equity GP");

  const p2 = page.getByTestId("panel-2");
  await expect(p2.locator(".cmdline-security")).toHaveText("AAPL US Equity");
  await expect(p2.getByTestId("price-chart").locator("canvas").first()).toBeVisible();

  await p1.getByTestId("ask-input").fill("draft a portfolio of AAPL and NVDA");
  await p1.getByTestId("ask-input").press("Enter");
  const review = p1.getByTestId("ask-action").filter({ hasText: "Review draft" });
  await expect(review).toBeVisible();
  await review.click();
  const grid = p2.getByTestId("prtu-grid");
  await expect(grid.locator('td[data-cell="0:0"]')).toHaveText("AAPL US Equity");
  await expect(grid.locator('td[data-cell="1:0"]')).toHaveText("NVDA US Equity");
  await expect(grid.locator('td[data-cell="0:1"]')).toHaveText("50");
  await expect(p2.getByTestId("prtu-name")).toHaveValue("AI Draft");
});

async function signIn(page: import("@playwright/test").Page, name: string) {
  await page.goto("/");
  await page.locator("#login").fill(`${name}${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  await page.getByTestId("panel-1").locator(".panel-title").click();
}

test("?? runs deep research that backtests a rule, shows sources and a table, and opens the strategy in BTST", async ({ page }) => {
  await signIn(page, "deep");
  const p1 = page.getByTestId("panel-1");
  await page.getByTestId("cmd-1").pressSequentially("?? backtest a trend rule on AAPL");
  await page.keyboard.press("Enter");

  await expect(p1.getByTestId("ask-log")).toContainText("[DEEP]");
  await expect(p1.getByTestId("ask-deep")).toHaveAttribute("aria-pressed", "true");
  await expect(p1.getByTestId("ask-tool").first()).toContainText("Backtested a long rule on AAPL US Equity (2y)");
  await expect(p1.getByTestId("ask-table")).toContainText("run_backtest");
  await expect(p1.getByTestId("ask-sources")).toContainText("AAPL US Equity daily prices");
  await expect(p1.getByTestId("ask-action")).toContainText("Open AAPL US Equity backtest in BTST");

  const p2 = page.getByTestId("panel-2");
  await expect(p2.locator(".cmdline-security")).toHaveText("AAPL US Equity");
  await expect(p2.getByTestId("btst-entry")).toHaveValue("close > sma(close, 50)");
  await expect(p2.getByTestId("btst-exit")).toHaveValue("close < sma(close, 50)");
  await expect(p2).toContainText("Strategy Return");
});

test("plain-English screens open in BQL, and drafted alerts are created only when confirmed", async ({ page }) => {
  await signIn(page, "screen");
  const p1 = page.getByTestId("panel-1");
  const p2 = page.getByTestId("panel-2");
  await page.getByTestId("cmd-1").pressSequentially("? screen AAPL and MSFT with bql");
  await page.keyboard.press("Enter");

  const open = p1.getByTestId("ask-action").filter({ hasText: "Open in BQL" });
  await expect(open).toBeVisible();
  await open.click();
  await expect(p2.getByTestId("bql-input")).toHaveValue("SELECT NAME, PX_LAST, PE_RATIO FROM list('AAPL US Equity', 'MSFT US Equity') ORDER BY PE_RATIO");
  await expect(p2.getByTestId("bql-grid").locator("tbody tr")).toHaveCount(2);

  await p1.getByTestId("ask-input").fill("set an alert when AAPL crosses its 50 day average");
  await p1.getByTestId("ask-input").press("Enter");
  const create = p1.getByTestId("ask-action").filter({ hasText: "Create alert" });
  await expect(create).toContainText("AAPL US Equity rule: crossAbove(close, sma(close, 50))");
  await expect(p2.getByTestId("bql-screen")).toBeVisible();
  await create.click();
  await expect(p1.getByTestId("ask-action").filter({ hasText: "Alert created" })).toBeDisabled();
  await expect(p2.getByTestId("alrt-screen")).toContainText("crossAbove(close, sma(close, 50))");
});

test("filing questions compare risk factors across 10-Ks and cite the SEC filings", async ({ page }) => {
  await signIn(page, "filings");
  const p1 = page.getByTestId("panel-1");
  await page.getByTestId("cmd-1").pressSequentially("? what changed in the risk factors of AAPL");
  await page.keyboard.press("Enter");

  await expect(p1.getByTestId("ask-tool").first()).toContainText("1 added, 1 removed, 1 reworded");
  const link = p1.getByTestId("ask-sources").locator("a").first();
  await expect(link).toHaveAttribute("href", /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//);
});
