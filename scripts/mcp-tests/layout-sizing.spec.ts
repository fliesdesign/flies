import { expect, test } from "@playwright/test";

test("MCP sizing and canvas spacing edits share resolved geometry, panel values and undo", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const harnessPath = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const editorPath = "/src/lib/mcp/editor.ts";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ harnessPath);
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const fixture = await mountSnapshotFixture();
    Reflect.set(window, "layoutFixture", fixture);
    Reflect.set(window, "layoutEditorTool", editorTool);
    const { controls } = fixture;
    controls.document.addMany([
      {
        id: "page",
        name: "Page",
        x: 300,
        y: 100,
        width: 400,
        height: 400,
        layout: { direction: "column", gap: 20, padding: 20, align: "start", justify: "start" },
      },
      {
        id: "section",
        name: "Section",
        parentId: "page",
        x: 320,
        y: 120,
        width: 200,
        height: 160,
        layout: { direction: "column", gap: 10, padding: 10, align: "start", justify: "start" },
      },
      {
        id: "first",
        name: "First",
        parentId: "section",
        kind: "rectangle",
        fill: "#111111",
        x: 330,
        y: 130,
        width: 100,
        height: 40,
      },
      {
        id: "second",
        name: "Second",
        parentId: "section",
        kind: "rectangle",
        fill: "#333333",
        x: 330,
        y: 180,
        width: 80,
        height: 60,
      },
    ]);
    controls.setPanelsOpen(true);
    controls.select("section");
    await editorTool(controls, "update_node", {
      nodeId: "section",
      properties: { widthSizing: "fill", heightSizing: "hug" },
    });
  });

  const panel = page.getByRole("complementary", { name: "Properties panel" });
  await expect(panel.getByRole("textbox", { name: "Width", exact: true })).toHaveValue("360");
  await expect(panel.getByRole("textbox", { name: "Height", exact: true })).toHaveValue("130");
  await expect(panel.getByRole("combobox", { name: "Width sizing", exact: true })).toHaveValue(
    "fill",
  );
  await expect(panel.getByRole("combobox", { name: "Height sizing", exact: true })).toHaveValue(
    "hug",
  );

  const gap = panel.getByRole("textbox", { name: "Layout gap", exact: true });
  await gap.fill("24");
  await gap.press("Enter");
  await expect(panel.getByRole("textbox", { name: "Height", exact: true })).toHaveValue("144");

  const info = await page.evaluate(async () => {
    const { controls } = Reflect.get(window, "layoutFixture");
    const editorTool = Reflect.get(window, "layoutEditorTool");
    const result = await editorTool(controls, "get_node_info", { nodeId: "section" });
    await editorTool(controls, "undo", {});

    return JSON.parse(result.content[0].text);
  });

  expect(info.node).toMatchObject({
    width: 360,
    height: 144,
    widthSizing: "fill",
    heightSizing: "hug",
    layout: { gap: 24 },
  });
  expect(info.worldBounds).toEqual({ x: 320, y: 120, width: 360, height: 144 });
  await expect(gap).toHaveValue("10");
  await expect(panel.getByRole("textbox", { name: "Height", exact: true })).toHaveValue("130");
});
