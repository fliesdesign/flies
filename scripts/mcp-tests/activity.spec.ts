import { expect, test } from "@playwright/test";

test("agent footprint tracks edits, camera and live drags; fades preserve node opacity", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/activity-harness.tsx";
    const { mountActivity } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "agentTest", mountActivity());
  });
  const outline = page.locator(".canvas-agent-outline");
  await expect(outline).toHaveCSS("left", "100px");
  await page.evaluate(() => Reflect.get(window, "agentTest").change());
  await expect(outline).toHaveCSS("left", "120px");
  await expect
    .poll(() =>
      page
        .locator('[data-frame-id="agent-frame"]')
        .evaluate((element) => Number(getComputedStyle(element).opacity)),
    )
    .toBeLessThan(0.7);
  await page.evaluate(() => Reflect.get(window, "agentTest").pan());
  await expect(outline).toHaveCSS("left", "270px");
  await expect(outline).toHaveCSS("width", "400px");
  await page.evaluate(() => Reflect.get(window, "agentTest").drag());
  await expect(outline).toHaveCSS("left", "350px");
  await page.evaluate(() => Reflect.get(window, "agentTest").saving());
  await expect(page.locator(".canvas-agent-status")).toContainText("Saving");
  await page.evaluate(() => Reflect.get(window, "agentTest").finish());
  await expect(page.locator(".canvas-agent-status")).toContainText("Synced");
  await expect(page.locator('[data-frame-id="agent-frame"]')).toHaveCSS("opacity", "0.7");
  await expect(page.locator(".canvas-agent-layer")).toHaveCount(0);
});

test("reduced motion disables agent fades", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/activity-harness.tsx";
    const { mountActivity } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "agentTest", mountActivity());
  });
  await expect(page.locator(".canvas-agent-outline")).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "agentTest").change());
  await expect(page.locator(".canvas-agent-outline")).toHaveCSS("left", "120px");

  const count = await page
    .locator('[data-frame-id="agent-frame"]')
    .evaluate((element) => element.getAnimations().length);

  expect(count).toBe(0);
  await expect(page.locator(".canvas-agent-dot")).toHaveCSS("animation-name", "none");
});
