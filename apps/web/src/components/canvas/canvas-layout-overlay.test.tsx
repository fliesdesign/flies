/// <reference types="node" />
import assert from "node:assert/strict";

import { CanvasCamera, CanvasDocument, type CanvasFrame, type CameraSnapshot } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { CanvasLayoutOverlay, layoutHandles } from "./canvas-layout-overlay";

class StaticCamera extends CanvasCamera {
  override getSnapshot = (): CameraSnapshot => ({
    viewport: { x: 0, y: 0, zoom: 1 },
    size: { x: 1000, y: 800 },
  });
}

const frame: CanvasFrame = {
  id: "layout",
  name: "Layout",
  x: 100,
  y: 100,
  width: 300,
  height: 200,
  layout: { direction: "row", padding: 0, gap: 0, align: "start", justify: "start" },
};

function render(frames: CanvasFrame[]) {
  return renderToStaticMarkup(
    <CanvasLayoutOverlay
      document={new CanvasDocument(frames)}
      camera={new StaticCamera()}
      id="layout"
      activeHandle={null}
      onStart={() => {}}
      onChange={() => {}}
    />,
  );
}

describe("layout overlay boundaries", () => {
  it("does not offer editing under locked groups or non-clipping ancestors", () => {
    for (const parent of [
      {
        id: "parent",
        name: "Parent",
        x: 0,
        y: 0,
        width: 500,
        height: 400,
        locked: true,
        clipContent: false,
      },
      {
        id: "parent",
        name: "Parent",
        kind: "group" as const,
        x: 0,
        y: 0,
        width: 500,
        height: 400,
        locked: true,
      },
    ])
      assert.doesNotMatch(
        render([parent, { ...frame, parentId: parent.id }]),
        /data-layout-handle=/,
      );
  });

  it("hides handles outside rounded ancestor clips and omits hidden contexts", () => {
    const parent: CanvasFrame = {
      id: "parent",
      name: "Parent",
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      cornerRadius: 200,
    };

    const markup = render([
      parent,
      { ...frame, parentId: parent.id, x: 0, y: 0, width: 100, height: 100 },
    ]);

    assert.doesNotMatch(
      markup,
      /data-layout-handle="padding-top"|data-layout-handle="padding-left"/,
    );
    assert.equal(
      render([
        { ...parent, hidden: true },
        { ...frame, parentId: parent.id },
      ]),
      "",
    );
  });

  it("keeps zero padding and gap reachable while skipping hidden children", () => {
    const child: CanvasFrame = {
      kind: "rectangle",
      id: "a",
      name: "A",
      x: 100,
      y: 100,
      width: 80,
      height: 40,
      fill: "#fff",
      parentId: frame.id,
    };

    const handles = layoutHandles(
      frame,
      [child, { ...child, id: "hidden", hidden: true }, { ...child, id: "b", name: "B", x: 180 }],
      0.5,
    );

    assert.equal(handles.length, 5);
    assert.equal(handles[0].anchor.y, 28);
    assert.deepEqual(handles[4].anchor, { x: 80, y: 100 });
    assert.equal(handles[4].value, 0);
  });
});
