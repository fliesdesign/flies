import type { CanvasFrame } from "@flies/canvas";
import { expect, test, type Page } from "@playwright/test";

const artwork = "[data-gpu-fixture] .canvas-webgl-surface[data-renderer=webgl2]";
type Point = { x: number; y: number };

async function mount(page: Page, nodes: CanvasFrame[]) {
  await page.goto("/recents");
  await page.evaluate(async (frames) => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "edgeEffectsFixture", fixture);
    fixture.controls.document.replaceAll([
      {
        id: "background",
        name: "White background",
        kind: "rectangle",
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        fill: "#ffffff",
      },
      ...frames,
    ]);
    fixture.controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
    fixture.controls.camera.flush();
  }, nodes);
  await expect(page.locator(artwork)).toBeVisible();
  await expect(page.locator(artwork)).toHaveAttribute("data-pending-resources", "0");
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
}

async function sampleScreenshot(page: Page, screenshot: Buffer, points: Point[]) {
  return page.evaluate(
    async ({ png, locations }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);

      return locations.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
    },
    { png: screenshot.toString("base64"), locations: points },
  );
}

const cases: {
  name: string;
  nodes: CanvasFrame[];
  points: Point[];
  tolerance: number;
  contrastChannel: number;
}[] = [
  {
    name: "offscreen rectangle blur retains its visible tail",
    nodes: [
      {
        id: "blurred",
        name: "Offscreen red blur",
        kind: "rectangle",
        x: -100,
        y: 160,
        width: 100,
        height: 320,
        fill: "#ff0000",
        filters: { blur: 40 },
      },
    ],
    points: [10, 20, 40, 60, 80, 100].map((x) => ({ x, y: 320 })),
    tolerance: 8,
    contrastChannel: 1,
  },
  {
    name: "ancestor blur includes a nested child outside the viewport",
    nodes: [
      {
        id: "blurred-group",
        name: "Blurred ancestor",
        kind: "group",
        x: -200,
        y: 140,
        width: 200,
        height: 360,
        filters: { blur: 40 },
      },
      {
        id: "inner-group",
        name: "Intermediate group",
        kind: "group",
        parentId: "blurred-group",
        x: -120,
        y: 160,
        width: 120,
        height: 320,
      },
      {
        id: "offscreen-child",
        name: "Offscreen blue child",
        kind: "rectangle",
        parentId: "inner-group",
        x: -100,
        y: 180,
        width: 60,
        height: 280,
        fill: "#0000ff",
      },
    ],
    points: [10, 20, 30, 40, 50, 60].map((x) => ({ x, y: 320 })),
    tolerance: 8,
    contrastChannel: 0,
  },
  {
    name: "scaled pen cap remains visible beyond its offscreen nominal bounds",
    nodes: [
      {
        id: "scaled-pen",
        name: "Large scaled pen cap",
        kind: "pen",
        x: -200,
        y: 350,
        width: 100,
        height: 100,
        points: [{ x: 0, y: 0 }],
        pathWidth: 1,
        pathHeight: 1,
        strokeWidth: 10,
        stroke: "#1234e8",
      },
    ],
    points: [10, 80, 150, 220, 280].map((x) => ({ x, y: 350 })),
    tolerance: 3,
    contrastChannel: 0,
  },
];

for (const { name, nodes, points, tolerance, contrastChannel } of cases) {
  test(name, async ({ page }, testInfo) => {
    await mount(page, nodes);
    const native = await page.locator("[data-gpu-fixture]").screenshot();
    const nativePixels = await sampleScreenshot(page, native, points);
    await page.evaluate(() => Reflect.get(window, "edgeEffectsFixture").setInspection(true));
    await expect(page.locator("[data-gpu-fixture] .canvas-webgl-surface")).toHaveCount(0);
    const reference = await page.locator("[data-gpu-fixture]").screenshot();
    const referencePixels = await sampleScreenshot(page, reference, points);
    await testInfo.attach("edge-effects-firefly.png", { body: native, contentType: "image/png" });
    await testInfo.attach("edge-effects-dom.png", { body: reference, contentType: "image/png" });
    await testInfo.attach("edge-effects-pixels.json", {
      body: JSON.stringify({ points, nativePixels, referencePixels }, null, 2),
      contentType: "application/json",
    });

    // A blank reference cannot accidentally validate a renderer that culled the effect.
    expect(referencePixels[0][contrastChannel], "the DOM effect visibly reaches x=10").toBeLessThan(
      235,
    );

    for (let index = 0; index < points.length; index++) {
      for (let channel = 0; channel < 3; channel++) {
        expect(
          Math.abs(nativePixels[index][channel] - referencePixels[index][channel]),
          `pixel ${points[index].x},${points[index].y}: Firefly ${nativePixels[index]}, DOM ${referencePixels[index]}`,
        ).toBeLessThanOrEqual(tolerance);
      }
    }
  });
}
