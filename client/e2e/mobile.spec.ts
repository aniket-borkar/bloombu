import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("phones show one panel at a time and the PANEL key switches between them", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  const manifest = await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest).toMatchObject({ name: "BLMBU Terminal", display: "standalone" });
  expect((await page.request.get("/icon-192.png")).ok()).toBe(true);

  await page.locator("#login").fill(`phone${Date.now()}`);
  await page.getByRole("button", { name: "GO" }).click();
  await expect(page.getByTestId("panel-1")).toBeVisible();
  await expect(page.getByTestId("panel-2")).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("panel-2")).toBeVisible();
  await expect(page.getByTestId("panel-1")).toBeHidden();
});
