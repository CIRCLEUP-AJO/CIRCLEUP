import { expect, test } from "@playwright/test";

const activeCircle = "CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3";
const pendingCircle = "CACAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAINCW";
const member = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

test("home: empty circle list", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("No circles yet.")).toBeVisible();
  await expect(page).toHaveScreenshot("home-empty.png", { fullPage: true, animations: "disabled" });
});

test("create: invalid member validation", async ({ page }) => {
  await page.goto("/create");
  await page.getByLabel(/Circle name/).fill("Visual fixture circle");
  await page.getByLabel("Contribution amount in USDC").fill("25");
  await page.getByLabel("Round duration in days").fill("30");
  await page.getByRole("textbox", { name: /Member 1 of/ }).fill(member);
  await page.getByRole("textbox", { name: /Member 2 of/ }).fill("not-a-stellar-address");
  await page.locator("form").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await expect(page.getByText(/must be a G-prefixed 56-character Stellar address/i)).toBeVisible();
  await expect(page).toHaveScreenshot("create-validation-error.png", { fullPage: true, animations: "disabled" });
});

test("detail: active circle", async ({ page }) => {
  await page.goto(`/circles/${activeCircle}`);
  await expect(page.getByText("Active", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveScreenshot("detail-active.png", { fullPage: true, animations: "disabled" });
});

test("detail: pending circle", async ({ page }) => {
  await page.goto(`/circles/${pendingCircle}`);
  await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
  await expect(page).toHaveScreenshot("detail-pending.png", { fullPage: true, animations: "disabled" });
});

test("reputation: indexer unavailable", async ({ page }) => {
  await page.goto(`/reputation/${member}`);
  await expect(page.getByText("Could not load reputation")).toBeVisible();
  await expect(page).toHaveScreenshot("reputation-indexer-unavailable.png", { fullPage: true, animations: "disabled" });
});