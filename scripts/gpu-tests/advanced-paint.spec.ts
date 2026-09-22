import type { CanvasFrame } from "@flies/canvas";
import { expect, test, type Page } from "@playwright/test";

type Point = { x: number; y: number };
const fixtureSelector = "[data-gpu-fixture]";

async function mount(page: Page, nodes: CanvasFrame[]) {
  await page.goto("/recents");
  await page.evaluate(async (frames) => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "advancedPaintFixture", fixture);
    if (
      !fixture.controls.document.replaceAll([
        {
          id: "background",
          name: "Background",
          kind: "rectangle",
          x: 0,
          y: 0,
          width: 1280,
          height: 720,
          fill: "#fff",
        },
        ...frames,
      ])
    )
      throw new Error("Invalid advanced-paint fixture");
    fixture.controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
    fixture.controls.camera.flush();
  }, nodes);
  await expect(page.locator(".canvas-webgl-surface[data-renderer=webgl2]")).toBeVisible();
  await expect(page.locator(".canvas-webgl-surface")).toHaveAttribute(
    "data-pending-resources",
    "0",
  );
}

async function pixels(page: Page, png: Buffer, points: Point[]) {
  return page.evaluate(
    async ({ encoded, locations }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);

      const bounds = document.querySelector("[data-gpu-fixture]")!.getBoundingClientRect();
      const scaleX = image.width / bounds.width;
      const scaleY = image.height / bounds.height;

      return locations.map(({ x, y }) =>
        [...context.getImageData(Math.floor(x * scaleX), Math.floor(y * scaleY), 1, 1).data].slice(
          0,
          3,
        ),
      );
    },
    { encoded: png.toString("base64"), locations: points },
  );
}

async function useDom(page: Page) {
  await page.evaluate(() => Reflect.get(window, "advancedPaintFixture").setInspection(true));
  await expect(page.locator(".canvas-webgl-surface")).toHaveCount(0);
  // DOM masks build an alpha texture asynchronously, independently of the artwork renderer.
  await expect
    .poll(() =>
      page
        .locator(".canvas-mask-artwork")
        .evaluateAll(
          (elements) =>
            elements.filter((element) => (element as HTMLElement).style.maskImage.includes("url("))
              .length,
        ),
    )
    .toBeGreaterThanOrEqual(
      await page.evaluate(
        () =>
          Reflect.get(window, "advancedPaintFixture")
            .controls.document.getFrames()
            .filter((frame: CanvasFrame) => frame.maskId).length,
      ),
    );
}

const rect = (id: string, x: number, y: number, width: number, height: number): CanvasFrame => ({
  id,
  name: id,
  kind: "rectangle",
  x,
  y,
  width,
  height,
  fill: "#175be8",
});

test("normalized image crop selects the same source rectangle in DOM and Firefly", async ({
  page,
}, testInfo) => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><path fill="#f00" d="M0 0h100v50H0z"/><path fill="#0f0" d="M100 0h100v50H100z"/><path fill="#00f" d="M0 50h100v50H0z"/><path fill="#ff0" d="M100 50h100v50H100z"/></svg>';

  const source = await page.evaluate(async (svgSource) => {
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(svgSource)}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 100;
    canvas.getContext("2d")!.drawImage(image, 0, 0);

    return canvas.toDataURL();
  }, svg);

  await mount(page, [
    {
      id: "crop",
      name: "Crop",
      kind: "image",
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      src: source,
      crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    },
  ]);

  const points = [
    { x: 150, y: 125 },
    { x: 450, y: 125 },
    { x: 150, y: 275 },
    { x: 450, y: 275 },
  ];

  const native = await page.locator(fixtureSelector).screenshot();
  const nativePixels = await pixels(page, native, points);
  await useDom(page);
  const reference = await page.locator(fixtureSelector).screenshot();
  expect(nativePixels).toEqual([
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ]);
  expect(await pixels(page, reference, points)).toEqual(nativePixels);
  await testInfo.attach("crop-firefly.png", { body: native, contentType: "image/png" });
});

test("shared rotated and blurred alpha masks match DOM and hide their source artwork", async ({
  page,
}, testInfo) => {
  await mount(page, [
    { ...rect("target-one", 100, 100, 280, 200), maskId: "source", opacity: 0.8 },
    { ...rect("target-two", 400, 100, 140, 200), maskId: "source", fill: "#e84010" },
    {
      ...rect("source", 220, 120, 240, 160),
      kind: "svg",
      src: `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><ellipse cx="120" cy="80" rx="120" ry="80"/></svg>').toString("base64")}`,
      rotation: 18,
      opacity: 0.6,
      filters: { blur: 5 },
    },
    { ...rect("nested", 650, 100, 280, 220), kind: "group", rotation: -14 },
    {
      ...rect("nested-target", 650, 100, 250, 200),
      parentId: "nested",
      maskId: "nested-source",
      fill: "#d02696",
    },
    {
      ...rect("nested-source", 720, 140, 170, 110),
      parentId: "nested",
      rotation: 25,
      fill: "#000",
    },
  ]);

  const points = [
    { x: 150, y: 150 },
    { x: 260, y: 200 },
    { x: 330, y: 170 },
    { x: 420, y: 220 },
    { x: 390, y: 200 },
    { x: 500, y: 180 },
    { x: 760, y: 180 },
    { x: 850, y: 210 },
  ];

  const native = await page.locator(fixtureSelector).screenshot();
  const nativePixels = await pixels(page, native, points);
  await useDom(page);
  const reference = await page.locator(fixtureSelector).screenshot();
  const referencePixels = await pixels(page, reference, points);
  expect(nativePixels[0]).toEqual([255, 255, 255]);
  expect(nativePixels[4]).toEqual([255, 255, 255]);
  expect(nativePixels[1][0]).toBeLessThan(170);
  for (let index = 0; index < points.length; index++)
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(nativePixels[index][channel] - referencePixels[index][channel]),
        `mask pixel ${JSON.stringify(points[index])}: native ${nativePixels[index]}, DOM ${referencePixels[index]}`,
      ).toBeLessThanOrEqual(8);
  await testInfo.attach("masks-firefly.png", { body: native, contentType: "image/png" });
  await testInfo.attach("masks-dom.png", { body: reference, contentType: "image/png" });
});

test("mixed font metrics, colors and decorations retain rich text geometry", async ({
  page,
}, testInfo) => {
  await mount(page, [
    {
      id: "rich",
      name: "Rich text",
      kind: "text",
      x: 100,
      y: 100,
      width: 420,
      height: 250,
      text: "Small BIG italic\ncolored underlined final line",
      fontFamily: "Arial",
      fontSize: 24,
      color: "#111111",
      lineHeight: 1.3,
      textRuns: [
        { start: 6, end: 9, fontSize: 42, fontWeight: 700, color: "#d02030" },
        { start: 10, end: 16, fontStyle: "italic" },
        { start: 17, end: 24, color: "#0649d8" },
        { start: 25, end: 35, textDecoration: "underline" },
      ],
    },
  ]);
  const native = await page.locator(fixtureSelector).screenshot();
  await useDom(page);
  const reference = await page.locator(fixtureSelector).screenshot();

  const comparison = await page.evaluate(
    async ({ a, b }) => {
      // The evaluated browser function cannot capture a Node-side helper.
      // oxlint-disable-next-line unicorn/consistent-function-scoping
      const decode = async (encoded: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${encoded}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);

        const bounds = document.querySelector("[data-gpu-fixture]")!.getBoundingClientRect();
        const scaleX = image.width / bounds.width;
        const scaleY = image.height / bounds.height;

        return {
          data: context.getImageData(
            Math.round(100 * scaleX),
            Math.round(100 * scaleY),
            Math.round(420 * scaleX),
            Math.round(250 * scaleY),
          ).data,
          density: scaleX * scaleY,
        };
      };

      const [nativeImage, referenceImage] = await Promise.all([decode(a), decode(b)]);

      const first = nativeImage.data,
        second = referenceImage.data;

      let error = 0,
        ink = 0,
        red = 0,
        blue = 0;

      for (let i = 0; i < first.length; i += 4) {
        error +=
          Math.abs(first[i] - second[i]) +
          Math.abs(first[i + 1] - second[i + 1]) +
          Math.abs(first[i + 2] - second[i + 2]);
        if (Math.min(first[i], first[i + 1], first[i + 2]) < 150) ink++;
        if (first[i] > first[i + 2] * 1.5 && first[i + 1] < 120) red++;
        if (first[i + 2] > first[i] * 1.5 && first[i + 1] < 120) blue++;
      }

      return {
        meanError: error / ((first.length / 4) * 3),
        ink: ink / nativeImage.density,
        red: red / nativeImage.density,
        blue: blue / nativeImage.density,
      };
    },
    { a: native.toString("base64"), b: reference.toString("base64") },
  );

  expect(comparison.ink).toBeGreaterThan(1600);
  expect(comparison.red).toBeGreaterThan(350);
  expect(comparison.blue).toBeGreaterThan(150);
  expect(comparison.meanError).toBeLessThan(2);
  await testInfo.attach("rich-text-firefly.png", { body: native, contentType: "image/png" });
  await testInfo.attach("rich-text-dom.png", { body: reference, contentType: "image/png" });
});

test("mask edits update alpha and deleting the source releases its targets", async ({ page }) => {
  await mount(page, [
    { ...rect("target", 100, 100, 200, 200), maskId: "mask" },
    { ...rect("mask", 180, 100, 60, 200), fill: "#000" },
  ]);
  const point = [{ x: 200, y: 180 }];

  const sample = async () =>
    (await pixels(page, await page.locator(fixtureSelector).screenshot(), point))[0];

  expect(await sample()).toEqual([23, 91, 232]);
  await page.evaluate(() => {
    const doc = Reflect.get(window, "advancedPaintFixture").controls.document;
    doc.update({ ...doc.getFrame("mask"), hidden: true });
  });
  await expect.poll(sample).toEqual([255, 255, 255]);
  await page.evaluate(() =>
    Reflect.get(window, "advancedPaintFixture").controls.document.remove("mask"),
  );
  await expect.poll(sample).toEqual([23, 91, 232]);
  expect(
    await page.evaluate(
      () => Reflect.get(window, "advancedPaintFixture").controls.document.getFrame("target").maskId,
    ),
  ).toBeUndefined();
});

test("moving a child into the clip edge invalidates the retained containment proof", async ({
  page,
}) => {
  await mount(page, [
    {
      ...rect("parent", 100, 100, 200, 200),
      kind: "frame",
      fill: "#fff",
      shadows: [],
      cornerRadius: 20,
    },
    { ...rect("child", 150, 150, 100, 100), parentId: "parent" },
  ]);
  await page.evaluate(() => {
    const doc = Reflect.get(window, "advancedPaintFixture").controls.document;
    doc.update({ ...doc.getFrame("child"), x: 260, y: 100 });
  });

  const points = [
    { x: 280, y: 140 },
    { x: 320, y: 140 },
    { x: 299, y: 101 },
  ];

  await expect
    .poll(async () => pixels(page, await page.locator(fixtureSelector).screenshot(), points))
    .toEqual([
      [23, 91, 232],
      [255, 255, 255],
      [255, 255, 255],
    ]);
});
