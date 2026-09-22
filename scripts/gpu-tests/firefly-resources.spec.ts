import { expect, test } from "@playwright/test";

test("ordered mixed artwork uses fewer draws than primitives without dropping dense content", async ({
  page,
}) => {
  await page.goto("/recents");

  const result = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasWebglRenderer, CanvasDocument, CanvasCamera, createMixedBenchmarkNodes } =
      await import(/* @vite-ignore */ path);

    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const documentModel = new CanvasDocument(createMixedBenchmarkNodes(1000));
    const camera = new CanvasCamera();
    camera.setSize({ x: 1280, y: 720 });
    camera.setViewport({ x: 20, y: 20, zoom: 0.15 });
    camera.flush();
    const errors: string[] = [];

    const renderer = await CanvasWebglRenderer.create({
      canvas,
      document: documentModel,
      camera,
      onError: (error: unknown) => errors.push(String(error)),
    });

    const stats = renderer.getStats();
    renderer.destroy();
    canvas.remove();

    return { stats, errors };
  });

  expect(result.errors).toEqual([]);
  expect(result.stats.primitiveCount).toBeGreaterThan(800);
  expect(result.stats.drawCalls).toBeLessThan(result.stats.primitiveCount);
  expect(result.stats.pendingResources).toBe(0);
});

test("small effects retain bounded surfaces and hidden filters allocate no scene padding", async ({
  page,
}) => {
  await page.goto("/recents");

  const result = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasWebglRenderer, CanvasDocument, CanvasCamera } = await import(
      /* @vite-ignore */ path
    );

    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    const documentModel = new CanvasDocument([
      {
        id: "blur",
        name: "Blur",
        kind: "rectangle",
        x: 150,
        y: 150,
        width: 200,
        height: 120,
        fill: "#f00",
        filters: { blur: 20 },
      },
      {
        id: "hidden",
        name: "Hidden",
        kind: "rectangle",
        x: 500,
        y: 200,
        width: 100,
        height: 100,
        fill: "#00f",
        filters: { blur: 100 },
        hidden: true,
      },
    ]);

    const camera = new CanvasCamera();
    camera.setSize({ x: 1280, y: 720 });
    camera.setViewport({ x: 0, y: 0, zoom: 1 });
    camera.flush();
    const errors: string[] = [];

    const renderer = await CanvasWebglRenderer.create({
      canvas,
      document: documentModel,
      camera,
      onError: (error: unknown) => errors.push(String(error)),
    });

    const visible = renderer.getStats();
    documentModel.update({ ...documentModel.getFrame("blur")!, hidden: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const hidden = renderer.getStats();
    renderer.destroy();
    canvas.remove();

    return { visible, hidden, errors, density: window.devicePixelRatio };
  });

  expect(result.errors).toEqual([]);
  // Two small ping-pong targets including their blur tails, rather than two viewports.
  expect(result.visible.pooledSurfaceBytes).toBeLessThan(1_000_000 * result.density ** 2);
  expect(result.visible.surfaceBytes).toBeGreaterThan(0);
  expect(result.hidden.surfaceBytes).toBe(0);
});

test("memory pressure replaces excessive zoom rasters while reusing text layout", async ({
  page,
}) => {
  await page.goto("/recents");

  const result = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasWebglRenderer, CanvasDocument, CanvasCamera } = await import(
      /* @vite-ignore */ path
    );

    const canvas = document.createElement("canvas");
    document.body.append(canvas);

    const documentModel = new CanvasDocument(
      [20, 80].map((y, index) => ({
        id: `text-${index}`,
        name: "Text",
        kind: "text",
        x: 20,
        y,
        width: 280,
        height: 40,
        text: `Cache sample ${index}`,
        color: "#000",
        fontSize: 20,
        fontFamily: "Arial",
      })),
    );

    const camera = new CanvasCamera();
    camera.setSize({ x: 1280, y: 720 });
    camera.setViewport({ x: 0, y: 0, zoom: 4 });
    camera.flush();
    const errors: string[] = [];
    const budget = 128 * 1024 * window.devicePixelRatio ** 2;

    const renderer = await CanvasWebglRenderer.create({
      canvas,
      document: documentModel,
      camera,
      rasterBudgetBytes: budget,
      onError: (error: unknown) => errors.push(String(error)),
    });

    const close = renderer.getStats();
    camera.setViewport({ x: 0, y: 0, zoom: 1 });
    camera.flush();
    await renderer.whenReady();
    const overview = renderer.getStats();
    renderer.destroy();
    canvas.remove();

    return { close, overview, errors, budget };
  });

  expect(result.errors).toEqual([]);
  expect(result.close.rasterBytes).toBeGreaterThan(result.budget);
  expect(result.overview.rasterBytes).toBeLessThanOrEqual(result.budget);
  expect(result.overview.textLayoutCache.misses).toBe(result.close.textLayoutCache.misses);
  expect(result.overview.textLayoutCache.hits).toBeGreaterThanOrEqual(
    result.close.textLayoutCache.hits + 2,
  );
  expect(result.overview.pendingResources).toBe(0);
  expect(result.overview.cachePressure).toBe(false);
});
