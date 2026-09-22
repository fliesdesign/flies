import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  createCanvasComponent,
  instantiateCanvasComponent,
  resetCanvasInstanceOverrides,
} from "./canvas-components";
import { CanvasDocument, type CanvasFrame, type CanvasText } from "./canvas-document";
import type { CanvasOperationPlan } from "./canvas-operations";

const frames: CanvasFrame[] = [
  { id: "button", name: "Button", x: 0, y: 0, width: 200, height: 80, kind: "frame", fill: "#fff" },
  {
    id: "label",
    parentId: "button",
    name: "Label",
    x: 10,
    y: 10,
    width: 100,
    height: 25,
    kind: "text",
    text: "Continue",
    fontSize: 20,
    color: "#000",
  },
];

function plan(doc: CanvasDocument, value: CanvasOperationPlan) {
  assert.equal(
    doc.transact({
      add: value.upsert.filter((n) => !doc.getFrame(n.id)),
      update: value.upsert.filter((n) => doc.getFrame(n.id)),
      remove: value.remove,
    }),
    true,
  );
}

function fixture() {
  const doc = new CanvasDocument(frames);
  plan(doc, createCanvasComponent(doc.getFrames(), "button"));
  plan(
    doc,
    instantiateCanvasComponent(
      doc.getFrames(),
      "button",
      { x: 300, y: 0 },
      undefined,
      () => "copy",
    ),
  );

  return doc;
}

const text = (doc: CanvasDocument, id: string) => doc.getFrame(id) as CanvasText;

describe("document feature integration", () => {
  it("materializes component instances and propagates source changes in one undo entry", () => {
    const doc = fixture();
    assert.equal(text(doc, "copy/label").text, "Continue");
    assert.equal(doc.update({ ...text(doc, "label"), text: "Next" }), true);
    assert.equal(text(doc, "copy/label").text, "Next");
    assert.equal(doc.getFrame("copy")?.instance?.overrides.length, 0);
    doc.undo();
    assert.equal(text(doc, "copy/label").text, "Continue");
    doc.redo();
    assert.equal(text(doc, "copy/label").text, "Next");
    assert.deepEqual(new CanvasDocument(doc.getFrames()).getFrames(), doc.getFrames());
  });
  it("keeps rich text override metadata through gestures, undo, reset and reload", () => {
    const doc = fixture();
    const original = text(doc, "copy/label");
    doc.beginGesture("copy/label");
    assert.equal(
      doc.preview({
        ...original,
        text: "Buy now",
        textRuns: [{ start: 0, end: 3, fontWeight: 700 }],
      }),
      true,
    );
    assert.equal(doc.endGesture(), true);
    assert.equal(doc.getFrame("copy")?.instance?.overrides.length, 1);
    doc.undo();
    assert.equal(text(doc, "copy/label").text, "Continue");
    assert.equal(doc.getFrame("copy")?.instance?.overrides.length, 0);
    doc.redo();
    assert.equal(text(doc, "copy/label").textRuns?.[0].fontWeight, 700);
    assert.equal(Object.isFrozen(text(doc, "copy/label").textRuns?.[0]), true);
    doc.update({ ...text(doc, "label"), text: "Source changes" });
    assert.equal(text(doc, "copy/label").text, "Buy now");
    plan(doc, resetCanvasInstanceOverrides(doc.getFrames(), "copy"));
    assert.equal(text(doc, "copy/label").text, "Source changes");
  });
  it("cancels source gestures including derived instance edits", () => {
    const doc = fixture();
    const original = doc.getFrame("button")!;
    doc.beginGesture("button");
    assert.equal(doc.preview({ ...original, width: 300 }), true);
    assert.equal(doc.getFrame("copy")?.width, 300);
    doc.endGesture(true);
    assert.equal(doc.getFrame("copy")?.width, 200);
  });
  it("rejects invalid runs and variant values atomically", () => {
    const doc = fixture();
    assert.equal(
      doc.update({
        ...text(doc, "label"),
        textRuns: [{ start: 0, end: 900, href: "javascript:alert(1)" }],
      }),
      false,
    );
    assert.equal(
      doc.update({
        ...doc.getFrame("button")!,
        component: {
          variants: [
            {
              id: "bad",
              name: "Bad",
              overrides: [{ sourceId: "label", values: { fontSize: -1 } }],
            },
          ],
        },
      }),
      false,
    );
    assert.equal(doc.getFrame("button")?.component?.variants.length, 0);
  });
  it("detaches materialized instances when their source is deleted and restores links on undo", () => {
    const doc = fixture();
    assert.equal(doc.transact({ remove: ["button", "label"] }), true);
    assert.equal(doc.getFrame("copy")?.instance, undefined);
    assert.equal(text(doc, "copy/label").text, "Continue");
    doc.undo();
    assert.equal(doc.getFrame("copy")?.instance?.componentId, "button");
  });
});

describe("nondestructive media document edits", () => {
  const image: CanvasFrame = {
    id: "photo",
    name: "Photo",
    kind: "image",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    src: "data:image/png;base64,AAAA",
  };

  const mask: CanvasFrame = {
    id: "mask",
    name: "Mask",
    kind: "rectangle",
    x: 25,
    y: 25,
    width: 150,
    height: 150,
    fill: "#fff",
    cornerRadius: 75,
  };

  it("validates normalized crop bounds and retains original source through reset and undo", () => {
    const doc = new CanvasDocument([image]);
    assert.equal(
      doc.update({ ...image, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }),
      true,
    );
    assert.equal(doc.update({ ...image, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } }), false);
    assert.equal((doc.getFrame("photo") as typeof image).src, image.src);
    doc.undo();
    assert.equal((doc.getFrame("photo") as typeof image).crop, undefined);
    doc.redo();
    assert.equal((doc.getFrame("photo") as typeof image).crop?.width, 0.5);
  });
  it("releases deleted mask sources and restores references with undo", () => {
    const doc = new CanvasDocument([image, mask]);
    assert.equal(doc.update({ ...image, maskId: "mask" }), true);
    assert.equal(doc.isMaskSource("mask"), true);
    assert.equal(doc.update({ ...mask, maskId: "photo" }), false);
    assert.equal(doc.remove("mask"), true);
    assert.equal(doc.getFrame("photo")?.maskId, undefined);
    doc.undo();
    assert.equal(doc.getFrame("photo")?.maskId, "mask");
    assert.equal(doc.isMaskSource("mask"), true);
    assert.deepEqual(new CanvasDocument(doc.getFrames()).getFrames(), doc.getFrames());
  });
  it("rejects non-sibling, container and dangling mask sources without mutation", () => {
    const doc = new CanvasDocument([...frames, image, mask]);
    assert.equal(doc.update({ ...image, maskId: "button" }), false);
    assert.equal(doc.update({ ...image, maskId: "label" }), false);
    assert.equal(doc.update({ ...image, maskId: "missing" }), false);
    assert.equal(doc.getFrame("photo")?.maskId, undefined);
  });
});
