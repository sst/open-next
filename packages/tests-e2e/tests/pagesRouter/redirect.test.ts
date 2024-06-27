import { expect, test } from "@playwright/test";

test("Single redirect", async ({ page }) => {
  await page.goto("/next-config-redirect-without-locale-support/");

  let el = page.getByText("Open source Next.js adapter");
  await expect(el).toBeVisible();
});
