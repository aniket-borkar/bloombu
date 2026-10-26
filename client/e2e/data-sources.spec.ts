import { expect, test } from "@playwright/test";

test("source setup explains keyless coverage and stock snapshot limitations", async ({ page }) => {
  await page.goto("/?popout=1&fn=SRC");
  const screen = page.getByTestId("src-screen");
  await expect(screen).toBeVisible();
  await expect(screen).toContainText("Quote Delivery");
  await expect(screen).toContainText("None — stocks use public snapshots");
  await expect(screen).toContainText("A connected socket does not establish that a quote is current");
  const kraken = screen.getByTestId("src-suggestions").getByRole("row").filter({ hasText: "Kraken (no key)" });
  await kraken.scrollIntoViewIfNeeded();
  await expect(kraken).toContainText("No sign-up or API key is needed");
  await expect(screen.getByTestId("src-suggestions")).not.toContainText("FINNHUB_API_KEY");
  await expect(screen.getByTestId("src-providers")).toContainText("mock");

  await page.setViewportSize({ width: 390, height: 720 });
  await kraken.scrollIntoViewIfNeeded();
  const instructions = kraken.getByRole("cell").last();
  const bounds = await instructions.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await instructions.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});
