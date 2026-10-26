import { expect, test, type Download, type Page } from "@playwright/test";

async function login(page: Page, user: string) {
  await page.goto("/");
  await page.locator("#login").fill(user);
  await page.getByRole("button", { name: "GO", exact: true }).click();
}
async function run(page: Page, panelId: number, command: string) {
  const panel = page.getByTestId(`panel-${panelId}`);
  await panel.locator(".panel-title").click();
  await panel.getByTestId(`cmd-${panelId}`).fill(command);
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

test("SCEN decomposes price and currency shocks and preserves a captured run", async ({ page }) => {
  const user = `SCEN${Date.now()}`;
  await login(page, user);
  const portfolio = await (await page.request.post("/api/portfolios", { data: { user, name: "Research holdings", kind: "positions", baseCurrency: "USD", notional: null,
    holdings: [{ security: "AAPL US Equity", quantity: 10, cost: 100, weight: null, acquired: null }, { security: "VOD LN Equity", quantity: 1000, cost: 80, weight: null, acquired: null }],
  } })).json();
  expect(portfolio.id).toBeGreaterThan(0);
  const panel = await run(page, 1, "SCEN");
  await panel.getByTestId("scen-portfolio").selectOption(String(portfolio.id));
  await panel.getByTestId("scen-add-shock").click();
  await panel.getByLabel("Shock 1 scope").selectOption("currencies");
  await panel.getByLabel("Shock 1 target").fill("GBP");
  await panel.getByLabel("Shock 1 percent").fill("-5");
  let release!: () => void;
  let requested!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(`**/api/portfolios/${portfolio.id}/scenario`, async (route) => {
    const fetched = await route.fetch();
    requested();
    await blocked;
    await route.fulfill({ response: fetched });
  });
  const response = page.waitForResponse((res) => res.request().method() === "POST" && res.url().endsWith(`/api/portfolios/${portfolio.id}/scenario`));
  await panel.getByTestId("scen-run").click();
  await started;
  const initialScroll = await panel.locator(".research-screen").evaluate((el) => el.scrollTop);
  release();
  const scenario = await (await response).json();
  expect(scenario.coverage).toEqual({ valuedRows: 2, totalRows: 2 });
  const vod = scenario.positions.find((p: { security: string }) => p.security === "VOD LN Equity");
  expect(vod.scenarioValue).toBeCloseTo(vod.currentValue * 0.9 * 0.95, 6);
  expect(vod.pnl).toBeCloseTo(vod.priceEffect + vod.fxEffect + vod.interaction, 6);
  await expect(panel.getByTestId("scen-summary")).toContainText("2/2 holdings");
  expect(await panel.locator(".research-screen").evaluate((el) => el.scrollTop)).toBe(initialScroll);
  await expect(panel.getByTestId("scen-positions")).toContainText("VOD LN Equity");
  await panel.getByTestId("scen-capture").click();
  const notebook = page.getByTestId("panel-2").getByTestId("note-screen");
  await expect(notebook.getByTestId("note-evidence")).toHaveCount(1);
  await notebook.getByTestId("note-title").fill("Stress thesis");
  await notebook.getByTestId("note-thesis").fill("Compare the currency effect with the equity shock before changing positions.");
  await notebook.getByTestId("note-save").click();
  await expect(notebook.getByTestId("note-status")).toContainText("revision 1");
  const valuation = await run(page, 3, "AAPL US EQUITY VAL");
  await expect(valuation.getByTestId("val-source")).toBeVisible();
  await valuation.getByTestId("val-run").click();
  await expect(valuation.getByTestId("val-summary")).toBeVisible();
  await page.setViewportSize({ width: 2000, height: 1400 });
  await page.locator(".research-screen").evaluateAll((elements) => elements.forEach((el) => { el.scrollTop = 0; }));
  await page.screenshot({ path: "test-results/research-lab.png", fullPage: true });
  const summaries = await (await page.request.get(`/api/notebooks?user=${user}`)).json();
  const saved = await (await page.request.get(`/api/notebooks/${summaries[0].id}?user=${user}`)).json();
  expect(saved.security).toBeNull(); // A portfolio capture must not inherit the target panel's prior ticker.
  expect(saved.evidence[0].data.assumptions.currencies.GBP).toBe(-5);
  expect(saved.evidence[0].data.positions).toEqual(scenario.positions);
  await panel.getByTestId("scen-market").fill("0");
  await panel.getByTestId("scen-run").click();
  await expect(panel.getByTestId("scen-run")).toBeEnabled();
  const unchanged = await (await page.request.get(`/api/notebooks/${saved.id}?user=${user}`)).json();
  expect(unchanged.evidence[0].data.assumptions.marketPct).toBe(-10);
  expect(unchanged.evidence[0].data.pnl).toBe(scenario.pnl);
});

test("single-panel capture and back retain model inputs and calculated results", async ({ page }) => {
  const user = `BACK${Date.now()}`;
  await login(page, user);
  await page.request.post("/api/portfolios", { data: { user, name: "Single panel", kind: "positions", baseCurrency: "USD", notional: null,
    holdings: [{ security: "AAPL US Equity", quantity: 10, cost: null, weight: null, acquired: null }],
  } });
  await run(page, 1, "LAYOUT");
  await run(page, 1, "1");
  let panel = await run(page, 1, "AAPL US EQUITY VAL");
  await expect(panel.getByTestId("val-source")).toBeVisible();
  await panel.getByTestId("val-eps").fill("19");
  await panel.getByTestId("val-growthPct").fill("3");
  await panel.getByTestId("val-run").click();
  await expect(panel.getByTestId("val-value")).toBeVisible();
  const value = await panel.getByTestId("val-value").textContent();
  await panel.getByTestId("val-capture").click();
  await expect(panel.getByTestId("note-evidence")).toHaveCount(1);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panel.getByTestId("val-eps")).toHaveValue("19");
  await expect(panel.getByTestId("val-growthPct")).toHaveValue("3");
  await expect(panel.getByTestId("val-value")).toHaveText(value!);

  panel = await run(page, 1, "SCEN");
  await panel.getByTestId("scen-market").fill("-17");
  await panel.getByTestId("scen-name").fill("My downside");
  await panel.getByTestId("scen-run").click();
  await expect(panel.getByTestId("scen-summary")).toBeVisible();
  const summary = await panel.getByTestId("scen-summary").textContent();
  await panel.getByTestId("scen-capture").click();
  await expect(panel.getByTestId("note-evidence")).toHaveCount(2);
  await page.keyboard.press("Alt+ArrowLeft");
  await expect(panel.getByTestId("scen-market")).toHaveValue("-17");
  await expect(panel.getByTestId("scen-name")).toHaveValue("My downside");
  await expect(panel.getByTestId("scen-summary")).toHaveText(summary!);
});

test("SCEN handles an empty portfolio and keeps presets locked while calculating", async ({ page }) => {
  const user = `EMPTY${Date.now()}`;
  await login(page, user);
  const created = await page.request.post("/api/portfolios", { data: { user, name: "Empty", kind: "positions", baseCurrency: "USD", notional: null, holdings: [] } });
  const portfolio = await created.json();
  expect(portfolio.id).toBeGreaterThan(0);
  const panel = await run(page, 1, "SCEN");
  let release!: () => void;
  let requested!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { requested = resolve; });
  await page.route(`**/api/portfolios/${portfolio.id}/scenario`, async (route) => {
    const response = await route.fetch();
    requested();
    await blocked;
    await route.fulfill({ response });
  });
  await panel.getByTestId("scen-run").click();
  await started;
  await expect(panel.getByRole("button", { name: "Market −10%", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Market +10%", exact: true })).toBeDisabled();
  await expect(panel.getByRole("button", { name: "Custom", exact: true })).toBeDisabled();
  release();
  await expect(panel.getByTestId("scen-summary")).toContainText("0/0 holdings");
  await expect(panel).toContainText("This portfolio has no holdings");
  await expect(panel.getByTestId("scen-run")).toBeEnabled();
});

test("VAL calculates both models, shows sensitivity and captures distinct snapshots", async ({ page }) => {
  const user = `VAL${Date.now()}`;
  await login(page, user);
  const panel = await run(page, 1, "AAPL US EQUITY VAL");
  await expect(panel.getByTestId("val-source")).toBeVisible();
  for (const [key, value] of Object.entries({ currency: "USD", currentPrice: "100", eps: "10", growthPct: "0", years: "1", requiredReturnPct: "10", terminalPE: "10", payoutPct: "0" })) await panel.getByTestId(`val-${key}`).fill(value);
  const calculation = page.waitForResponse((res) => res.request().method() === "POST" && res.url().includes("/api/research/valuation/"));
  await panel.getByTestId("val-run").click();
  const earnings = await (await calculation).json();
  expect(earnings.valuePerShare).toBeCloseTo(100 / 1.1, 8);
  await expect(panel.getByTestId("val-value")).toHaveText("90.9091");
  await expect(panel.getByTestId("val-sensitivity")).toContainText("10.00×");
  await panel.getByTestId("val-capture").click();
  await panel.getByTestId("val-dcf").click();
  for (const [key, value] of Object.entries({ freeCashFlow: "100", discountRatePct: "2", terminalGrowthPct: "3", netDebt: "0", sharesOutstanding: "10" })) await panel.getByTestId(`val-${key}`).fill(value);
  await panel.getByTestId("val-run").click();
  await expect(panel.getByTestId("val-error")).toContainText("must exceed");
  await panel.getByTestId("val-discountRatePct").fill("10");
  await panel.getByTestId("val-terminalGrowthPct").fill("0");
  await panel.getByTestId("val-run").click();
  await expect(panel.getByTestId("val-value")).toHaveText("100.0000");
  await panel.getByTestId("val-capture").click();
  const notebook = page.getByTestId("panel-2").getByTestId("note-screen");
  await expect(notebook.getByTestId("note-evidence")).toHaveCount(2);
  await notebook.getByTestId("note-title").fill("Valuation evidence");
  await notebook.getByTestId("note-save").click();
  await expect(notebook.getByTestId("note-status")).toContainText("revision 1");
  const list = await (await page.request.get(`/api/notebooks?user=${user}`)).json();
  const saved = await (await page.request.get(`/api/notebooks/${list[0].id}?user=${user}`)).json();
  expect(saved.evidence[0].data.result.method).toBe("earnings");
  expect(saved.evidence[0].data.result.valuePerShare).toBeCloseTo(100 / 1.1, 8);
  expect(saved.evidence[1].data.result.method).toBe("dcf");
  expect(saved.evidence[1].data.result.valuePerShare).toBeCloseTo(100, 8);
  expect(saved.evidence[0].data.context.source).toBeTruthy();
});

test("NOTE retains failed drafts, detects stale saves, exports evidence and recovers with a copy", async ({ page }) => {
  const user = `NOTE${Date.now()}`;
  await login(page, user);
  let panel = await run(page, 1, "NOTE");
  await panel.getByTestId("note-title").fill("Original thesis");
  await panel.getByTestId("note-thesis").fill("Local draft survives a failed save.");
  await panel.getByTestId("note-review").fill("2027-01-01");
  await panel.getByTestId("note-source-title").fill("Company annual report");
  await panel.getByTestId("note-source-publisher").fill("Company investor relations");
  await panel.getByTestId("note-source-url").fill("https://example.com/annual-report");
  await panel.getByTestId("note-source-date").fill("2026-10-25");
  await panel.getByTestId("note-source-text").fill("Check the cash conversion assumption against the filing.");
  await panel.getByTestId("note-add-source").click();
  let fail = true;
  await page.route("**/api/notebooks", async (route) => {
    if (route.request().method() === "POST" && fail) { fail = false; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary outage" }) }); }
    else await route.continue();
  });
  await panel.getByTestId("note-save").click();
  await expect(panel.getByTestId("note-status")).toContainText("Save failed");
  await run(page, 1, "HELP");
  panel = await run(page, 1, "NOTE");
  await expect(panel.getByTestId("note-title")).toHaveValue("Original thesis");
  await expect(panel.getByTestId("note-evidence")).toHaveCount(1);
  await panel.getByTestId("note-save").click();
  await expect(panel.getByTestId("note-status")).toContainText("revision 1");
  const summary = (await (await page.request.get(`/api/notebooks?user=${user}`)).json())[0];
  const original = await (await page.request.get(`/api/notebooks/${summary.id}?user=${user}`)).json();
  const external = await page.request.put(`/api/notebooks/${summary.id}`, { data: { ...original, user, revision: 1, thesis: "Changed in another session." } });
  expect(external.ok()).toBe(true);
  await panel.getByTestId("note-thesis").fill("Keep this local version.");
  await panel.getByTestId("note-save").click();
  await expect(panel.getByTestId("note-status")).toContainText("another session");
  await expect(panel.getByTestId("note-thesis")).toHaveValue("Keep this local version.");
  await expect(panel.getByTestId("note-save")).toBeDisabled();
  const jsonDownload = page.waitForEvent("download");
  await panel.getByTestId("note-export-json").click();
  const json = JSON.parse(await downloadText(await jsonDownload));
  expect(json.thesis).toBe("Keep this local version.");
  expect(json.evidence[0].url).toBe("https://example.com/annual-report");
  const markdownDownload = page.waitForEvent("download");
  await panel.getByTestId("note-export-markdown").click();
  const markdown = await downloadText(await markdownDownload);
  expect(markdown).toContain("Keep this local version.");
  expect(markdown).toContain("https://example.com/annual-report");
  expect(markdown).toContain("Review date: 2027-01-01");
  await panel.getByTestId("note-save-copy").click();
  await expect(panel.getByTestId("note-status")).toContainText('Saved "Original thesis copy"');
  const serverOriginal = await (await page.request.get(`/api/notebooks/${summary.id}?user=${user}`)).json();
  expect(serverOriginal.thesis).toBe("Changed in another session.");
  const copies = await (await page.request.get(`/api/notebooks?user=${user}`)).json();
  const copy = copies.find((item: { title: string }) => item.title === "Original thesis copy");
  await page.request.put(`/api/notebooks/${copy.id}`, { data: { ...json, user, revision: 1, title: copy.title, thesis: "Reloaded server version." } });
  await panel.getByTestId("note-thesis").fill("Another local change.");
  await panel.getByTestId("note-save").click();
  await expect(panel.getByTestId("note-reload")).toBeVisible();
  await panel.getByTestId("note-reload").click();
  await expect(panel.getByTestId("note-thesis")).toHaveValue("Reloaded server version.");
  await expect(panel.getByTestId("note-dirty")).toHaveCount(0);
});
