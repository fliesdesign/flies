import { expect, test, type Page } from "@playwright/test";

const artwork = "[data-gpu-fixture] .canvas-webgl-surface[data-renderer=webgl2]";

async function mount(page: Page) {
  await page.goto("/recents");
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "mcpParityFixture", fixture);
    fixture.controls.document.replaceAll([
      { id: "home", kind: "page", name: "Home", x: 0, y: 0, width: 0, height: 0 },
    ]);
    fixture.controls.showPage("home");
    fixture.controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
    fixture.controls.camera.flush();
  });
  await expect(page.locator(artwork)).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
}

async function tool(page: Page, name: string, args: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ toolName, arguments: toolArguments }) => {
      const path = "/src/lib/mcp/editor.ts";
      const { editorTool } = await import(/* @vite-ignore */ path);
      const fixture = Reflect.get(window, "mcpParityFixture");
      const result = await editorTool(fixture.controls, toolName, toolArguments);
      if (result.isError) throw new Error(JSON.stringify(result));

      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
    { toolName: name, arguments: args },
  );
}

async function centerPixel(page: Page) {
  // Read the displayed canvas through a screenshot, not the HTML export path.
  const screenshot = await page.locator("[data-gpu-fixture]").screenshot();

  return page.evaluate(async (png) => {
    const image = new Image();
    image.src = `data:image/png;base64,${png}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);

    return [...context.getImageData(300, 200, 1, 1).data].slice(0, 3);
  }, screenshot.toString("base64"));
}

async function documentState(page: Page, nodeId: string) {
  return page.evaluate((id) => {
    const { controls } = Reflect.get(window, "mcpParityFixture");

    return {
      node: controls.document.getFrame(id),
      committed: controls.document
        .getCommittedFrames()
        .find((node: { id: string }) => node.id === id),
      selection: controls.getSelection(),
      activePageId: controls.document.getActivePageId(),
      sceneIds: controls.document.getSceneIds(),
    };
  }, nodeId);
}

async function resetCamera(page: Page) {
  await page.evaluate(() => {
    const { camera } = Reflect.get(window, "mcpParityFixture").controls;
    camera.setViewport({ x: 0, y: 0, zoom: 1 });
    camera.flush();
  });
}

test("MCP mutations repaint Firefly and share selection and undo with the live editor", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page);

  const { nodeId } = await tool(page, "create_artboard", {
    name: "MCP board",
    x: 200,
    y: 120,
    width: 320,
    height: 240,
    fill: "#ff0000",
  });

  const id = String(nodeId);
  await expect.poll(() => centerPixel(page)).toEqual([255, 0, 0]);
  expect(await documentState(page, id)).toMatchObject({
    node: { id, fill: "#ff0000", parentId: "home" },
    committed: { id, fill: "#ff0000" },
    selection: [id],
  });

  await tool(page, "update_node", { nodeId: id, properties: { fill: "#00ff00" } });
  await expect.poll(() => centerPixel(page)).toEqual([0, 255, 0]);
  expect((await documentState(page, id)).committed).toMatchObject({ fill: "#00ff00" });

  await tool(page, "set_theme", {
    tokens: [{ id: "brand", name: "Brand", type: "color", value: "#0080ff" }],
  });
  await tool(page, "apply_tokens", { nodeIds: [id], bindings: { fill: "brand" } });
  await expect.poll(() => centerPixel(page)).toEqual([0, 128, 255]);
  expect((await documentState(page, id)).committed).toMatchObject({
    fill: "#0080ff",
    tokenBindings: { fill: "brand" },
  });

  await tool(page, "set_theme", {
    tokens: [{ id: "brand", name: "Brand", type: "color", value: "#ff8000" }],
  });
  await expect.poll(() => centerPixel(page)).toEqual([255, 128, 0]);
  await tool(page, "undo");
  await expect.poll(() => centerPixel(page)).toEqual([0, 128, 255]);

  // A native editor shortcut redoes the same transaction an MCP undo just reversed.
  await page.getByRole("application", { name: "Design canvas" }).focus();
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(() => centerPixel(page)).toEqual([255, 128, 0]);
  expect((await documentState(page, id)).committed).toMatchObject({ fill: "#ff8000" });

  await tool(page, "set_selection");
  await expect.poll(async () => (await documentState(page, id)).selection).toEqual([]);
  await tool(page, "set_selection", { nodeId: id });
  await expect.poll(async () => (await documentState(page, id)).selection).toEqual([id]);
  await expect(page.locator("[data-gpu-fixture] .canvas-selection")).toBeVisible();
  await expect(page.locator(artwork)).toBeVisible();
  expect(errors).toEqual([]);
});

test("MCP page switching replaces Firefly artwork while retaining both pages in the document", async ({
  page,
}) => {
  await mount(page);
  const geometry = { x: 200, y: 120, width: 320, height: 240 };

  const home = await tool(page, "create_artboard", {
    ...geometry,
    name: "Home artwork",
    fill: "#ff0000",
  });

  await expect.poll(() => centerPixel(page)).toEqual([255, 0, 0]);
  const next = await tool(page, "create_page", { name: "Drafts" });

  const draft = await tool(page, "create_artboard", {
    ...geometry,
    name: "Draft artwork",
    fill: "#0000ff",
  });

  await resetCamera(page);
  await expect.poll(() => centerPixel(page)).toEqual([0, 0, 255]);
  expect(await documentState(page, String(draft.nodeId))).toMatchObject({
    activePageId: next.pageId,
    node: { parentId: next.pageId },
    sceneIds: [draft.nodeId],
  });

  await tool(page, "set_page", { pageId: "home" });
  await resetCamera(page);
  await expect.poll(() => centerPixel(page)).toEqual([255, 0, 0]);
  expect(await documentState(page, String(home.nodeId))).toMatchObject({
    activePageId: "home",
    selection: [],
    sceneIds: [home.nodeId],
  });
  expect((await documentState(page, String(draft.nodeId))).committed).toMatchObject({
    parentId: next.pageId,
    fill: "#0000ff",
  });

  await tool(page, "set_page", { pageId: next.pageId });
  await resetCamera(page);
  await expect.poll(() => centerPixel(page)).toEqual([0, 0, 255]);
  await expect(page.locator(artwork)).toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
});
