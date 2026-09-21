import { expect, test, type Locator, type Page } from "@playwright/test";

async function colors(page: Page, points: { x: number; y: number }[]) {
  const png = await page.locator("[data-gpu-fixture]").screenshot();

  return page.evaluate(
    async ({ imageData, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${imageData}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);

      return samples.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
    },
    { imageData: png.toString("base64"), samples: points },
  );
}

async function dragStart(page: Page, handle: Locator) {
  const box = (await handle.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();

  return point;
}

async function state(page: Page) {
  return page.evaluate(() => {
    const { document } = Reflect.get(window, "layoutGpuFixture").controls;

    return {
      section: document.getFrame("section"),
      first: document.getFrame("first"),
      second: document.getFrame("second"),
      committed: document
        .getCommittedFrames()
        .find((node: { id: string }) => node.id === "section"),
      commits: Reflect.get(window, "layoutGpuCommits"),
    };
  });
}

test("WebGPU layout chrome previews padding and gap with fill/hug artwork and shared undo", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "layoutGpuFixture", fixture);
    const { controls } = fixture;
    controls.document.replaceAll([
      {
        id: "page",
        name: "Layout study",
        x: 160,
        y: 100,
        width: 520,
        height: 480,
        fill: "#181818",
        layout: { direction: "column", gap: 20, padding: 20, align: "start", justify: "start" },
      },
      {
        id: "section",
        name: "Section",
        parentId: "page",
        x: 180,
        y: 120,
        width: 480,
        height: 228,
        fill: "#212121",
        widthSizing: "fill",
        heightSizing: "hug",
        layout: { direction: "column", gap: 24, padding: 32, align: "center", justify: "start" },
      },
      {
        id: "first",
        name: "Fill child",
        parentId: "section",
        kind: "rectangle",
        fill: "#00aaff",
        x: 212,
        y: 152,
        width: 416,
        height: 80,
        widthSizing: "fill",
      },
      {
        id: "second",
        name: "Fixed child",
        parentId: "section",
        kind: "rectangle",
        fill: "#44dd66",
        x: 270,
        y: 256,
        width: 300,
        height: 60,
      },
    ]);
    controls.select("section");
    Reflect.set(window, "layoutGpuCommits", 0);
    controls.document.subscribeChanges(() => {
      Reflect.set(window, "layoutGpuCommits", Reflect.get(window, "layoutGpuCommits") + 1);
    });
  });

  const host = page.locator("[data-gpu-fixture]");
  const surface = host.locator(".canvas-gpu-surface[data-renderer=webgpu]");
  await expect(surface, "The test must render with WebGPU, never the DOM fallback").toBeVisible();
  await expect(host.locator(".canvas-frame-position")).toHaveCount(0);
  await expect(host.locator(".canvas-dimensions")).toHaveText("Fill 480 × Fit 228");
  await expect(host.locator("[data-layout-child]")).toHaveCount(2);
  await expect
    .poll(async () => (await colors(page, [{ x: 222, y: 180 }]))[0])
    .toEqual([0, 170, 255]);

  const padding = host.locator('[data-layout-handle="padding-top"]');
  const start = await dragStart(page, padding);
  await page.mouse.move(start.x, start.y + 20, { steps: 8 });
  await expect.poll(async () => (await state(page)).section.layout.padding).toBe(52);
  expect(await state(page)).toMatchObject({
    section: { width: 480, height: 268 },
    first: { x: 232, y: 172, width: 376 },
    second: { y: 276 },
    committed: { layout: { padding: 32 } },
    commits: 0,
  });
  await expect(host.locator(".canvas-layout-value")).toHaveText("52");
  await expect(host.locator(".canvas-dimensions")).toHaveText("Fill 480 × Fit 268");
  await expect
    .poll(() =>
      colors(page, [
        { x: 222, y: 180 },
        { x: 242, y: 180 },
      ]),
    )
    .toEqual([
      [33, 33, 33],
      [0, 170, 255],
    ]);
  await page.mouse.up();
  expect((await state(page)).commits).toBe(1);
  await page.evaluate(() => Reflect.get(window, "layoutGpuFixture").controls.document.undo());
  await expect.poll(async () => (await state(page)).section.layout.padding).toBe(32);
  await expect
    .poll(async () => (await colors(page, [{ x: 222, y: 180 }]))[0])
    .toEqual([0, 170, 255]);

  const gap = host.locator('[data-layout-handle="gap-first-second"]');
  const gapStart = await dragStart(page, gap);
  await page.mouse.move(gapStart.x, gapStart.y + 16, { steps: 6 });
  await expect.poll(async () => (await state(page)).section.layout.gap).toBe(40);
  expect(await state(page)).toMatchObject({
    section: { height: 244 },
    second: { y: 272 },
    committed: { layout: { gap: 24 } },
    commits: 2,
  });
  await expect(host.locator(".canvas-layout-value")).toHaveText("40");
  await expect
    .poll(async () => (await colors(page, [{ x: 280, y: 320 }]))[0])
    .toEqual([68, 221, 102]);
  await page.mouse.up();
  expect((await state(page)).commits).toBe(3);
  await page.evaluate(() => Reflect.get(window, "layoutGpuFixture").controls.document.undo());
  await expect.poll(async () => (await state(page)).second.y).toBe(256);
  await expect
    .poll(async () => (await colors(page, [{ x: 280, y: 320 }]))[0])
    .toEqual([33, 33, 33]);
  await expect(host.locator(".canvas-dimensions")).toHaveText("Fill 480 × Fit 228");
  await gap.hover();
  await page.screenshot({ path: "/tmp/flies-layout-webgpu.png" });
  await expect(surface).toBeVisible();
  expect(errors).toEqual([]);
});
