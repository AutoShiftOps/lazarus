import { expect, type Locator, type Page } from "@playwright/test";

/** Raises the Gravewood demo from the home page and waits for the service page. */
export async function raiseDemo(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.getByRole("button", { name: "Raise the Gravewood Bank demo" }).click();
  await page.waitForURL(/\/s\/[A-Za-z0-9]{8,12}$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The spirit card (list item) for one operation. */
export function spiritCard(page: Page, tool: string): Locator {
  return page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: tool, exact: true }) });
}

/** Opens Commune on an operation and returns the form. */
export async function openCommune(page: Page, tool: string): Promise<Locator> {
  const card = spiritCard(page, tool);
  await card.locator("summary", { hasText: "Commune" }).click();
  const form = card.getByRole("form", { name: `Commune with ${tool}` });
  await expect(form).toBeVisible();
  return form;
}

/** Calls CloseAccount on account 7718 and waits until the call is held. */
export async function communeCloseAccount(page: Page): Promise<Locator> {
  const form = await openCommune(page, "CloseAccount");
  await form.getByLabel("accountId").fill("7718");
  await form.getByRole("button", { name: "Commune", exact: true }).click();
  await expect(form.getByText("Waiting for a human to release this call")).toBeVisible();
  return form;
}

/** Presses and holds the candle with the mouse for `ms`, then releases. */
export async function holdCandle(page: Page, button: Locator, ms: number): Promise<void> {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  if (box === null) throw new Error("Hold button has no bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The hold is time based by design, so this wait is the thing under test.
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
