import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "audit", fixture);
    fixture.controls.document.replaceAll([
      { id: "home", name: "First", kind: "page", x: 0, y: 0, width: 0, height: 0 },
      {
        id: "rect",
        name: "Original",
        kind: "rectangle",
        parentId: "home",
        x: 200,
        y: 200,
        width: 80,
        height: 80,
        fill: "#ff0000",
      },
      { id: "second", name: "Second", kind: "page", x: 0, y: 0, width: 0, height: 0 },
    ]);
  });
}

test("drawing a frame around page-root artwork should adopt it", async ({ page }) => {
  await mount(page);
  await page.getByRole("button", { name: "Frame (F)", exact: true }).click();
  await page.mouse.move(150, 150);
  await page.mouse.down();
  await page.mouse.move(400, 400, { steps: 10 });
  await page.mouse.up();

  const result = await page.evaluate(() => {
    const doc = Reflect.get(window, "audit").controls.document;

    return {
      rect: doc.getFrame("rect"),
      frame: doc.getFrames().find((node: { kind: string }) => node.kind === "frame"),
    };
  });

  expect(result.frame).toBeDefined();
  expect(result.rect.parentId).toBe(result.frame.id);
});

test("paste in place after switching pages should paste on the current page", async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const path = "/packages/canvas/src/canvas-operations.ts";
    const { encodeCanvasClipboard } = await import(/* @vite-ignore */ path);
    const { controls } = Reflect.get(window, "audit");
    const payload = encodeCanvasClipboard(controls.document.getFrames(), ["rect"]);
    Object.defineProperty(navigator.clipboard, "read", {
      configurable: true,
      value: async () => [
        new ClipboardItem({ "text/plain": new Blob([payload], { type: "text/plain" }) }),
      ],
    });
    controls.showPage("second");
    controls.surface.focus();
  });
  await page.keyboard.press("ControlOrMeta+Shift+v");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, "audit")
            .controls.document.getFrames()
            .filter((node: { kind: string }) => node.kind === "rectangle").length,
      ),
    )
    .toBe(2);

  const added = await page.evaluate(() =>
    Reflect.get(window, "audit")
      .controls.document.getFrames()
      .find(
        (node: { kind: string; id: string }) => node.kind === "rectangle" && node.id !== "rect",
      ),
  );

  expect(added.parentId).toBe("second");
});

test("visible descendants of visibility-hidden containers should import", async ({ page }) => {
  await page.goto("/");

  const nodes = await page.evaluate(async () => {
    const path = "/packages/html/src/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);

    return importHtml(
      '<main style="width:400px;height:300px;background:white"><div style="visibility:hidden"><span style="visibility:visible">Visible child</span></div></main>',
      { x: 0, y: 0, width: 400 },
    );
  });

  expect(nodes.some((node: { text?: string }) => node.text === "Visible child")).toBe(true);
});

test("static z-index should not change imported paint order", async ({ page }) => {
  await page.goto("/");

  const nodes = await page.evaluate(async () => {
    const path = "/packages/html/src/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);

    return importHtml(
      '<main style="width:400px;height:300px;background:white"><div data-name="Red" style="width:100px;height:100px;background:red;z-index:10"></div><div data-name="Blue" style="width:100px;height:100px;background:blue;margin-top:-100px"></div></main>',
      { x: 0, y: 0, width: 400 },
    );
  });

  expect(
    nodes
      .filter((node: { name: string }) => ["Red", "Blue"].includes(node.name))
      .map((node: { name: string }) => node.name),
  ).toEqual(["Red", "Blue"]);
});

test("MCP deletion should reject a layer belonging to another page", async ({ page }) => {
  await mount(page);

  const result = await page.evaluate(async () => {
    const path = "/src/lib/mcp/editor.ts";
    const { editorTool } = await import(/* @vite-ignore */ path);
    const { controls } = Reflect.get(window, "audit");
    controls.showPage("second");

    try {
      await editorTool(controls, "delete_nodes", { nodeIds: ["rect"] });
    } catch {}

    return controls.document.getFrame("rect") ?? null;
  });

  expect(result).not.toBeNull();
});

test("deleting the active page should render and hit-test the fallback page", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "audit");
    controls.showPage("second");
    controls.removePage("second");
    controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
    controls.camera.flush();
  });
  expect(
    await page.evaluate(() => Reflect.get(window, "audit").controls.document.getActivePageId()),
  ).toBe("home");
  await expect(page.getByRole("button", { name: "Original, 80 by 80", exact: true })).toBeVisible();
});

test("HTML paint order respects positioned and flex/grid z-index but ignores static z-index", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const htmlPath = "/packages/html/src/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ htmlPath);

    const colors =
      '<div data-name="Red" style="width:100px;height:100px;background:red;z-index:10;POSITION"></div><div data-name="Blue" style="width:100px;height:100px;background:blue;margin-top:-100px"></div>';

    const importOrder = async (layout: string, position: string) => {
      const nodes = await importHtml(
        `<main style="width:400px;height:300px;background:white;${layout}">${colors.replace("POSITION", position)}</main>`,
        { x: 0, y: 0, width: 400 },
      );

      return nodes
        .filter((node: { name: string }) => ["Red", "Blue"].includes(node.name))
        .map((node: { name: string }) => node.name);
    };

    return {
      static: await importOrder("", "order:10"),
      positioned: await importOrder("", "position:relative"),
      flex: await importOrder("display:flex;flex-direction:column", ""),
      grid: await importOrder("display:grid", ""),
    };
  });

  expect(result.static).toEqual(["Red", "Blue"]);
  expect(result.positioned).toEqual(["Blue", "Red"]);
  expect(result.flex).toEqual(["Blue", "Red"]);
  expect(result.grid).toEqual(["Blue", "Red"]);
});

test("visible children retain hidden ancestors' transform, opacity and clipping without painting their background", async ({
  page,
}) => {
  await page.goto("/");

  const pixels = await page.evaluate(async () => {
    const htmlPath = "/packages/html/src/html.ts";
    const exportPath = "/src/components/canvas/canvas-export.tsx";
    const { importHtml } = await import(/* @vite-ignore */ htmlPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);

    const nodes = await importHtml(
      '<main style="width:400px;height:300px;background:white"><div data-name="Hidden container" style="visibility:hidden;width:150px;height:100px;background:red;opacity:.5;transform:translate(20px,10px);overflow:hidden"><span style="visibility:visible;display:block;width:80px;height:150px;background:blue">Visible child</span></div></main>',
      { x: 0, y: 0, width: 400 },
    );

    const blob = await exportCanvasPng(nodes, [nodes[0].id]);
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);

    const samples = [
      [30, 50],
      [120, 50],
      [30, 120],
      [10, 50],
    ].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3));

    bitmap.close();

    return samples;
  });

  // PNG rasterization can round alpha/color channels by one or two levels.
  [128, 128, 255].forEach((channel, index) =>
    expect(Math.abs(pixels[0][index] - channel)).toBeLessThanOrEqual(2),
  );
  expect(pixels.slice(1)).toEqual([
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
  ]);
});
