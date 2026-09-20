/// <reference types="node" />
import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import {
  getVisibleSelectionFrames,
  isRectVisibleInRoundedClips,
  roundedClipsContainPoint,
} from "./canvas-outline";

const circle: CanvasFrame = {
  id: "circle",
  name: "Circle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  cornerRadius: 50,
};

describe("rounded ancestor clips", () => {
  it("rejects hidden corner regions while preserving visible slivers and off-center overlap", () => {
    assert.equal(isRectVisibleInRoundedClips({ x: 0, y: 0, width: 5, height: 5 }, [circle]), false);
    assert.equal(
      isRectVisibleInRoundedClips({ x: 0, y: 40, width: 2, height: 20 }, [circle]),
      true,
    );
    assert.equal(
      isRectVisibleInRoundedClips({ x: 0, y: 0, width: 20, height: 40 }, [circle]),
      true,
    );
    assert.equal(
      isRectVisibleInRoundedClips({ x: -5, y: 45, width: 5, height: 10 }, [circle]),
      false,
    );
  });

  it("intersects nested rounded clips even when their rectangular bounds overlap", () => {
    const disjoint = { ...circle, id: "other", x: 80, y: 80 };
    assert.equal(
      isRectVisibleInRoundedClips({ x: 0, y: 0, width: 200, height: 200 }, [circle, disjoint]),
      false,
    );
    const overlapping = { ...circle, id: "other", x: 70, y: 70 };
    assert.equal(
      isRectVisibleInRoundedClips({ x: 0, y: 0, width: 200, height: 200 }, [circle, overlapping]),
      true,
    );
  });

  it("matches CSS radius clamping and curved-boundary anchor containment", () => {
    const oversized = { ...circle, cornerRadius: 1000 };
    assert.equal(roundedClipsContainPoint([oversized], { x: 0, y: 0 }), false);
    assert.equal(roundedClipsContainPoint([oversized], { x: 50, y: 0 }), true);
    assert.equal(roundedClipsContainPoint([oversized], { x: 20, y: 20 }), true);
    assert.equal(roundedClipsContainPoint([oversized], { x: -1, y: 50 }), false);
  });

  it("uses the same rounded visibility for selection bounds and resize roots", () => {
    const document = new CanvasDocument([
      circle,
      {
        ...circle,
        id: "hidden-corner",
        kind: "rectangle",
        fill: "#fff",
        parentId: "circle",
        x: 0,
        y: 0,
        width: 5,
        height: 5,
        cornerRadius: 0,
      },
      {
        ...circle,
        id: "visible",
        kind: "rectangle",
        fill: "#fff",
        parentId: "circle",
        x: 40,
        y: 40,
        width: 10,
        height: 10,
        cornerRadius: 0,
      },
    ]);
    assert.deepEqual(
      getVisibleSelectionFrames(document, ["hidden-corner", "visible"]).map((frame) => frame.id),
      ["visible"],
    );
    document.update({ ...circle, clipContent: false });
    assert.deepEqual(
      getVisibleSelectionFrames(document, ["hidden-corner", "visible"]).map((frame) => frame.id),
      ["hidden-corner", "visible"],
    );
  });
});
