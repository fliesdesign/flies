import assert from "node:assert/strict";

import { CanvasDocument, type CanvasFrame, type CanvasText } from "@flies/canvas";
import { test } from "vite-plus/test";

import { htmlWarnings } from "./html-diagnostics";

const text: CanvasText = {
  id: "text",
  parentId: "frame",
  name: "Headline",
  kind: "text",
  x: 10,
  y: 10,
  width: 180,
  height: 25,
  text: "One line",
  fontSize: 20,
  color: "#000000",
};

const frame: CanvasFrame = {
  id: "frame",
  name: "Page",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
};

test("text diagnostics tolerate rounded heights and unused text box space", () => {
  for (const height of [24, 25, 200]) {
    const node = { ...text, height };
    const document: CanvasDocument = new CanvasDocument([frame, node]);
    assert.deepEqual(htmlWarnings(document, [node]), []);
  }
});

test("short native text boxes report measured height and omit temporary IDs in previews", () => {
  const node = { ...text, text: "First\nSecond", height: 25 };
  const document = new CanvasDocument([frame, node]);
  const [applied] = htmlWarnings(document, [node]);
  assert.equal(applied.code, "text_overflow");
  assert.equal(applied.nodeId, "text");
  assert.equal(applied.nodeName, "Headline");
  assert.equal(applied.requiredHeight, 50);
  assert.match(applied.suggestion, /update_node/);
  const [preview] = htmlWarnings(document, [node], true);
  assert.ok(!("nodeId" in preview));
  assert.equal(preview.requiredHeight, 50);
});

test("text diagnostics inspect clipping ancestors outside the imported subtree", () => {
  const group: CanvasFrame = {
    id: "group",
    parentId: "frame",
    kind: "group",
    name: "Section",
    x: 0,
    y: 0,
    width: 200,
    height: 140,
  };

  const node = { ...text, parentId: "group", y: 90 };
  const document = new CanvasDocument([frame, group, node]);
  const [warning] = htmlWarnings(document, [document.getFrame(node.id)!]);
  assert.equal(warning.code, "clipped_text");
  assert.equal(warning.ancestorId, "frame");
  assert.equal(warning.ancestorName, "Page");
  assert.match(warning.suggestion, /fit_node/);
  const [preview] = htmlWarnings(document, [document.getFrame(node.id)!], true);
  assert.ok(!("nodeId" in preview));
  assert.ok(!("ancestorId" in preview));
});

test("intentional overflow, hidden ancestry and transparent ancestry stay quiet", () => {
  const node = { ...text, y: 150 };

  for (const parent of [
    { ...frame, clipContent: false },
    { ...frame, hidden: true },
    { ...frame, opacity: 0 },
  ]) {
    const document = new CanvasDocument([parent, node]);
    assert.deepEqual(htmlWarnings(document, [node]), []);
  }
});

test("text clipping diagnostics use rotations relative to the clipping ancestor", () => {
  const parent = { ...frame, rotation: 45 };
  const inside = { ...text, width: 60, height: 25, rotation: 0 };
  const doc = new CanvasDocument([parent, inside]);
  assert.deepEqual(htmlWarnings(doc, [doc.getFrame(inside.id)!]), []);
  const rotated = { ...inside, x: 155, y: 65, rotation: 45 };
  doc.updateMany([rotated]);
  assert.equal(htmlWarnings(doc, [doc.getFrame(rotated.id)!])[0].code, "clipped_text");
});
