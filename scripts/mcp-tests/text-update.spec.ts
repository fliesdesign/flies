import { expect, test } from "@playwright/test";

test("agent copy and typography edits reflow actual wrapped text, persist, and undo atomically", async ({
  page,
}) => {
  await page.goto("/");

  const before = await page.evaluate(async () => {
    const harness = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const tools = "/src/lib/mcp/editor.ts";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ harness);
    const { editorTool } = await import(/* @vite-ignore */ tools);
    const { controls } = await mountSnapshotFixture();
    Reflect.set(window, "textControls", controls);
    Reflect.set(window, "textTool", editorTool);
    controls.document.addMany([
      {
        id: "card",
        name: "Card",
        x: 100,
        y: 100,
        width: 340,
        height: 100,
        heightSizing: "hug",
        fill: "#fff",
        layout: { direction: "column", gap: 16, padding: 20, align: "start", justify: "start" },
      },
      {
        id: "copy",
        name: "Copy",
        parentId: "card",
        kind: "text",
        x: 120,
        y: 120,
        width: 300,
        height: 25,
        fontSize: 20,
        text: "Then keep going",
        color: "#111",
        fontFamily: "Arial",
      },
    ]);

    return controls.document.getFrames();
  });

  const result = await page.evaluate(async () => {
    const controls = Reflect.get(window, "textControls");
    const tool = Reflect.get(window, "textTool");

    return JSON.parse(
      (
        await tool(controls, "update_node", {
          nodeId: "copy",
          properties: {
            text: "Then keep going by hand. Keep every word visible as the text grows and wraps.",
            fontSize: 30,
            width: 900,
            widthSizing: "fill",
          },
        })
      ).content[0].text,
    );
  });

  expect(result.node.height).toBeGreaterThan(100);
  expect(result.node.width).toBe(300);
  expect(result.warnings).toEqual([]);

  const content = page.locator(
    '[data-snapshot-fixture] [data-frame-id="copy"] .canvas-text-content',
  );

  await expect(content).toHaveText(
    "Then keep going by hand. Keep every word visible as the text grows and wraps.",
  );
  expect(
    await content.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
  ).toBe(true);

  const saved = await page.evaluate(() =>
    Reflect.get(window, "textControls").document.getCommittedFrames(),
  );

  expect(saved.find((node: { id: string }) => node.id === "card").height).toBe(
    result.node.height + 40,
  );
  await page.evaluate(async () =>
    Reflect.get(window, "textTool")(Reflect.get(window, "textControls"), "undo", {}),
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "textControls").document.getFrames()),
  ).toEqual(before);
  await page.evaluate(async () =>
    Reflect.get(window, "textTool")(Reflect.get(window, "textControls"), "redo", {}),
  );
  expect(
    await page.evaluate(() => Reflect.get(window, "textControls").document.getCommittedFrames()),
  ).toEqual(saved);

  const cropped = await page.evaluate(async () =>
    JSON.parse(
      (
        await Reflect.get(window, "textTool")(Reflect.get(window, "textControls"), "update_node", {
          nodeId: "copy",
          properties: { height: 25 },
        })
      ).content[0].text,
    ),
  );

  expect(cropped.node.height).toBe(25);
  expect(
    cropped.warnings.some((warning: { code: string }) => warning.code === "text_overflow"),
  ).toBe(true);
});
