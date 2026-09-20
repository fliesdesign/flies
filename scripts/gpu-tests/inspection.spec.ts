import { expect, test, type Page } from "@playwright/test";

const gpuArtwork = "[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]";
const redLayer = '[data-gpu-fixture] .canvas-frame-position[data-frame-id="red"]';

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "gpuFixture", await mountGpuFixture());
    // Keep the test editor above the startup page but below menu portals.
    (document.querySelector("[data-gpu-fixture]") as HTMLElement).style.zIndex = "1";
  });
}

async function toggleInspection(page: Page, currentlyEnabled: boolean) {
  await page.getByRole("button", { name: "Project menu" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Inspect HTML" });
  await expect(item).toHaveAttribute("aria-checked", String(currentlyEnabled));
  await item.click();
  await page.keyboard.press("Escape");
}

async function editorState(page: Page) {
  return page.evaluate(() => {
    const { controls } = Reflect.get(window, "gpuFixture");
    return {
      nodes: controls.document.getFrames(),
      revision: controls.document.getSnapshot().revision,
      selection: controls.getSelection(),
      viewport: controls.camera.getCurrent().viewport,
    };
  });
}

test("HTML inspection exposes actual node elements, retains editor state, and persists across reload", async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await expect(page.locator(redLayer)).toHaveCount(0);
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "gpuFixture");
    controls.document.transact({
      update: [{ ...controls.document.getFrame("red"), fill: "#00ffff", x: 175, y: 160 }],
    });
    controls.select("red");
    controls.camera.setViewport({ x: 30, y: 20, zoom: 0.8 });
    controls.camera.flush();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "gpuFixture").controls.getSelection()))
    .toEqual(["red"]);
  const before = await editorState(page);
  await toggleInspection(page, false);
  await expect(page.locator(redLayer)).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
  expect(await editorState(page)).toEqual(before);
  await expect(page.locator(`${redLayer} .canvas-rectangle-content`)).toHaveCSS(
    "background-color",
    "rgb(0, 255, 255)",
  );

  await toggleInspection(page, true);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await expect(page.locator(redLayer)).toHaveCount(0);
  expect(await editorState(page)).toEqual(before);

  await toggleInspection(page, false);
  await expect(page.locator(redLayer)).toBeVisible();
  await mount(page);
  await expect(page.locator(redLayer)).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
  await toggleInspection(page, true);
  await expect(page.locator(gpuArtwork)).toBeVisible();
});

test("switching to HTML inspection commits an active GPU text draft", async ({ page }) => {
  await mount(page);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await page.mouse.dblclick(230, 274);
  const draft = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await expect(draft).toBeVisible();
  await draft.fill("Draft retained for HTML inspection");
  await toggleInspection(page, false);
  await expect(
    page.locator('[data-gpu-fixture] .canvas-frame-position[data-frame-id="text"]'),
  ).toHaveText("Draft retained for HTML inspection");
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Draft retained for HTML inspection");
  await toggleInspection(page, true);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Draft retained for HTML inspection");
});
