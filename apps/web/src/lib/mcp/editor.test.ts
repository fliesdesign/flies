import assert from "node:assert/strict";

import {
  worldCorners,
  worldTransform,
  inverseMatrix,
  transformPoint,
  CanvasDocument,
  type CanvasFrame,
} from "@flies/canvas";
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

test("MCP text edits grow stale bounds and undo typography and layout together", async () => {
  const { document, controls } = fixture();
  const before = document.getFrames();

  const result = await editorTool(controls, "update_node", {
    nodeId: "text",
    properties: { text: "First\nSecond", fontSize: 32 },
  });

  assert.equal(document.getFrame("text")?.height, 80);
  assert.deepEqual(JSON.parse((result.content[0] as { text: string }).text).warnings, []);
  assert.equal(document.getHistoryStats().undoEntries, 1);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), before);
  await editorTool(controls, "redo", {});
  assert.equal(document.getFrame("text")?.height, 80);
  assert.equal(new CanvasDocument(document.getCommittedFrames()).getFrame("text")?.height, 80);
});

test("MCP preserves explicit text crops and roomy bounds, reporting remaining overflow", async () => {
  const { document, controls } = fixture();

  const result = await editorTool(controls, "update_node", {
    nodeId: "text",
    properties: { text: "First\nSecond", fontSize: 32, height: 24 },
  });

  assert.equal(document.getFrame("text")?.height, 24);
  const warnings = JSON.parse((result.content[0] as { text: string }).text).warnings;
  assert.equal(warnings[0].code, "text_overflow");
  assert.equal(warnings[0].requiredHeight, 80);
  await editorTool(controls, "update_node", { nodeId: "text", properties: { height: 200 } });
  await editorTool(controls, "update_node", { nodeId: "text", properties: { text: "Short" } });
  assert.equal(document.getFrame("text")?.height, 200);
});

test("MCP text reflow preserves a height controlled by parent fill sizing", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "update_node", {
    nodeId: "frame",
    properties: { height: 60, layout: { direction: "row", padding: 10 } },
  });
  await editorTool(controls, "update_node", {
    nodeId: "text",
    properties: { heightSizing: "fill" },
  });

  const result = await editorTool(controls, "update_node", {
    nodeId: "text",
    properties: { text: "First\nSecond", fontSize: 32 },
  });

  assert.equal(document.getFrame("text")?.heightSizing, "fill");
  assert.equal(document.getFrame("text")?.height, 40);
  assert.equal(
    JSON.parse((result.content[0] as { text: string }).text).warnings[0].code,
    "text_overflow",
  );
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

test("MCP resizing and fitting rotated frames preserve child painting", async () => {
  const parent: CanvasFrame = {
    id: "rotated",
    name: "Rotated",
    x: 100,
    y: 100,
    width: 120,
    height: 120,
    rotation: 35,
  };

  const child: CanvasFrame = {
    id: "shape",
    name: "Shape",
    parentId: parent.id,
    kind: "rectangle",
    x: 180,
    y: 140,
    width: 80,
    height: 60,
    rotation: 45,
    fill: "#f00",
  };

  const document = new CanvasDocument([parent, child]);

  const controls = {
    document,
    prepare: () => {},
    select: () => {},
    getSelection: () => [],
  } as unknown as CanvasControls;

  const before = worldCorners(document, document.getFrame(child.id)!);
  const info = await editorTool(controls, "get_node_info", { nodeId: child.id });
  const bounds = JSON.parse((info.content[0] as { text: string }).text).worldBounds;
  assert.ok(Math.abs(bounds.x - Math.min(...before.map((point) => point.x))) < 1e-7);
  await editorTool(controls, "update_node", {
    nodeId: parent.id,
    properties: { width: 180, height: 160 },
  });
  const afterResize = worldCorners(document, document.getFrame(child.id)!);

  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(before[i].x - afterResize[i].x) < 1e-7);
    assert.ok(Math.abs(before[i].y - afterResize[i].y) < 1e-7);
  }

  document.undo();
  await editorTool(controls, "fit_node", { nodeId: parent.id, padding: 10 });

  const fitted = document.getFrame(parent.id)!,
    afterFit = worldCorners(document, document.getFrame(child.id)!);

  const inverse = inverseMatrix(worldTransform(document, fitted));

  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(before[i].x - afterFit[i].x) < 1e-7);
    assert.ok(Math.abs(before[i].y - afterFit[i].y) < 1e-7);
    const local = transformPoint(inverse, afterFit[i]);
    assert.ok(local.x <= fitted.width - 10 + 1e-7);
    assert.ok(local.y <= fitted.height - 10 + 1e-7);
  }
});

function sizingFixture() {
  const { controls } = fixture();

  const document = new CanvasDocument([
    {
      id: "page",
      name: "Page",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      layout: { direction: "column", gap: 20, padding: 20, align: "start", justify: "start" },
    },
    {
      id: "section",
      name: "Section",
      parentId: "page",
      x: 20,
      y: 20,
      width: 200,
      height: 160,
      layout: { direction: "column", gap: 10, padding: 10, align: "start", justify: "start" },
    },
    {
      id: "first",
      name: "First",
      kind: "rectangle",
      parentId: "section",
      x: 30,
      y: 30,
      width: 100,
      height: 40,
      fill: "#ffffff",
    },
    {
      id: "second",
      name: "Second",
      kind: "rectangle",
      parentId: "section",
      x: 30,
      y: 80,
      width: 80,
      height: 60,
      fill: "#000000",
    },
  ]);

  return { document, controls: { ...controls, document } };
}

test("MCP sizing and spacing use the live layout with atomic undo and project round trips", async () => {
  const { document, controls } = sizingFixture();
  const original = document.getFrames();
  await editorTool(controls, "update_node", {
    nodeId: "section",
    properties: { widthSizing: "fill", heightSizing: "hug", layout: { gap: 24, padding: 32 } },
  });
  const result = await editorTool(controls, "get_node_info", { nodeId: "section" });
  const info = JSON.parse((result.content[0] as { text: string }).text);
  assert.equal(info.node.widthSizing, "fill");
  assert.equal(info.node.heightSizing, "hug");
  assert.equal(info.node.width, 360);
  assert.equal(info.node.height, 188);
  assert.deepEqual(info.worldBounds, { x: 20, y: 20, width: 360, height: 188 });
  assert.deepEqual(info.children, ["first", "second"]);
  assert.equal(document.getFrame("first")?.x, 52);
  assert.equal(document.getFrame("first")?.y, 52);
  assert.equal(document.getFrame("second")?.y, 116);
  assert.equal(document.getHistoryStats().undoEntries, 1);

  const changed = document.getFrames();
  const restored = new CanvasDocument(JSON.parse(JSON.stringify(changed)));
  assert.deepEqual(restored.getFrames(), changed);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), original);
  await editorTool(controls, "redo", {});
  assert.deepEqual(document.getFrames(), changed);

  document.update({ ...document.getFrame("first")!, height: 70 });
  const updated = await editorTool(controls, "get_node_info", { nodeId: "section" });
  assert.equal(JSON.parse((updated.content[0] as { text: string }).text).node.height, 218);
});

test("MCP numeric sizes and one-time fit leave the requested axes fixed", async () => {
  const { document, controls } = sizingFixture();
  await editorTool(controls, "update_node", {
    nodeId: "section",
    properties: { widthSizing: "fill", heightSizing: "hug" },
  });
  await editorTool(controls, "update_node", { nodeId: "section", properties: { width: 360 } });
  assert.equal(document.getFrame("section")?.widthSizing, "fixed");
  assert.equal(document.getFrame("section")?.heightSizing, "hug");
  await editorTool(controls, "undo", {});
  assert.equal(document.getFrame("section")?.widthSizing, "fill");
  await editorTool(controls, "fit_node", { nodeId: "section", axis: "height", padding: 24 });
  assert.equal(document.getFrame("section")?.widthSizing, "fill");
  assert.equal(document.getFrame("section")?.heightSizing, "fixed");
  await editorTool(controls, "update_node", {
    nodeId: "section",
    properties: { width: 240, widthSizing: "fill", heightSizing: null },
  });
  assert.equal(document.getFrame("section")?.width, 360);
  assert.equal(document.getFrame("section")?.widthSizing, "fill");
  assert.equal(document.getFrame("section")?.heightSizing, undefined);
});

test("MCP rejects invalid sizing before changing geometry or history", async () => {
  const { document, controls } = sizingFixture();
  const original = document.getFrames();
  const snapshot = document.getSnapshot();
  await Promise.all(
    [
      { widthSizing: "auto" },
      { heightSizing: 42 },
      { widthSizing: {} },
      { layout: null, heightSizing: "hug" },
    ].map((properties) =>
      assert.rejects(
        editorTool(controls, "update_node", {
          nodeId: "section",
          properties,
        }),
      ),
    ),
  );
  assert.deepEqual(document.getFrames(), original);
  assert.deepEqual(document.getSnapshot(), snapshot);
  await assert.rejects(
    editorTool(controls, "update_node", {
      nodeId: "first",
      properties: { widthSizing: "hug" },
    }),
  );
  const nested = nestedFixture();
  await assert.rejects(
    editorTool(nested.controls, "update_node", {
      nodeId: "group",
      properties: { widthSizing: "fill" },
    }),
  );
});

test("MCP disabling auto layout preserves size and resets hug axes", async () => {
  const { document, controls } = sizingFixture();
  await editorTool(controls, "update_node", {
    nodeId: "section",
    properties: { widthSizing: "fill", heightSizing: "hug" },
  });
  const height = document.getFrame("section")?.height;
  await editorTool(controls, "update_node", { nodeId: "section", properties: { layout: null } });
  assert.equal(document.getFrame("section")?.heightSizing, "fixed");
  assert.equal(document.getFrame("section")?.height, height);
  assert.equal(document.getFrame("section")?.widthSizing, "fill");
  assert.equal(Reflect.get(document.getFrame("section")!, "layout"), undefined);
  await editorTool(controls, "undo", {});
  assert.equal(document.getFrame("section")?.heightSizing, "hug");
});

test("MCP creates native auto layout artboards and validates sizing modes atomically", async () => {
  const { document, controls } = fixture();
  const original = document.getFrames();
  await Promise.all(
    [{ widthSizing: "auto" }, { heightSizing: "hug" }, { layout: { wrap: true } }].map((args) =>
      assert.rejects(
        editorTool(controls, "create_artboard", {
          name: "Invalid",
          width: 400,
          height: 300,
          ...args,
        }),
      ),
    ),
  );
  assert.deepEqual(document.getFrames(), original);

  const result = await editorTool(controls, "create_artboard", {
    name: "Auto layout",
    width: 400,
    height: 300,
    heightSizing: "hug",
    layout: { direction: "column", padding: 32 },
  });

  const { nodeId } = JSON.parse((result.content[0] as { text: string }).text);
  const node = document.getFrame(nodeId)!;
  assert.equal(node.heightSizing, "hug");
  assert.equal(node.height, 64);
  assert.equal(node.width, 400);
  assert.equal(Reflect.get(node, "layout").gap, 16);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), original);
});
