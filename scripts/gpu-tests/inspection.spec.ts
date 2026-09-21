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

async function setInspection(page: Page, enabled: boolean) {
  await page.evaluate((value) => {
    const fixture = Reflect.get(window, "gpuFixture");
    // The removed menu committed the active text draft before changing renderers.
    fixture.controls.prepare();
    fixture.setInspection(value);
  }, enabled);
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

test("HTML inspection exposes actual node elements and retains editor state", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("flies.canvas.inspect-html", "false"));
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
  await setInspection(page, true);
  await expect(page.locator(redLayer)).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
  expect(await editorState(page)).toEqual(before);
  await expect(page.locator(`${redLayer} .canvas-rectangle-content`)).toHaveCSS(
    "background-color",
    "rgb(0, 255, 255)",
  );
  expect(await page.evaluate(() => localStorage.getItem("flies.canvas.inspect-html"))).toBe(
    "false",
  );

  await setInspection(page, false);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await expect(page.locator(redLayer)).toHaveCount(0);
  expect(await editorState(page)).toEqual(before);
  expect(await page.evaluate(() => localStorage.getItem("flies.canvas.inspect-html"))).toBe(
    "false",
  );
});

test("switching to HTML inspection commits an active GPU text draft", async ({ page }) => {
  await mount(page);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await page.mouse.dblclick(230, 274);
  const draft = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await expect(draft).toBeVisible();
  await draft.fill("Draft retained for HTML inspection");
  await setInspection(page, true);
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
  await setInspection(page, false);
  await expect(page.locator(gpuArtwork)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Draft retained for HTML inspection");
});
