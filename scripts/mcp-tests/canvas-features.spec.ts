import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

const canvasModulePath = `/@fs${fileURLToPath(new URL("../../packages/canvas/src/index.ts", import.meta.url))}`;

async function mount(page: Page, firefly: boolean) {
  await page.goto("/");
  await page.evaluate(
    async ({ useFirefly, canvasPath }) => {
      const harnessPath = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
      const { mountSnapshotFixture } = await import(/* @vite-ignore */ harnessPath);
      const fixture = await mountSnapshotFixture();
      Reflect.set(window, "canvasFeatures", fixture);
      const { setCanvasInspection } = await import(/* @vite-ignore */ canvasPath);
      setCanvasInspection(!useFirefly);
      fixture.controls.document.replaceAll([
        {
          id: "board",
          name: "Responsive card",
          x: 300,
          y: 100,
          width: 350,
          height: 300,
          fill: "#ffffff",
        },
        {
          id: "label",
          name: "Headline",
          kind: "text",
          parentId: "board",
          x: 320,
          y: 120,
          width: 260,
          height: 40,
          text: "Hello canvas",
          fontSize: 24,
          color: "#161616",
        },
      ]);
      fixture.controls.setPanelsOpen(true);
      fixture.controls.select("board");
    },
    { useFirefly: firefly, canvasPath: canvasModulePath },
  );
  if (firefly)
    await expect(
      page.locator("[data-snapshot-fixture] canvas[data-renderer=webgl2]"),
    ).toBeVisible();
}

async function tool(page: Page, name: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ name: toolName, args: input }) => {
      const editorPath = "/src/lib/mcp/editor.ts";
      const { editorTool } = await import(/* @vite-ignore */ editorPath);

      const result = await editorTool(
        Reflect.get(window, "canvasFeatures").controls,
        toolName,
        input,
      );

      if (result.isError) throw new Error(JSON.stringify(result));

      return JSON.parse(result.content[0].text);
    },
    { name, args },
  );
}

async function pixel(page: Page, x: number, y: number) {
  const screenshot = await page.locator("[data-snapshot-fixture]").screenshot();

  return page.evaluate(
    async ({ png, px, py }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const host = document.querySelector("[data-snapshot-fixture]")!.getBoundingClientRect();

      const surface = document
        .querySelector("[data-snapshot-fixture] .design-canvas")!
        .getBoundingClientRect();

      const { viewport } = Reflect.get(window, "canvasFeatures").controls.camera.getCurrent();
      const scale = image.width / host.width;

      const screenX = Math.floor(
        (surface.left - host.left + viewport.x + px * viewport.zoom) * scale,
      );

      const screenY = Math.floor(
        (surface.top - host.top + viewport.y + py * viewport.zoom) * scale,
      );

      return [...context.getImageData(screenX, screenY, 1, 1).data].slice(0, 3);
    },
    { png: screenshot.toString("base64"), px: x, py: y },
  );
}

for (const renderer of ["DOM", "Firefly"] as const) {
  test(`${renderer}: responsive panel edits and MCP resizing share resolved layout and undo`, async ({
    page,
  }, testInfo) => {
    await mount(page, renderer === "Firefly");
    await page.evaluate(() => {
      const { controls } = Reflect.get(window, "canvasFeatures");
      controls.document.remove("label");
      controls.document.addMany(
        [0, 1, 2].map((index) => ({
          id: `item-${index}`,
          name: `Item ${index + 1}`,
          kind: "rectangle",
          parentId: "board",
          x: 0,
          y: 0,
          width: 80,
          height: 40,
          fill: "#6155f5",
        })),
      );
    });
    await tool(page, "update_node", {
      nodeId: "board",
      properties: {
        width: 240,
        heightSizing: "hug",
        layout: { direction: "row", padding: 10, gap: 10, rowGap: 24 },
      },
    });
    const panel = page.getByRole("complementary", { name: "Properties panel" });
    await panel.getByRole("checkbox", { name: "Wrap layout" }).check();
    const left = panel.getByRole("textbox", { name: "Left padding", exact: true });
    await left.fill("20");
    await left.press("Enter");
    await expect(panel.getByRole("textbox", { name: "Height", exact: true })).toHaveValue("124");
    expect((await tool(page, "get_node_info", { nodeId: "item-2" })).node.y).toBe(174);
    await expect(page.locator('[data-layout-handle="line-gap-1"]')).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("responsive-layout.png") });
    await tool(page, "undo");
    await expect(left).toHaveValue("10");
    await tool(page, "update_node", { nodeId: "board", properties: { layout: null } });
    await tool(page, "set_selection", { nodeId: "item-0" });
    await panel.getByRole("checkbox", { name: "Resize with parent" }).check();
    await panel.getByRole("combobox", { name: "Horizontal resize constraint" }).selectOption("end");
    const before = (await tool(page, "get_node_info", { nodeId: "item-0" })).node.x;
    await tool(page, "update_node", { nodeId: "board", properties: { width: 400 } });
    expect((await tool(page, "get_node_info", { nodeId: "item-0" })).node.x).toBe(before + 160);
    await tool(page, "undo");
    expect((await tool(page, "get_node_info", { nodeId: "item-0" })).node.x).toBe(before);
  });

  test(`${renderer}: component controls and rich MCP edits retain formatting across reset, save and undo`, async ({
    page,
  }, testInfo) => {
    await mount(page, renderer === "Firefly");
    const panel = page.getByRole("complementary", { name: "Properties panel" });
    await panel.getByRole("button", { name: "Create component", exact: true }).click();
    await panel.getByRole("button", { name: "Create instance", exact: true }).click();

    const { instanceId, labelId } = await page.evaluate(() => {
      const { controls } = Reflect.get(window, "canvasFeatures");
      const selectedInstance = controls.getSelection()[0];

      const label = controls.document
        .getFrames()
        .find(
          (node: { parentId?: string; componentSourceId?: string }) =>
            node.parentId === selectedInstance && node.componentSourceId === "label",
        );

      return { instanceId: selectedInstance, labelId: label.id };
    });

    const textRuns = [
      {
        start: 0,
        end: 5,
        color: "#e11d48",
        fontWeight: 700,
        textDecoration: "underline",
        href: "https://example.com",
      },
    ];

    await tool(page, "update_node", { nodeId: "label", properties: { textRuns } });
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.textRuns).toEqual(
      textRuns,
    );
    await tool(page, "update_node", { nodeId: labelId, properties: { text: "Local canvas" } });
    await tool(page, "set_selection", { nodeId: instanceId });
    await expect(panel.getByText("1 layer override", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Save as variant", exact: true }).click();
    await panel.getByRole("textbox", { name: "Variant name" }).fill("Local copy");
    await panel.getByRole("button", { name: "Save variant", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "Component variant" })).not.toHaveValue("");

    const roundTrip = await page.evaluate(async (path) => {
      const { saveCanvasFrames, loadCanvasFrames } = await import(/* @vite-ignore */ path);
      const { controls } = Reflect.get(window, "canvasFeatures");
      const before = controls.document.getFrames();
      let stored = "";
      saveCanvasFrames(before, {
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      });

      return { before, after: loadCanvasFrames({ getItem: () => stored }) };
    }, canvasModulePath);

    expect(roundTrip.after).toEqual(roundTrip.before);
    await page.screenshot({ path: testInfo.outputPath("component-rich-text.png") });
    await tool(page, "undo");
    expect(
      (await tool(page, "get_node_info", { nodeId: instanceId })).node.instance.overrides,
    ).toHaveLength(1);
    await panel.getByRole("button", { name: "Reset overrides", exact: true }).click();
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.text).toBe("Hello canvas");
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.textRuns).toEqual(
      textRuns,
    );
    const longText = "Long instance copy must keep its measured height after wrapping. ".repeat(6);
    await tool(page, "update_node", { nodeId: labelId, properties: { text: longText } });
    const grown = (await tool(page, "get_node_info", { nodeId: labelId })).node;
    expect(grown.height).toBeGreaterThan(40);

    const local = (await tool(page, "get_node_info", { nodeId: instanceId })).node.instance
      .overrides[0];

    expect(local.textHeight).toBe(grown.height);
    await tool(page, "update_node", {
      nodeId: "label",
      properties: { text: "Updated source", height: 48 },
    });
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.height).toBe(grown.height);
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.text).toBe(longText);
    await tool(page, "reset_instance", { nodeId: instanceId });
    expect((await tool(page, "get_node_info", { nodeId: labelId })).node.height).toBe(48);
  });

  test(`${renderer}: native crop, alpha masks and editable vectors change live artwork`, async ({
    page,
  }, testInfo) => {
    await mount(page, renderer === "Firefly");
    await page.evaluate(() => {
      const { controls } = Reflect.get(window, "canvasFeatures");
      const image = document.createElement("canvas");
      image.width = 20;
      image.height = 10;
      const context = image.getContext("2d")!;
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 10, 10);
      context.fillStyle = "#0000ff";
      context.fillRect(10, 0, 10, 10);
      controls.document.addMany([
        {
          id: "image",
          name: "Image",
          kind: "image",
          parentId: "board",
          x: 400,
          y: 170,
          width: 160,
          height: 100,
          src: image.toDataURL(),
        },
        {
          id: "mask",
          name: "Mask",
          kind: "rectangle",
          parentId: "board",
          x: 480,
          y: 170,
          width: 80,
          height: 100,
          fill: "#ffffff",
        },
      ]);
      controls.select(null);
    });
    await tool(page, "update_node", {
      nodeId: "image",
      properties: { crop: { x: 0.5, y: 0, width: 0.5, height: 1 }, maskId: "mask" },
    });
    await expect.poll(() => pixel(page, 420, 200)).toEqual([255, 255, 255]);
    await expect.poll(() => pixel(page, 520, 200)).toEqual([0, 0, 255]);

    const vector = {
      viewWidth: 80,
      viewHeight: 60,
      fill: "#ff0000",
      stroke: "none",
      strokeWidth: 0,
      contours: [
        {
          closed: true,
          anchors: [
            { x: 0, y: 0 },
            { x: 80, y: 0 },
            { x: 80, y: 60 },
            { x: 0, y: 60 },
          ],
        },
      ],
    };

    const { nodeId } = await tool(page, "create_vector", {
      parentId: "board",
      name: "Editable shape",
      x: 340,
      y: 300,
      vector,
    });

    await tool(page, "set_selection");
    await expect.poll(() => pixel(page, 380, 330)).toEqual([255, 0, 0]);
    await tool(page, "update_node", {
      nodeId,
      properties: { vector: { ...vector, fill: "#00ff00" } },
    });
    await expect.poll(() => pixel(page, 380, 330)).toEqual([0, 255, 0]);
    await page.screenshot({ path: testInfo.outputPath("crop-mask-vector.png") });
    await tool(page, "undo");
    await expect.poll(() => pixel(page, 380, 330)).toEqual([255, 0, 0]);
  });
}
