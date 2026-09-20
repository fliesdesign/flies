import assert from "node:assert/strict";

import { CanvasDocument } from "@flies/canvas";
import { test } from "vite-plus/test";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { editorTool } from "./editor";

function fixture() {
  const document = new CanvasDocument([
    { id: "frame", name: "Frame", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "text",
      name: "Text",
      parentId: "frame",
      kind: "text",
      x: 10,
      y: 10,
      width: 100,
      height: 20,
      text: "Hello",
      fontSize: 16,
      color: "#000000",
    },
  ]);
  let selected: string[] = [];
  const controls = {
    document,
    prepare: () => {},
    select: (id: string | null) => {
      selected = id ? [id] : [];
    },
    getSelection: () => selected,
  } as unknown as CanvasControls;
  return { document, controls };
}

test("MCP edits share undo history and validate before changing the document", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "update_node", { nodeId: "text", properties: { text: "Changed" } });
  assert.equal((document.getFrame("text") as { text: string }).text, "Changed");
  await editorTool(controls, "undo", {});
  assert.equal((document.getFrame("text") as { text: string }).text, "Hello");
  await assert.rejects(
    editorTool(controls, "update_node", { nodeId: "text", properties: { width: -1 } }),
  );
  assert.equal(document.getFrame("text")?.width, 100);
  await assert.rejects(
    editorTool(controls, "update_node", { nodeId: "text", properties: { id: "other" } }),
  );
  assert.ok(document.getFrame("text"));
});

test("MCP deleting a parent deletes descendants in one undo step", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "delete_nodes", { nodeIds: ["frame"] });
  assert.deepEqual(document.getIds(), []);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getIds(), ["frame", "text"]);
});

test("MCP refuses missing IDs and cyclic parents without partial changes", async () => {
  const { document, controls } = fixture();
  await assert.rejects(editorTool(controls, "delete_nodes", { nodeIds: ["text", "missing"] }));
  await assert.rejects(
    editorTool(controls, "update_node", { nodeId: "frame", properties: { parentId: "frame" } }),
  );
  assert.deepEqual(document.getIds(), ["frame", "text"]);
});

test("MCP creates real editable artboards and selection is readable", async () => {
  const { document, controls } = fixture();
  const result = await editorTool(controls, "create_artboard", {
    name: "New",
    width: 640,
    height: 480,
  });
  const id = JSON.parse((result.content[0] as { text: string }).text).nodeId;
  assert.equal(document.getFrame(id)?.name, "New");
  const selection = await editorTool(controls, "get_selection", {});
  assert.deepEqual(JSON.parse((selection.content[0] as { text: string }).text), { nodeIds: [id] });
  await editorTool(controls, "undo", {});
  assert.equal(document.getFrame(id), undefined);
});

function nestedFixture() {
  const { controls } = fixture();
  const document = new CanvasDocument([
    { id: "frame", name: "Page", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "group",
      name: "Section",
      kind: "group",
      parentId: "frame",
      x: 20,
      y: 30,
      width: 180,
      height: 80,
    },
    {
      id: "nested",
      name: "Content",
      kind: "frame",
      parentId: "group",
      x: 20,
      y: 30,
      width: 100,
      height: 80,
    },
    {
      id: "text",
      name: "Heading",
      kind: "text",
      parentId: "nested",
      x: 25,
      y: 35,
      width: 90,
      height: 20,
      text: "Hello",
      fontSize: 16,
      color: "#000000",
    },
    {
      id: "shape",
      name: "Shape",
      kind: "rectangle",
      parentId: "group",
      x: 150,
      y: 40,
      width: 50,
      height: 30,
      fill: "#ffffff",
    },
    { id: "other", name: "Other page", x: 500, y: 60, width: 400, height: 300 },
  ]);
  return { document, controls: { ...controls, document } };
}

for (const nodeId of ["frame", "group"]) {
  test(`MCP moving a ${nodeId} translates its nested contents exactly once with one undo`, async () => {
    const { document, controls } = nestedFixture();
    const original = document.getFrames();
    const before = document.getFrame(nodeId)!;
    const movedIds = new Set(document.getDescendantIds([nodeId]));
    await editorTool(controls, "update_node", {
      nodeId,
      properties: { x: before.x + 120, y: before.y - 45 },
    });
    for (const node of original) {
      assert.deepEqual(
        document.getFrame(node.id),
        movedIds.has(node.id) ? { ...node, x: node.x + 120, y: node.y - 45 } : node,
      );
    }
    assert.equal(document.getHistoryStats().undoEntries, 1);
    await editorTool(controls, "undo", {});
    assert.deepEqual(document.getFrames(), original);
    assert.equal(document.getSnapshot().canUndo, false);
  });
}

test("MCP resizing a frame preserves its contents' sizes and positions", async () => {
  const { document, controls } = nestedFixture();
  const contents = document.getFrames().filter((node) => node.id !== "frame");
  await editorTool(controls, "update_node", {
    nodeId: "frame",
    properties: { width: 800, height: 600 },
  });
  assert.equal(document.getFrame("frame")?.width, 800);
  assert.deepEqual(
    document.getFrames().filter((node) => node.id !== "frame"),
    contents,
  );
});

test("MCP rejects an invalid container move without moving descendants or changing history", async () => {
  const { document, controls } = nestedFixture();
  const original = document.getFrames();
  const snapshot = document.getSnapshot();
  await assert.rejects(
    editorTool(controls, "update_node", {
      nodeId: "frame",
      properties: { x: 120, y: 60, width: -1 },
    }),
  );
  assert.deepEqual(document.getFrames(), original);
  assert.deepEqual(document.getSnapshot(), snapshot);
});

test("MCP rejects translated descendant overflow without moving the valid parent", async () => {
  const { controls } = fixture();
  const document = new CanvasDocument([
    { id: "frame", name: "Frame", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "far",
      name: "Distant child",
      parentId: "frame",
      x: Number.MAX_VALUE,
      y: 0,
      width: 40,
      height: 40,
    },
  ]);
  const original = document.getFrames();
  await assert.rejects(
    editorTool({ ...controls, document }, "update_node", {
      nodeId: "frame",
      properties: { x: Number.MAX_VALUE },
    }),
  );
  assert.deepEqual(document.getFrames(), original);
  assert.equal(document.getSnapshot().canUndo, false);
});

test("fit_node hugs content, enables clipping and preserves child IDs with undo", async () => {
  const { controls, document } = fixture();
  document.update({ ...document.getFrame("frame")!, kind: "frame", clipContent: false });
  const text = document.getFrame("text");
  await editorTool(controls, "fit_node", { nodeId: "frame", axis: "height", padding: 16 });
  assert.equal(document.getFrame("frame")?.height, 46);
  assert.equal(document.getFrame("frame")?.width, 400);
  assert.equal(Reflect.get(document.getFrame("frame")!, "clipContent"), true);
  assert.strictEqual(document.getFrame("text"), text);
  document.undo();
  assert.equal(document.getFrame("frame")?.height, 300);
  assert.equal(Reflect.get(document.getFrame("frame")!, "clipContent"), false);
});

test("shared styles are saved as undoable document metadata and layout patches merge", async () => {
  const { controls, document } = fixture();
  const css = ":root { --space:24px; color:#123456; }";
  await editorTool(controls, "set_styles", { nodeId: "frame", css });
  const restored = new CanvasDocument(JSON.parse(JSON.stringify(document.getFrames())));
  assert.equal(Reflect.get(restored.getFrame("frame")!, "htmlStyles"), css);
  await editorTool(controls, "update_node", {
    nodeId: "frame",
    properties: { layout: { direction: "column", gap: 12 } },
  });
  await editorTool(controls, "update_node", {
    nodeId: "frame",
    properties: { layout: { padding: 24 } },
  });
  assert.deepEqual(Reflect.get(document.getFrame("frame")!, "layout"), {
    direction: "column",
    gap: 12,
    padding: 24,
    align: "start",
    justify: "start",
  });
  await editorTool(controls, "update_node", { nodeId: "frame", properties: { layout: null } });
  assert.equal(Reflect.get(document.getFrame("frame")!, "layout"), undefined);
  await assert.rejects(
    editorTool(controls, "set_styles", { nodeId: "frame", css: '@import "https://example.com";' }),
  );
});
