import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, strict = false) {
  await page.goto("/");
  await page.evaluate(async (strictMode) => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "gpuFixture", await mountGpuFixture({ strict: strictMode }));
  }, strict);
}

async function pixels(page: Page, points: { x: number; y: number }[]) {
  const screenshot = await page.locator("[data-gpu-fixture]").screenshot();

  return page.evaluate(
    async ({ png, samples }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);

      return samples.map(({ x, y }) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3));
    },
    { png: screenshot.toString("base64"), samples: points },
  );
}

function nearColor(actual: number[], expected: number[]) {
  expected.forEach((value, index) =>
    expect(Math.abs(actual[index] - value)).toBeLessThanOrEqual(3),
  );
}

test("theme changes and undo repaint linked layers in WebGPU", async ({ page }) => {
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.evaluate(async () => {
    const path = "/src/lib/mcp/editor.ts";
    const { editorTool } = await import(/* @vite-ignore */ path);
    const { controls } = Reflect.get(window, "gpuFixture");
    await editorTool(controls, "set_theme", {
      tokens: [{ id: "brand", name: "Brand", type: "color", value: "#00aaff" }],
    });
    await editorTool(controls, "apply_tokens", { nodeIds: ["red"], bindings: { fill: "brand" } });
  });
  await expect
    .poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0])
    .toEqual([0, 170, 255]);
  await page.evaluate(() => {
    const doc = Reflect.get(window, "gpuFixture").controls.document;
    doc.setTheme({ tokens: [{ id: "brand", name: "Brand", type: "color", value: "#bf1020" }] });
  });
  await expect
    .poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0])
    .toEqual([191, 16, 32]);
  await page.evaluate(() => Reflect.get(window, "gpuFixture").controls.document.undo());
  await expect
    .poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0])
    .toEqual([0, 170, 255]);
});

test("real WebGPU draws three artboards with clipping, text, images, and composited opacity", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page);

  const adapter = await page.evaluate(async () => {
    const gpu = Reflect.get(navigator, "gpu");

    return Boolean(gpu && (await gpu.requestAdapter()));
  });

  expect(
    adapter,
    "This suite requires a real WebGPU adapter; a DOM fallback is not a passing GPU test",
  ).toBe(true);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-label")).toHaveCount(3);
  await expect.poll(async () => (await pixels(page, [{ x: 160, y: 330 }]))[0]).toEqual([0, 0, 255]);

  const samples = await pixels(page, [
    { x: 200, y: 120 }, // root fill
    { x: 170, y: 170 }, // rounded rectangle interior
    { x: 150, y: 150 }, // rounded rectangle cutout
    { x: 400, y: 140 }, // child inside parent
    { x: 470, y: 140 }, // child clipped outside parent
    { x: 439, y: 101 }, // parent's rounded clipping corner
    { x: 530, y: 130 }, // isolated translucent group
    { x: 580, y: 170 }, // overlap composited once
    { x: 891, y: 150 }, // solid border
    { x: 910, y: 150 }, // shape interior
    { x: 1040, y: 160 }, // hidden node
    { x: 996, y: 280 }, // outer shadow
    { x: 892, y: 280 }, // inset shadow
  ]);

  await testInfo.attach("three-artboards-webgpu.png", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  nearColor(samples[0], [255, 255, 255]);
  nearColor(samples[1], [255, 0, 0]);
  nearColor(samples[2], [255, 255, 255]);
  nearColor(samples[3], [0, 255, 0]);
  expect(Math.max(...samples[4])).toBeLessThan(45);
  expect(Math.max(...samples[5])).toBeLessThan(45);
  nearColor(samples[6], [255, 128, 128]);
  nearColor(samples[7], [128, 128, 255]);
  nearColor(samples[8], [0, 0, 0]);
  nearColor(samples[9], [255, 255, 0]);
  nearColor(samples[10], [255, 255, 255]);
  nearColor(samples[11], [0, 0, 0]);
  nearColor(samples[12], [0, 0, 0]);

  const textPixels = await pixels(
    page,
    Array.from({ length: 180 }, (_, x) => ({ x: 150 + x, y: 274 })),
  );

  expect(textPixels.filter((color) => Math.max(...color) < 100).length).toBeGreaterThan(20);
  expect(errors).toEqual([]);
});

test("WebGPU updates document edits and undo, moves its camera, and supports native editing gestures", async ({
  page,
}) => {
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "gpuFixture");
    controls.document.transact({
      update: [{ ...controls.document.getFrame("red"), fill: "#00ffff" }],
    });
  });
  await expect
    .poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0])
    .toEqual([0, 255, 255]);
  await page.evaluate(() => Reflect.get(window, "gpuFixture").controls.document.undo());
  await expect.poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0]).toEqual([255, 0, 0]);
  await page.evaluate(() => {
    const { camera } = Reflect.get(window, "gpuFixture").controls;
    camera.setViewport({ x: 30, y: 20, zoom: 1 });
    camera.flush();
  });
  await expect.poll(async () => (await pixels(page, [{ x: 200, y: 190 }]))[0]).toEqual([255, 0, 0]);
  await page.keyboard.down("Alt");
  await page.mouse.move(205, 195);
  await page.mouse.down();
  await page.mouse.move(235, 220, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const frame = Reflect.get(window, "gpuFixture").controls.document.getFrame("red");

        return [frame.x, frame.y];
      }),
    )
    .toEqual([180, 175]);
  await page.mouse.dblclick(240, 294);
  const textarea = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await expect(textarea).toBeVisible();
  await textarea.fill("Edited through WebGPU");
  await textarea.press("Control+Enter");
  await page.mouse.click(750, 550);
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Edited through WebGPU");
});

test("unsupported browsers retain the editable DOM canvas", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", { configurable: true, value: undefined }),
  );
  await mount(page);
  await expect(
    page.locator('[data-gpu-fixture] .canvas-frame-position[data-frame-id="red"]'),
  ).toBeVisible();
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toHaveCount(0);
  await page.mouse.dblclick(230, 274);
  await expect(page.locator("[data-gpu-fixture] textarea.canvas-text-editor")).toBeVisible();
});

test("adapter initialization failures retain editable artwork", async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = Reflect.get(navigator, "gpu");
    gpu.requestAdapter = () => Promise.reject(new Error("Test adapter unavailable"));
  });
  await mount(page);
  await expect(
    page.locator('[data-gpu-fixture] .canvas-frame-position[data-frame-id="red"]'),
  ).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
  await page.mouse.dblclick(230, 274);
  await expect(page.locator("[data-gpu-fixture] textarea.canvas-text-editor")).toBeVisible();
});

test("device loss falls back without losing document edits", async ({ page }) => {
  await page.addInitScript(() => {
    const gpu = Reflect.get(navigator, "gpu");
    const requestAdapter = gpu.requestAdapter.bind(gpu);

    gpu.requestAdapter = async (...args: unknown[]) => {
      const adapter = await requestAdapter(...args);
      if (!adapter) return adapter;
      const requestDevice = adapter.requestDevice.bind(adapter);

      adapter.requestDevice = async (...options: unknown[]) => {
        const device = await requestDevice(...options);
        Reflect.set(window, "gpuDeviceForTest", device);

        return device;
      };

      return adapter;
    };
  });
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.mouse.dblclick(230, 274);
  const draft = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await expect(draft).toBeVisible();
  await draft.fill("Kept after device loss");
  await page.evaluate(() => {
    Reflect.get(window, "gpuDeviceForTest").destroy();
  });
  await expect(
    page.locator('[data-gpu-fixture] .canvas-frame-position[data-frame-id="text"]'),
  ).toHaveText("Kept after device loss");
  await expect(page.locator("[data-gpu-fixture] .canvas-gpu-surface")).toHaveCount(0);
});

test("strict mode and editor remounts dispose old GPU canvases", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page, true);
  const artwork = page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]");
  await expect(artwork).toHaveCount(1);
  await page.evaluate(() => Reflect.get(window, "gpuFixture").dispose());
  await expect(page.locator("[data-gpu-fixture]")).toHaveCount(0);
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "gpuFixture", await mountGpuFixture({ strict: true }));
  });
  await expect(artwork).toHaveCount(1);
  await expect.poll(async () => (await pixels(page, [{ x: 170, y: 170 }]))[0]).toEqual([255, 0, 0]);
  expect(errors).toEqual([]);
});

test("GPU initialization waits for an active DOM text draft before switching artwork", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const gpu = Reflect.get(navigator, "gpu");
    const requestAdapter = gpu.requestAdapter.bind(gpu);

    gpu.requestAdapter = async (...args: unknown[]) => {
      await new Promise<void>((resolve) => Reflect.set(window, "releaseGpuAdapter", resolve));

      return requestAdapter(...args);
    };
  });
  await mount(page);
  await expect
    .poll(() => page.evaluate(() => typeof Reflect.get(window, "releaseGpuAdapter")))
    .toBe("function");
  await page.mouse.dblclick(230, 274);
  const draft = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await draft.fill("Draft during initialization");
  await page.evaluate(() => Reflect.get(window, "releaseGpuAdapter")());
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toHaveCount(1);
  await expect(draft).toHaveValue("Draft during initialization");
  await expect(
    page.locator('[data-gpu-fixture] .canvas-frame-position[data-frame-id="red"]'),
  ).toBeVisible();
  await draft.press("Control+Enter");
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Draft during initialization");
});

test("an active GPU text draft survives ancestor clipping changes and same-depth reparenting", async ({
  page,
}) => {
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.mouse.dblclick(230, 274);
  const draft = page.locator("[data-gpu-fixture] textarea.canvas-text-editor");
  await draft.fill("Keep this uncommitted draft");
  await draft.evaluate((element) => Reflect.set(window, "initialDraftElement", element));

  async function changeAncestor(clipContent: boolean) {
    await page.evaluate(async (clip) => {
      const { document } = Reflect.get(window, "gpuFixture").controls;
      document.transact({ update: [{ ...document.getFrame("board"), clipContent: clip }] });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, clipContent);
    await expect(draft).toHaveValue("Keep this uncommitted draft");
    expect(
      await draft.evaluate(
        (element) =>
          element === Reflect.get(window, "initialDraftElement") &&
          element === document.activeElement,
      ),
    ).toBe(true);
  }

  await changeAncestor(false);
  await changeAncestor(true);
  await page.evaluate(async () => {
    const { document } = Reflect.get(window, "gpuFixture").controls;
    document.transact({
      update: [{ ...document.getFrame("text"), parentId: "board-two", x: 550, y: 280 }],
    });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await expect(draft).toHaveValue("Keep this uncommitted draft");
  expect(
    await draft.evaluate(
      (element) =>
        element === Reflect.get(window, "initialDraftElement") &&
        element === document.activeElement,
    ),
  ).toBe(true);
  await draft.press("Control+Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "gpuFixture").controls.document.getFrame("text").text,
      ),
    )
    .toBe("Keep this uncommitted draft");
});

test("replacing and disposing textured artwork releases shader bindings without warnings", async ({
  page,
}) => {
  const warnings: string[] = [];
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" && message.text().includes("PixiJS Warning"))
      warnings.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await expect.poll(async () => (await pixels(page, [{ x: 160, y: 330 }]))[0]).toEqual([0, 0, 255]);
  await page.evaluate(async () => {
    const { controls } = Reflect.get(window, "gpuFixture");

    for (let i = 0; i < 4; i++) {
      const doc = controls.document;
      doc.update({ ...doc.getFrame("board"), width: 320 + i * 4 });
      doc.update({ ...doc.getFrame("shadows"), width: 100 + i * 4 });
      doc.update({ ...doc.getFrame("text"), text: `Updated ${i}` });
      // Each change must actually render before its texture is replaced again.
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    }

    controls.document.removeMany(["image"]);
  });
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "gpuFixture").dispose());
  expect(errors).toEqual([]);
  expect(warnings).toEqual([]);
});

test("SVG nodes render, resize, update and undo without flattening their source", async ({
  page,
}) => {
  await mount(page);
  await expect(
    page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]"),
  ).toBeVisible();
  await page.evaluate(async () => {
    const module = "/packages/canvas/src/canvas-svg.ts";
    const { readCanvasSvg } = await import(/* @vite-ignore */ module);
    const { controls } = Reflect.get(window, "gpuFixture");
    controls.document.add({
      ...readCanvasSvg(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ff0000"/></svg>',
      ),
      id: "vector",
      x: 100,
      y: 450,
      width: 100,
      height: 100,
    });
  });
  await expect.poll(async () => (await pixels(page, [{ x: 150, y: 500 }]))[0]).toEqual([255, 0, 0]);
  await page.evaluate(async () => {
    const { controls } = Reflect.get(window, "gpuFixture");
    const node = controls.document.getFrame("vector");
    controls.document.update({
      ...node,
      width: 200,
      src: node.src.replace(
        node.src.split(",")[1],
        btoa(atob(node.src.split(",")[1]).replace("#ff0000", "#0000ff")),
      ),
    });
  });
  await expect.poll(async () => (await pixels(page, [{ x: 250, y: 500 }]))[0]).toEqual([0, 0, 255]);
  await page.evaluate(() => Reflect.get(window, "gpuFixture").controls.document.undo());
  await expect.poll(async () => (await pixels(page, [{ x: 150, y: 500 }]))[0]).toEqual([255, 0, 0]);
  expect(
    await page.evaluate(
      () => Reflect.get(window, "gpuFixture").controls.document.getFrame("vector").kind,
    ),
  ).toBe("svg");
});
