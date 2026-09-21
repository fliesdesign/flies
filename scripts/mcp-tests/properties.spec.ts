import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "propertiesFixture", fixture);
    fixture.controls.setPanelsOpen(true);
    fixture.controls.select("red");
  });

  return page.getByRole("complementary", { name: "Properties panel" });
}

async function node(page: Page, id = "red") {
  return page.evaluate(
    (frameId) => Reflect.get(window, "propertiesFixture").controls.document.getFrame(frameId),
    id,
  );
}

async function history(page: Page, action: "undo" | "redo") {
  await page.evaluate(
    (operation) => Reflect.get(window, "propertiesFixture").controls.document[operation](),
    action,
  );
}

test("border and shadow edits preview, cancel, undo, and survive project serialization", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const panel = await mount(page);
  await panel.getByRole("button", { name: "Add border", exact: true }).click();
  await expect.poll(async () => (await node(page)).borderWidth).toBe(1);
  const width = panel.getByRole("textbox", { name: "Border width", exact: true });
  await width.fill("5");
  await width.press("Enter");
  await expect.poll(async () => (await node(page)).borderWidth).toBe(5);
  await history(page, "undo");
  await expect(width).toHaveValue("1");
  await history(page, "redo");
  await expect(width).toHaveValue("5");

  await panel.getByRole("button", { name: "Border color picker" }).click();
  const picker = page.getByRole("dialog", { name: "Border color", exact: true });
  const color = picker.getByRole("textbox");
  await color.fill("#123456");
  await expect.poll(async () => (await node(page)).borderColor).toBe("#123456");
  await picker.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(async () => (await node(page)).borderColor).toBeUndefined();

  await panel.getByRole("button", { name: "Add shadow", exact: true }).click();
  await panel.getByRole("button", { name: "Add inner shadow", exact: true }).click();
  const blur = panel.getByRole("textbox", { name: "Shadow 1 blur", exact: true });
  await blur.fill("24");
  await blur.press("Enter");
  const innerSpread = panel.getByRole("textbox", { name: "Inner shadow 1 spread", exact: true });
  await innerSpread.fill("-3");
  await innerSpread.press("Enter");
  expect((await node(page)).shadows).toMatchObject([
    { blur: 24, inset: false },
    { spread: -3, inset: true },
  ]);

  const scrub = panel.getByRole("button", { name: "Adjust shadow 1 blur", exact: true });
  await scrub.scrollIntoViewIfNeeded();
  const bounds = (await scrub.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2);
  await expect(blur).toHaveValue("44");
  await page.mouse.up();
  await history(page, "undo");
  await expect(blur).toHaveValue("24");

  await panel.getByRole("button", { name: "Shadow", exact: true }).click();
  await expect(blur).toBeHidden();
  await panel.getByRole("button", { name: "Shadow", exact: true }).click();
  await expect(blur).toHaveValue("24");

  const roundTrip = await page.evaluate(async () => {
    const path = "/packages/canvas/src/canvas-project.ts";
    const { packCanvasProject, unpackCanvasProject } = await import(/* @vite-ignore */ path);
    const { document } = Reflect.get(window, "propertiesFixture").controls;

    const project = unpackCanvasProject(
      packCanvasProject("Effects", document.getFrames(), document.getTheme()),
    );

    return project.nodes.find((frame: { id: string }) => frame.id === "red");
  });

  expect(roundTrip.borderWidth).toBe(5);
  expect(roundTrip.shadows).toMatchObject([{ blur: 24 }, { spread: -3 }]);

  await panel.getByRole("button", { name: "Remove shadow 1", exact: true }).click();
  expect((await node(page)).shadows).toMatchObject([{ inset: true }]);
  await history(page, "undo");
  expect((await node(page)).shadows).toHaveLength(2);
  await page.screenshot({ path: testInfo.outputPath("properties-effects.png") });
  const fits = await panel.evaluate((element) => element.scrollWidth <= element.clientWidth);
  expect(fits).toBe(true);
  expect(errors).toEqual([]);
});

test("layout grid updates both axes in one undo and text style controls work", async ({
  page,
}, testInfo) => {
  const panel = await mount(page);
  await page.evaluate(() => Reflect.get(window, "propertiesFixture").controls.select("board"));
  await panel.getByRole("button", { name: "Vertical", exact: true }).click();
  await panel.getByRole("button", { name: "Align content middle right", exact: true }).click();
  await expect
    .poll(async () => (await node(page, "board")).layout)
    .toMatchObject({ direction: "column", align: "end", justify: "center" });
  await history(page, "undo");
  await expect
    .poll(async () => (await node(page, "board")).layout)
    .toMatchObject({ align: "start", justify: "start" });
  await history(page, "redo");
  await expect(panel.getByRole("button", { name: "Align content middle right" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({ path: testInfo.outputPath("properties-layout.png") });

  await page.evaluate(() => Reflect.get(window, "propertiesFixture").controls.select("text"));
  await panel.getByRole("button", { name: "Italic", exact: true }).click();
  await expect.poll(async () => (await node(page, "text")).fontStyle).toBe("italic");
  await panel.getByRole("button", { name: "Underline", exact: true }).click();
  await expect.poll(async () => (await node(page, "text")).textDecoration).toBe("underline");
  await panel.getByRole("button", { name: "Strikethrough", exact: true }).click();
  await expect.poll(async () => (await node(page, "text")).textDecoration).toBe("line-through");
  await history(page, "undo");
  await expect(panel.getByRole("button", { name: "Underline", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("rotation, gradients, blending and filters edit, undo and export through the panel", async ({
  page,
}, testInfo) => {
  const panel = await mount(page);
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "propertiesFixture");
    controls.document.update({
      ...controls.document.getFrame("red"),
      parentId: undefined,
      x: 460,
      y: 220,
      width: 120,
      height: 80,
    });
    controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
    controls.camera.flush();
  });
  const rotation = panel.getByRole("textbox", { name: "Rotation", exact: true });
  await rotation.fill("90");
  await rotation.press("Enter");
  await expect.poll(async () => (await node(page)).rotation).toBe(90);

  const before = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";
    const { worldCorners } = await import(/* @vite-ignore */ path);
    const doc = Reflect.get(window, "propertiesFixture").controls.document;

    return worldCorners(doc, doc.getFrame("red"));
  });

  const handle = page.getByRole("button", { name: "Resize Red from bottom right", exact: true });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 20);
  await page.mouse.up();
  await expect.poll(async () => (await node(page)).width).toBeCloseTo(140, 0);

  const after = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";
    const { worldCorners } = await import(/* @vite-ignore */ path);
    const doc = Reflect.get(window, "propertiesFixture").controls.document;

    return worldCorners(doc, doc.getFrame("red"));
  });

  expect(after[0].x).toBeCloseTo(before[0].x, 3);
  expect(after[0].y).toBeCloseTo(before[0].y, 3);
  await history(page, "undo");
  await expect.poll(async () => (await node(page)).width).toBe(120);
  await panel.getByRole("button", { name: "Linear fill", exact: true }).click();
  await panel.getByRole("button", { name: "Add color stop", exact: true }).click();
  const color = panel.getByRole("textbox", { name: "Gradient stop 2 color", exact: true });
  await color.fill("33669980");
  await color.press("Enter");
  await panel.getByRole("button", { name: "Radial fill", exact: true }).click();
  await panel.getByRole("combobox", { name: "Blend mode", exact: true }).selectOption("multiply");
  await panel.getByRole("button", { name: "Add filters", exact: true }).click();
  const brightness = panel.getByRole("textbox", { name: "Brightness filter", exact: true });
  await brightness.fill("150");
  await brightness.press("Enter");
  await expect.poll(async () => (await node(page)).filters?.brightness).toBe(1.5);

  const result = await page.evaluate(async () => {
    const path = "/src/lib/canvas-code-export.ts";
    const { exportCanvasCode } = await import(/* @vite-ignore */ path);
    const doc = Reflect.get(window, "propertiesFixture").controls.document;

    return exportCanvasCode(doc.getFrames(), ["red"], "CSS");
  });

  expect(result).toContain("rotate(90deg)");
  expect(result).toContain("radial-gradient");
  expect(result).toContain("#33669980");
  expect(result).toContain("mix-blend-mode: multiply");
  expect(result).toContain("brightness(1.5)");
  await page.screenshot({ path: testInfo.outputPath("properties-native-paint.png") });
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});

test("MCP native paint edits export real rotated gradient pixels and undo atomically", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const docPath = "/packages/canvas/src/canvas-document.ts",
      editorPath = "/src/lib/mcp/editor.ts",
      exportPath = "/src/components/canvas/canvas-export.tsx";

    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);

    const doc = new CanvasDocument([
      {
        id: "paint",
        kind: "rectangle",
        name: "Paint",
        x: 100,
        y: 100,
        width: 120,
        height: 80,
        fill: "#ff0000",
      },
    ]);

    const controls = { document: doc, prepare: () => {}, select: () => {}, getSelection: () => [] };
    await editorTool(controls, "update_node", {
      nodeId: "paint",
      properties: {
        rotation: 90,
        blendMode: "multiply",
        filters: { brightness: 0.5 },
        gradient: {
          type: "linear",
          angle: 90,
          stops: [
            { offset: 0, color: "#ff0000" },
            { offset: 1, color: "#0000ff" },
          ],
        },
      },
    });
    const painted = doc.getFrame("paint");
    const blob = await exportCanvasPng(doc.getFrames(), ["paint"]);

    const url = URL.createObjectURL(blob),
      image = new Image();

    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);

    const top = Array.from(ctx.getImageData(40, 10, 1, 1).data),
      bottom = Array.from(ctx.getImageData(40, 110, 1, 1).data);

    URL.revokeObjectURL(url);
    await editorTool(controls, "undo", {});
    const restored = doc.getFrame("paint");

    return { node: painted, restored, width: image.width, height: image.height, top, bottom };
  });

  expect(result.node).toMatchObject({
    rotation: 90,
    blendMode: "multiply",
    filters: { brightness: 0.5 },
  });
  expect(result.restored.rotation).toBeUndefined();
  expect(result.restored.gradient).toBeUndefined();
  expect([result.width, result.height]).toEqual([80, 120]);
  expect(result.top[0]).toBeGreaterThan(100);
  expect(result.top[0]).toBeLessThan(128);
  expect(result.top[2]).toBeLessThan(20);
  expect(result.bottom[2]).toBeGreaterThan(100);
  expect(result.top[3]).toBe(255);
});
