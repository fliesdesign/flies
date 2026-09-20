/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { arrangeSelection, type CanvasArrangeAction } from "./canvas-arrange";
import type { CanvasFrame } from "./canvas-document";

const nodes: CanvasFrame[] = [
  { id: "a", name: "A", x: 0, y: 0, width: 100, height: 100 },
  { id: "child", name: "Child", parentId: "a", x: 10, y: 10, width: 40, height: 40 },
  { id: "b", name: "B", x: 180, y: 150, width: 200, height: 100 },
  { id: "c", name: "C", x: 700, y: 500, width: 100, height: 200 },
];

function apply(action: CanvasArrangeAction, ids = ["a", "b", "c"]) {
  const updates = new Map(arrangeSelection(nodes, ids, action).map((node) => [node.id, node]));

  return nodes.map((node) => updates.get(node.id) ?? node);
}

describe("canvas alignment", () => {
  it("aligns left, center, and right within the selection bounds", () => {
    assert.deepEqual(
      apply("left")
        .filter((node) => !node.parentId)
        .map((node) => node.x),
      [0, 0, 0],
    );
    assert.deepEqual(
      apply("center")
        .filter((node) => !node.parentId)
        .map((node) => node.x + node.width / 2),
      [400, 400, 400],
    );
    assert.deepEqual(
      apply("right")
        .filter((node) => !node.parentId)
        .map((node) => node.x + node.width),
      [800, 800, 800],
    );
  });

  it("aligns top, middle, and bottom within the selection bounds", () => {
    assert.deepEqual(
      apply("top")
        .filter((node) => !node.parentId)
        .map((node) => node.y),
      [0, 0, 0],
    );
    assert.deepEqual(
      apply("middle")
        .filter((node) => !node.parentId)
        .map((node) => node.y + node.height / 2),
      [350, 350, 350],
    );
    assert.deepEqual(
      apply("bottom")
        .filter((node) => !node.parentId)
        .map((node) => node.y + node.height),
      [700, 700, 700],
    );
  });

  it("moves descendants exactly once along with their selected container", () => {
    const arranged = apply("right", ["a", "child", "c"]);
    assert.equal(arranged[0].x, 700);
    assert.equal(arranged[1].x, 710);
    assert.equal(arranged[1].y, 10);
    assert.equal(arranged[2], nodes[2]);
  });

  it("distributes horizontal gaps evenly while keeping outer objects fixed", () => {
    const arranged = apply("horizontal");
    assert.equal(arranged[0], nodes[0]);
    assert.equal(arranged[3], nodes[3]);
    assert.equal(arranged[2].x, 300);
    assert.equal(arranged[2].x - (arranged[0].x + arranged[0].width), 200);
    assert.equal(arranged[3].x - (arranged[2].x + arranged[2].width), 200);
  });

  it("distributes vertical gaps without changing horizontal position", () => {
    const arranged = apply("vertical");
    assert.equal(arranged[0], nodes[0]);
    assert.equal(arranged[3], nodes[3]);
    assert.equal(arranged[2].y, 250);
    assert.equal(arranged[2].x, 180);
  });

  it("ignores singleton alignment and fewer than three distribution roots", () => {
    assert.deepEqual(arrangeSelection(nodes, ["a", "child"], "right"), []);
    assert.deepEqual(arrangeSelection(nodes, ["a", "c"], "horizontal"), []);
  });
});
