import { expect, test } from "@playwright/test";

test("sign-in screen when the server requires accounts", async ({ page }) => {
  await page.route("**/api/auth/me", (r) => r.fulfill({ json: { authRequired: true, user: null, signup: true } }));
  await page.route("**/api/auth/login", (r) =>
    (r.request().postDataJSON() as { password: string }).password === "right-password"
      ? r.fulfill({ json: { user: "ALICE" } })
      : r.fulfill({ status: 401, json: { error: "Wrong login name or password" } }),
  );
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  await page.locator("#login").fill("alice");
  await page.locator("#password").fill("bad-password");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("splash-error")).toHaveText("Wrong login name or password");
  await page.locator("#password").fill("right-password");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("panel-1")).toBeVisible();
  await expect(page.getByTestId("sign-out")).toBeVisible();
});
