import type { CanvasFrame } from "@flies/canvas";
import { expect, test } from "@playwright/test";

test("onboarding follows real file creation, drawing, committed fill, and survives reload", async ({
  page,
}) => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  let created = false;

  let file = {
    format: "flies",
    version: 1,
    id,
    name: "First idea",
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    nodes: [] as CanvasFrame[],
  };

  const account = {
    user: { id: "onboarding-test", name: "Test", email: "test@example.invalid" },
    workspace: { id: "workspace", name: "My workspace" },
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: account });
    if (path === "/api/sync/ticket") return route.fulfill({ json: { enabled: false } });

    if (path === "/api/files") {
      if (route.request().method() === "POST") {
        created = true;
        file = { ...file, ...route.request().postDataJSON() };

        return route.fulfill({ json: file });
      }

      return route.fulfill({
        json: {
          workspace: account.workspace,
          warnings: [],
          files: created
            ? [{ ...file, preview: [], nodeCount: file.nodes.length, archived: false }]
            : [],
        },
      });
    }

    if (path === `/api/files/${id}`) return route.fulfill({ json: file });

    if (path === `/api/files/${id}/revisions`) {
      file = { ...file, nodes: route.request().postDataJSON().nodes, revision: file.revision + 1 };

      return route.fulfill({ json: file });
    }

    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/files");
  const guide = page.getByRole("region", { name: "Getting started guide" });
  await expect(guide.getByText("A little tour. A first idea.")).toBeVisible();
  await expect(guide.getByText("Quick tour", { exact: true })).toBeVisible();
  await expect(guide.getByText("YOUR FIRST DESIGN")).toHaveCount(0);
  await expect(guide.locator(".onboarding-mark-frame")).not.toHaveCSS("animation-name", "none");
  await page.screenshot({ path: "/tmp/flies-onboarding-welcome.png", animations: "disabled" });
  await guide.getByRole("button", { name: "Show me around" }).click();
  await guide.getByRole("button", { name: "Let’s make something" }).click();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(guide).toBeHidden();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("First idea");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(guide.getByText("Draw your first frame")).toBeVisible();
  await expect(page.locator(".workspace-tabs")).toHaveCount(0);
  const properties = page.getByRole("complementary", { name: "Properties panel" });
  await expect(properties).toBeVisible();
  await expect(properties.getByRole("button", { name: "Test (you)" })).toBeVisible();
  await expect(properties.getByText("Select a layer to edit its properties.")).toBeVisible();
  await expect(page.locator(".canvas-properties-header")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Collapse properties" })).toHaveCount(0);
  await page.getByRole("button", { name: "Frame (F)", exact: true }).click();
  const canvas = page.getByRole("application", { name: "Design canvas" });
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 120, bounds.y + 170);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 320, bounds.y + 310, { steps: 8 });
  await page.mouse.up();
  await expect(guide.getByText("Make it yours")).toBeVisible();
  await expect(page.locator(".canvas-properties-header")).toHaveCount(0);
  const fillBounds = (await page.locator('[data-onboarding="fill"]').boundingBox())!;
  expect(fillBounds.y).toBeGreaterThanOrEqual(0);
  expect(fillBounds.y + fillBounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: "/tmp/flies-onboarding-color.png" });
  await expect.poll(() => file.nodes.some((node) => node.kind === "frame")).toBe(true);
  await page.reload();
  await expect(guide.getByText("Make it yours")).toBeVisible();
  await expect(properties.getByRole("button", { name: "Test (you)" })).toBeVisible();
  const fill = page.getByRole("textbox", { name: "Fill color", exact: true });
  await fill.fill("924FF7");
  await fill.press("Enter");
  await expect(guide.getByText("Your first idea, on canvas.")).toBeVisible();
  await expect(page.locator(".onboarding-confetti span")).toHaveCount(36);
  await expect
    .poll(() => file.nodes.some((node) => "fill" in node && node.fill?.toLowerCase() === "#924ff7"))
    .toBe(true);
  await page.screenshot({ path: "/tmp/flies-onboarding-complete.png" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".onboarding-confetti")).toBeHidden();
  await expect(guide.locator(".onboarding-mark-frame")).toHaveCSS("animation-name", "none");
  await expect(guide.locator(".onboarding-content")).toHaveCSS("animation-name", "none");
  await guide.getByRole("button", { name: "Keep creating" }).click();
  await page.reload();
  await expect(canvas).toBeVisible();
  await expect(guide).toBeHidden();
  await page.getByRole("button", { name: "Select (V)", exact: true }).click();
  await canvas.focus();
  await page.keyboard.press("Escape");
  await expect(properties).toBeVisible();
  await expect(properties.getByText("Select a layer to edit its properties.")).toBeVisible();
  await page.setViewportSize({ width: 700, height: 800 });
  await expect(properties).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(properties.getByRole("button", { name: "Test (you)" })).toBeVisible();
  await expect(page.locator(".workspace-tabs .workspace-collaborators")).toHaveCount(0);
  await page.screenshot({ path: "/tmp/flies-properties-open.png" });
  await page.goto("/files");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Take a quick tour" }).click();
  await expect(guide).toBeVisible();
  const card = (await guide.boundingBox())!;
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/flies-onboarding-narrow.png" });
  await guide.getByRole("button", { name: "Show me around" }).click();
  await guide.getByRole("button", { name: "Let’s make something" }).click();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await guide.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "New file", exact: true })).toBeVisible();
  await expect(guide).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/settings");
  await expect(page.getByRole("slider", { name: "Brightness" })).toHaveValue("16");
  await expect(page.getByRole("slider", { name: "Contrast" })).toHaveValue("12");
  await expect(page.locator('input[type="color"]')).toHaveCount(0);
  await page.screenshot({ path: "/tmp/flies-appearance-simplified.png" });
  await page.getByRole("slider", { name: "Brightness" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Brightness" })).toHaveValue("17");
  await page.reload();
  await expect(page.getByRole("slider", { name: "Brightness" })).toHaveValue("17");
  await page.getByRole("button", { name: "Reset appearance" }).click();
  await expect(page.getByRole("slider", { name: "Brightness" })).toHaveValue("16");
  await expect(page.getByRole("slider", { name: "Contrast" })).toHaveValue("12");
});
