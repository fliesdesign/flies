/// <reference types="node" />
import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { createMixedBenchmarkNodes } from "./canvas-benchmark-fixtures";
import { CanvasDocument } from "./canvas-document";
import { moveSelection } from "./canvas-operations";

describe("mixed benchmark fixtures", () => {
  for (const count of [0, 1, 4, 7, 13, 1000, 5000, 10000]) {
    it(`creates exactly ${count} valid nodes with a complete hierarchy`, () => {
      const nodes = createMixedBenchmarkNodes(count);
      const document = new CanvasDocument(nodes);
      assert.equal(nodes.length, count);
      assert.equal(document.getIds().length, count);
      assert.equal(new Set(nodes.map((node) => node.id)).size, count);
      for (const node of nodes) if (node.parentId) assert.ok(document.getFrame(node.parentId));
      if (count) {
        assert.equal(nodes[0].x, 0);
        assert.equal(nodes[0].y, 0);
      }
    });
  }

  it("contains real images, text, pen nodes, groups and nested auto-layout frames", () => {
    const nodes = createMixedBenchmarkNodes(1000);
    assert.deepEqual(
      new Set(nodes.map((node) => node.kind)),
      new Set(["frame", "text", "image", "group", "rectangle", "pen"]),
    );
    assert.ok(
      nodes.some((node) => node.kind === "image" && node.src.startsWith("data:image/png;base64,")),
    );
    assert.ok(nodes.some((node) => node.kind === "frame" && node.parentId && node.layout));
    assert.equal(nodes.filter((node) => !node.parentId).length, 100);
    assert.deepEqual(createMixedBenchmarkNodes(1000), nodes);
  });

  it("moves the complete benchmark board as one undoable subtree", () => {
    const document = new CanvasDocument(createMixedBenchmarkNodes(20));
    const original = document.getFrames();
    const root = original[0];
    const subtree = document.getDescendantIds([root.id]).map((id) => document.getFrame(id)!);
    assert.equal(subtree.length, 10);
    document.beginGesture(subtree.map((node) => node.id));
    document.previewMany(moveSelection(subtree, [root.id], { x: 30, y: 20 }));
    document.endGesture();
    for (const before of subtree) {
      assert.equal(document.getFrame(before.id)!.x, before.x + 30);
      assert.equal(document.getFrame(before.id)!.y, before.y + 20);
    }
    document.undo();
    assert.deepEqual(document.getFrames(), original);
  });
});
