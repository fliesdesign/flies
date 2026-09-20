/// <reference types="node" />
import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasDocument, type CanvasFrame, type CanvasFrameNode } from "./canvas-document";
import { finalizeCanvasMove } from "./canvas-move";
import { moveSelection } from "./canvas-operations";

const parent: CanvasFrameNode = {
  id: "parent",
  name: "Parent",
  kind: "frame",
  x: 0,
  y: 0,
  width: 300,
  height: 200,
  layout: { direction: "row", gap: 10, padding: 20, align: "start", justify: "start" },
};

const child: CanvasFrame = {
  id: "child",
  name: "Child",
  kind: "rectangle",
  fill: "#fff",
  parentId: "parent",
  x: 20,
  y: 20,
  width: 50,
  height: 40,
};

function previewMove(document: CanvasDocument, roots: string[], delta: { x: number; y: number }) {
  const requested = moveSelection(document.getFrames(), roots, delta);
  document.beginGesture(requested.map((node) => node.id));
  document.previewMany(requested);

  return requested;
}

describe("final canvas move geometry", () => {
  it("keeps a layout slot when the requested move stays inside its parent", () => {
    const document = new CanvasDocument([parent, child]);
    const before = document.getFrames();
    const requested = previewMove(document, [child.id], { x: 90, y: 60 });
    assert.equal(document.getFrame(child.id)?.x, 20);
    const final = finalizeCanvasMove(document.getFrames(), [child.id], requested);
    assert.deepEqual(final, []);
    document.endGesture(false, final);
    assert.deepEqual(document.getFrames(), before);
    assert.equal(document.getHistoryStats().undoEntries, 0);
  });

  it("detaches at the raw drop coordinates and reflows siblings in one undo step", () => {
    const sibling = { ...child, id: "sibling", x: 80 };
    const document = new CanvasDocument([parent, child, sibling]);
    const before = document.getFrames();
    const requested = previewMove(document, [child.id], { x: 500, y: 100 });
    assert.equal(document.getFrame(child.id)?.x, 20);
    document.endGesture(false, finalizeCanvasMove(document.getFrames(), [child.id], requested));
    assert.equal(document.getFrame(child.id)?.parentId, undefined);
    assert.equal(document.getFrame(child.id)?.x, 520);
    assert.equal(document.getFrame(child.id)?.y, 120);
    assert.equal(document.getFrame(sibling.id)?.x, 20);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    const after = document.getFrames();
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    document.redo();
    assert.deepEqual(document.getFrames(), after);
  });

  it("carries every descendant out with a dragged group", () => {
    const group: CanvasFrame = { ...child, id: "group", kind: "group" };
    const nested = { ...child, parentId: "group" };
    const document = new CanvasDocument([parent, group, nested]);
    const before = document.getFrames();
    const requested = previewMove(document, [group.id], { x: 500, y: 100 });
    const final = finalizeCanvasMove(document.getFrames(), [group.id], requested);
    assert.deepEqual(
      final.map((node) => node.id),
      [group.id, child.id],
    );
    document.endGesture(false, final);
    assert.equal(document.getFrame(group.id)?.parentId, undefined);
    assert.equal(document.getFrame(group.id)?.x, 520);
    assert.equal(document.getFrame(child.id)?.parentId, group.id);
    assert.equal(document.getFrame(child.id)?.x, 520);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("preserves constrained geometry for roots that do not change parents in a mixed drag", () => {
    const sibling = { ...child, id: "sibling", x: 80 };
    const document = new CanvasDocument([parent, child, sibling]);
    const requested = previewMove(document, [child.id, sibling.id], { x: 240, y: 0 });
    const final = finalizeCanvasMove(document.getFrames(), [child.id, sibling.id], requested);
    assert.deepEqual(
      final.map((node) => node.id),
      [sibling.id],
    );
    document.endGesture(false, final);
    assert.equal(document.getFrame(child.id)?.parentId, parent.id);
    assert.equal(document.getFrame(child.id)?.x, 20);
    assert.equal(document.getFrame(sibling.id)?.parentId, undefined);
    assert.equal(document.getFrame(sibling.id)?.x, 320);
  });

  it("allows the destination layout to place a reparented subtree", () => {
    const group: CanvasFrame = { ...child, id: "group", kind: "group" };
    const nested = { ...child, parentId: "group" };
    const destination = { ...parent, id: "destination", x: 500 };
    const resident = { ...child, id: "resident", parentId: destination.id };
    const document = new CanvasDocument([parent, group, nested, destination, resident]);
    const before = document.getFrames();
    const requested = previewMove(document, [group.id], { x: 600, y: 100 });
    document.endGesture(false, finalizeCanvasMove(document.getFrames(), [group.id], requested));
    assert.equal(document.getFrame(group.id)?.parentId, destination.id);
    assert.equal(document.getFrame(group.id)?.x, 520);
    assert.equal(document.getFrame(child.id)?.x, 520);
    assert.equal(document.getFrame(group.id)?.y, 20);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("discards requested out-of-layout geometry on cancellation", () => {
    const document = new CanvasDocument([parent, child]);
    const before = document.getFrames();
    previewMove(document, [child.id], { x: 500, y: 100 });
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), before);
    assert.equal(document.getHistoryStats().undoEntries, 0);
  });
});
