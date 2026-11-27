/**
 * Seance UI end-to-end and accessibility tests (tasks 13.1 to 13.4).
 *
 * Run: `npm run e2e` (starts `npm run dev` with the loopback env from playwright.config.ts unless a
 * server is already on :3000). Needs Redis credentials in .env.local, like mcp-gateway.spec.ts.
 *
 * Tests run serially with one worker. Each raises its own demo; the demo endpoint is limited to
 * 10 per minute per IP and this file raises 4.
 *
 * @axe-core/playwright is the standard axe-core binding for Playwright. It is a devDependency used
 * only by 13.3 to check WCAG A/AA rules against the real rendered pages.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { communeCloseAccount, holdCandle, raiseDemo } from "./helpers/seance";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1280, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test.describe("13.1 and 13.2 candle release", () => {
  test("13.1 full demo flow: held, 2.2 s hold, closed", async ({ page }) => {
    await raiseDemo(page);
    const form = await communeCloseAccount(page);

    const inbox = page.locator("#inbox");
    await expect(inbox.getByRole("heading", { name: "CloseAccount" })).toBeVisible();
    await holdCandle(page, inbox.getByRole("button", { name: "Hold to release" }), 2200);
    await expect(inbox.getByText("Released").first()).toBeVisible();

    // The waiting Commune form picks up the real result, or the user collects it.
    const answered = form.getByText("The spirit answered.");
    const collect = form.getByRole("button", { name: "Collect result" });
    await expect(answered.or(collect)).toBeVisible({ timeout: 30_000 });
    if (!(await answered.isVisible())) await collect.click();
    await expect(answered).toBeVisible();
    await expect(form.locator("pre")).toContainText('"closed": true');

    // The transcript shows the call.
    const transcript = page.getByRole("list", { name: "Calls, newest first" });
    await expect(transcript.locator("[data-tool]", { hasText: "CloseAccount" }).first()).toBeVisible();
  });

  test("13.2 a 1 s hold releases nothing", async ({ page }) => {
    const approvalPosts: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "POST" && req.url().includes("/approvals/")) approvalPosts.push(req.url());
    });

    await raiseDemo(page);
    const form = await communeCloseAccount(page);

    const inbox = page.locator("#inbox");
    const candle = inbox.getByRole("button", { name: "Hold to release" });
    await expect(candle).toBeVisible();
    await holdCandle(page, candle, 1000);

    // Let any (wrongly) triggered request and the 2 s inbox poll surface before asserting absence.
    await page.waitForTimeout(2500);
    expect(approvalPosts).toEqual([]);
    await expect(candle).toBeEnabled();
    await expect(inbox.getByRole("heading", { name: "CloseAccount" })).toBeVisible();
    await expect(inbox.getByText("Released")).toHaveCount(0);
    await expect(form.getByText("Waiting for a human to release this call")).toBeVisible();
    await expect(form.getByText("The spirit answered.")).toHaveCount(0);
  });
});

test.describe("13.3 accessibility", () => {
  async function serious(page: import("@playwright/test").Page): Promise<string[]> {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    return results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  }

  test("home page has no serious or critical violations", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Raise the Gravewood Bank demo" })).toBeVisible();
    expect(await serious(page)).toEqual([]);
  });

  test("service page, Inbox and Commune open, has no serious or critical violations", async ({ page }) => {
    await raiseDemo(page);
    await communeCloseAccount(page);
    await expect(page.locator("#inbox").getByRole("button", { name: "Hold to release" })).toBeVisible();
    // Open every Commune and transcript disclosure so their contents are scanned too.
    await page.evaluate(() => {
      document.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
    });
    expect(await serious(page)).toEqual([]);
  });
});

test.describe("13.4 phone width", () => {
  test.use({ viewport: { width: 360, height: 640 } });

  const noHorizontalScroll = (page: import("@playwright/test").Page) =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  test("home has no horizontal scroll and the demo button is visible without scrolling", async ({ page }) => {
    await page.goto("/");
    const demo = page.getByRole("button", { name: "Raise the Gravewood Bank demo" });
    await expect(demo).toBeInViewport({ ratio: 1 });
    expect(await noHorizontalScroll(page)).toBe(true);
  });

  test("service page has no horizontal scroll", async ({ page }) => {
    await raiseDemo(page);
    await communeCloseAccount(page);
    await expect(page.locator("#inbox").getByRole("button", { name: "Hold to release" })).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
