/* oxlint-disable no-await-in-loop -- Each rejected mutation must leave shared state unchanged before the next request. */
import assert from "node:assert/strict";

import {
  CanvasDocument,
  loadCanvasFrames,
  saveCanvasFrames,
  type CanvasFrame,
} from "@flies/canvas";
import { test } from "vite-plus/test";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { editorTool, type McpResult } from "./editor";

function fixture() {
  const document = new CanvasDocument([
    { id: "board", name: "Board", x: 0, y: 0, width: 400, height: 300 },
    {
      id: "label",
      name: "Label",
      kind: "text",
      parentId: "board",
      x: 20,
      y: 20,
      width: 160,
      height: 40,
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

function roundTrip(nodes: readonly CanvasFrame[]) {
  let stored = "";
  assert.equal(
    saveCanvasFrames(nodes, {
      setItem: (_key, value) => {
        stored = value;
      },
    }),
    true,
  );

  return loadCanvasFrames({ getItem: () => stored });
}

function payload(result: McpResult) {
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");

  return JSON.parse((result.content[0] as { text: string }).text);
}

test("MCP wrap, per-side padding and nullable overrides reflow and undo with the shared document", async () => {
  const { document, controls } = fixture();

  const { nodeId } = payload(
    await editorTool(controls, "create_artboard", {
      name: "Wrap",
      x: 500,
      width: 240,
      height: 300,
      heightSizing: "hug",
      layout: {
        direction: "row",
        gap: 10,
        padding: 10,
        paddingLeft: 20,
        paddingRight: 30,
        rowGap: 24,
        wrap: true,
      },
    }),
  );

  document.addMany(
    [0, 1, 2].map((index): CanvasFrame => ({
      id: `wrap-${index}`,
      name: "Item",
      kind: "rectangle",
      fill: "#fff",
      parentId: nodeId,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
    })),
  );
  assert.equal(document.getFrame(nodeId)?.height, 124);
  assert.equal(document.getFrame("wrap-2")?.y, 74);
  const before = document.getFrames();
  await editorTool(controls, "update_node", {
    nodeId,
    properties: { layout: { paddingLeft: null, rowGap: 8 } },
  });
  assert.equal(document.getFrame("wrap-0")?.x, 510);
  assert.equal(document.getFrame("wrap-2")?.y, 58);
  assert.equal(document.getFrame(nodeId)?.height, 108);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), before);
  assert.deepEqual(roundTrip(before), before);
});

test("MCP size limits and resize constraints support partial merges, resets and atomic validation", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: {
      constraints: { horizontal: "end", vertical: "center" },
      minWidth: 100,
      maxWidth: 200,
    },
  });
  const before = document.getFrames();
  await editorTool(controls, "update_node", {
    nodeId: "board",
    properties: { width: 500, height: 400 },
  });
  assert.equal(document.getFrame("label")?.x, 120);
  assert.equal(document.getFrame("label")?.y, 70);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), before);
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { constraints: { vertical: null }, width: 10 },
  });
  assert.deepEqual(document.getFrame("label")?.constraints, { horizontal: "end" });
  assert.equal(document.getFrame("label")?.width, 100);
  const bounded = document.getFrames();

  for (const properties of [
    { minWidth: 300 },
    { constraints: { horizontal: "middle" } },
    { constraints: { other: "start" } },
  ]) {
    await assert.rejects(editorTool(controls, "update_node", { nodeId: "label", properties }));
    assert.deepEqual(document.getFrames(), bounded);
  }

  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { constraints: null, minWidth: null, maxWidth: null },
  });
  assert.equal(document.getFrame("label")?.constraints, undefined);
  assert.equal(document.getFrame("label")?.minWidth, undefined);
});

test("MCP rich text preserves surviving runs through copy edits, validates ranges and saves formatting", async () => {
  const { document, controls } = fixture();

  const textRuns = [
    { start: 0, end: 5, color: "#ff0000", fontWeight: 700, href: "https://example.com/" },
  ];

  await editorTool(controls, "update_node", { nodeId: "label", properties: { textRuns } });
  const styled = document.getFrame("label");
  assert.ok(styled?.kind === "text");
  assert.deepEqual(styled.textRuns, textRuns);
  assert.ok(Object.isFrozen(styled.textRuns?.[0]));
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { text: "Hello world" },
  });
  const edited = document.getFrame("label");
  assert.ok(edited?.kind === "text");
  assert.equal(edited.textRuns?.[0].color, "#ff0000");
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrame("label"), styled);

  for (const runs of [
    [{ start: 0, end: 20 }],
    [
      { start: 0, end: 4 },
      { start: 3, end: 5 },
    ],
    [{ start: 0, end: 5, href: "javascript:alert(1)" }],
  ]) {
    await assert.rejects(
      editorTool(controls, "update_node", { nodeId: "label", properties: { textRuns: runs } }),
    );
    assert.deepEqual(document.getFrame("label"), styled);
  }

  assert.deepEqual(roundTrip(document.getFrames()), document.getFrames());
  await editorTool(controls, "update_node", { nodeId: "label", properties: { textRuns: null } });
  assert.equal(Reflect.get(document.getFrame("label")!, "textRuns"), undefined);
});

test("MCP component source edits, local overrides, variants and detach share undo and persistence", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "create_component", { nodeId: "board" });

  const { nodeId } = payload(
    await editorTool(controls, "instantiate_component", { componentId: "board", x: 500, y: 0 }),
  );

  const label = () =>
    document
      .getFrames()
      .find((node) => node.parentId === nodeId && node.componentSourceId === "label")!;

  assert.equal(Reflect.get(label(), "text"), "Hello");
  await editorTool(controls, "update_node", { nodeId: "label", properties: { text: "World" } });
  assert.equal(Reflect.get(label(), "text"), "World");
  await editorTool(controls, "update_node", { nodeId: label().id, properties: { text: "Local" } });
  assert.equal(document.getFrame(nodeId)?.instance?.overrides[0].text, "Local");
  await editorTool(controls, "update_node", { nodeId: "label", properties: { fontSize: 20 } });
  assert.equal(Reflect.get(label(), "text"), "Local");
  assert.equal(Reflect.get(label(), "fontSize"), 20);
  await editorTool(controls, "reset_instance", { nodeId });
  assert.equal(Reflect.get(label(), "text"), "World");
  await editorTool(controls, "set_component_variant", {
    componentId: "board",
    variant: {
      id: "red",
      name: "Red",
      overrides: [{ sourceId: "label", values: { color: "#ff0000" } }],
    },
  });
  await editorTool(controls, "set_instance_variant", { nodeId, variantId: "red" });
  assert.equal(Reflect.get(label(), "color"), "#ff0000");
  await editorTool(controls, "update_node", { nodeId: label().id, properties: { text: "Promo" } });
  await editorTool(controls, "capture_component_variant", { nodeId, name: "Promotion" });
  assert.equal(document.getFrame("board")?.component?.variants.length, 2);
  assert.equal(document.getFrame(nodeId)?.instance?.overrides.length, 0);
  const linked = document.getFrames();
  assert.deepEqual(roundTrip(linked), linked);
  const labelId = label().id;
  await editorTool(controls, "detach_instance", { nodeId });
  assert.equal(document.getFrame(nodeId)?.instance, undefined);
  assert.equal(Reflect.get(document.getFrame(labelId)!, "text"), "Promo");
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), linked);
  await editorTool(controls, "remove_component_variant", {
    componentId: "board",
    variantId: "red",
  });
  assert.equal(document.getFrame("board")?.component?.variants.length, 1);
});

test("MCP crop and masks validate before editing and deleting mask artwork releases the target", async () => {
  const { document, controls } = fixture();
  document.addMany([
    {
      id: "image",
      kind: "image",
      name: "Image",
      parentId: "board",
      x: 200,
      y: 20,
      width: 100,
      height: 100,
      src: "data:image/png;base64,iVBORw0KGgo=",
    },
    {
      id: "mask",
      kind: "rectangle",
      name: "Mask",
      parentId: "board",
      x: 220,
      y: 20,
      width: 50,
      height: 100,
      fill: "#fff",
    },
  ]);
  await editorTool(controls, "update_node", {
    nodeId: "image",
    properties: { crop: { x: 0.25, y: 0, width: 0.5, height: 1 }, maskId: "mask" },
  });
  const before = document.getFrames();

  for (const properties of [
    { crop: { x: 0.7, y: 0, width: 0.5, height: 1 } },
    { maskId: "image" },
    { maskId: "board" },
  ]) {
    await assert.rejects(editorTool(controls, "update_node", { nodeId: "image", properties }));
    assert.deepEqual(document.getFrames(), before);
  }

  await editorTool(controls, "delete_nodes", { nodeIds: ["mask"] });
  assert.equal(document.getFrame("image")?.maskId, undefined);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), before);
  await editorTool(controls, "update_node", {
    nodeId: "image",
    properties: { crop: null, maskId: null },
  });
  assert.equal(Reflect.get(document.getFrame("image")!, "crop"), undefined);
});

test("MCP editable vector geometry regenerates SVG and boolean operations are atomic", async () => {
  const { document, controls } = fixture();

  const vector = {
    viewWidth: 100,
    viewHeight: 100,
    fill: "#f00",
    stroke: "none",
    strokeWidth: 0,
    contours: [
      {
        closed: true,
        anchors: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
          { x: 100, y: 100 },
          { x: 0, y: 100 },
        ],
      },
    ],
  };

  const { nodeId } = payload(
    await editorTool(controls, "create_vector", { name: "Shape", x: 500, y: 0, vector }),
  );

  const before = document.getFrame(nodeId)!;

  const curved = {
    ...vector,
    contours: [
      {
        closed: true,
        anchors: [{ x: 0, y: 0, out: { x: 50, y: 30 } }, ...vector.contours[0].anchors.slice(1)],
      },
    ],
  };

  await editorTool(controls, "update_node", { nodeId, properties: { vector: curved } });
  assert.notEqual(Reflect.get(document.getFrame(nodeId)!, "src"), Reflect.get(before, "src"));
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrame(nodeId), before);
  document.addMany([
    { id: "a", name: "A", kind: "rectangle", x: 0, y: 400, width: 80, height: 80, fill: "#000" },
    { id: "b", name: "B", kind: "rectangle", x: 40, y: 400, width: 80, height: 80, fill: "#000" },
  ]);
  await editorTool(controls, "convert_to_vector", { nodeId: "a" });
  assert.equal(document.getFrame("a")?.kind, "svg");
  const operands = document.getFrames();

  const result = payload(
    await editorTool(controls, "boolean_vectors", { nodeIds: ["a", "b"], operation: "union" }),
  );

  assert.equal(document.getFrame(result.nodeId)?.width, 120);
  assert.equal(document.getFrame("a"), undefined);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), operands);
  await assert.rejects(
    editorTool(controls, "update_node", {
      nodeId,
      properties: { vector: { ...vector, viewWidth: 0 } },
    }),
  );
  assert.deepEqual(document.getFrames(), operands);
});

test("MCP moving and resizing a rotated frame retains constraints instead of overriding them with compensation", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "update_node", { nodeId: "board", properties: { rotation: 30 } });
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { constraints: { horizontal: "end", vertical: "center" } },
  });
  const before = document.getFrames();
  await editorTool(controls, "update_node", {
    nodeId: "board",
    properties: { x: 40, y: 30, width: 500, height: 400 },
  });
  assert.equal(document.getFrame("label")?.x, 160);
  assert.equal(document.getFrame("label")?.y, 100);
  await editorTool(controls, "undo", {});
  assert.deepEqual(document.getFrames(), before);
});

test("MCP long instance text retains measured height through source changes and resets", async () => {
  const { document, controls } = fixture();
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { width: 100, height: 25 },
  });
  await editorTool(controls, "create_component", { nodeId: "board" });

  const { nodeId } = payload(
    await editorTool(controls, "instantiate_component", { componentId: "board" }),
  );

  const label = () =>
    document
      .getFrames()
      .find((node) => node.parentId === nodeId && node.componentSourceId === "label")!;

  const text = Array(4).fill("Longer copy remains visible across explicit lines.").join("\n");

  await editorTool(controls, "update_node", { nodeId: label().id, properties: { text } });
  const height = label().height;
  assert.ok(height > 25);
  assert.equal(document.getFrame(nodeId)?.instance?.overrides[0].textHeight, height);
  await editorTool(controls, "update_node", {
    nodeId: "label",
    properties: { text: "Source changed", height: 50 },
  });
  assert.equal(Reflect.get(label(), "text"), text);
  assert.equal(label().height, height);
  await editorTool(controls, "reset_instance", { nodeId });
  assert.equal(Reflect.get(label(), "text"), "Source changed");
  assert.equal(label().height, 50);
});
