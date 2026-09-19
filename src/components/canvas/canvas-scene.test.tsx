/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CanvasCamera, type CameraSnapshot } from "@/lib/canvas-camera";
import { CanvasDocument, type CanvasFrame } from "@/lib/canvas-document";

import { CanvasFrames, CanvasOutline, CanvasSelectionOutline } from "./canvas-scene";

class StaticCamera extends CanvasCamera {
  constructor(
    private readonly snapshot: CameraSnapshot = {
      viewport: { x: 0, y: 0, zoom: 1 },
      size: { x: 1000, y: 800 },
    },
  ) {
    super();
  }
  override getSnapshot = () => this.snapshot;
}

const parent: CanvasFrame = {
  id: "parent",
  name: "Parent",
  x: 100,
  y: 100,
  width: 400,
  height: 300,
};
const child: CanvasFrame = {
  id: "child",
  name: "Child",
  kind: "rectangle",
  fill: "#414141",
  parentId: "parent",
  x: 150,
  y: 180,
  width: 120,
  height: 80,
};

function renderFrames(frames: readonly CanvasFrame[], selectedIds: readonly string[] = []) {
  return renderToStaticMarkup(
    <CanvasFrames
      document={new CanvasDocument(frames)}
      camera={new StaticCamera()}
      selectedIds={selectedIds}
    />,
  );
}

describe("hierarchical canvas rendering", () => {
  it("renders a child once, after its parent's background and relative to its parent origin", () => {
    const markup = renderFrames([parent, child]);
    assert.equal(markup.match(/data-frame-id="child"/g)?.length, 1);
    assert.ok(markup.indexOf('class="canvas-frame"') < markup.indexOf('data-frame-id="child"'));
    assert.match(markup, /data-clip-content="true"/);
    assert.match(markup, /translate3d\(50px, 80px, 0\)/);
    // A container translation moves the branch without changing its internal layout.
    const moved = renderFrames([
      { ...parent, x: 250, y: 300 },
      { ...child, x: 300, y: 380 },
    ]);
    assert.match(moved, /translate3d\(50px, 80px, 0\)/);
  });

  it("keeps groups transparent and unclipped while nested frames clip by default", () => {
    const group: CanvasFrame = { ...parent, kind: "group" };
    const markup = renderFrames([
      group,
      { ...parent, id: "inner", parentId: "parent", x: 120, y: 130 },
    ]);
    assert.equal(markup.match(/class="canvas-frame"/g)?.length, 1);
    assert.equal(markup.match(/data-clip-content="true"/g)?.length, 1);
    const unclipped = renderFrames([{ ...parent, clipContent: false }, child]);
    assert.ok(!unclipped.includes("data-clip-content"));
  });

  it("disables the complete locked subtree and marks each selected node separately", () => {
    const markup = renderFrames([{ ...parent, locked: true }, child], ["child"]);
    assert.equal(markup.match(/data-node-locked="true"/g)?.length, 2);
    assert.equal(markup.match(/disabled=""/g)?.length, 3);
    assert.equal(markup.match(/data-selected="true"/g)?.length, 1);
    assert.match(markup, /data-frame-id="child"[^>]*data-selected="true"/);
  });

  it("preserves sibling z-order inside a frame after reordering", () => {
    const document = new CanvasDocument([parent, child, { ...child, id: "front", name: "Front" }]);
    const render = () =>
      renderToStaticMarkup(<CanvasFrames document={document} camera={new StaticCamera()} />);
    assert.ok(
      render().indexOf('data-frame-id="child"') < render().indexOf('data-frame-id="front"'),
    );
    // Explicit document ordering is hierarchy-aware, not the order returned by the spatial index.
    document.reorder(["child"], "front");
    assert.ok(
      render().indexOf('data-frame-id="front"') < render().indexOf('data-frame-id="child"'),
    );
  });
});

describe("canvas selection overlays", () => {
  it("draws one common bound for a multi-selection with eight handles", () => {
    const document = new CanvasDocument([
      { ...child, parentId: undefined },
      { ...child, id: "second", parentId: undefined, x: 400, y: 300 },
    ]);
    const markup = renderToStaticMarkup(
      <CanvasSelectionOutline
        document={document}
        camera={new StaticCamera()}
        ids={["child", "second"]}
      />,
    );
    assert.match(markup, /translate3d\(150px, 180px, 0\);width:370px;height:200px/);
    assert.equal(markup.match(/data-handle=/g)?.length, 8);
    assert.match(markup, /Resize 2 objects/);
  });

  it("clips descendant hover outlines at each ancestor without adding resize handles", () => {
    const outside = { ...child, x: 450, y: 350, width: 120, height: 100 };
    const document = new CanvasDocument([parent, outside]);
    const markup = renderToStaticMarkup(
      <CanvasOutline document={document} camera={new StaticCamera()} id="child" />,
    );
    assert.match(markup, /clip-path:inset\(-1px 70px 50px -1px\)/);
    assert.ok(!markup.includes("data-handle"));
  });

  it("hides hover and resizing controls when any ancestor is locked", () => {
    const document = new CanvasDocument([{ ...parent, locked: true }, child]);
    assert.equal(
      renderToStaticMarkup(
        <CanvasOutline document={document} camera={new StaticCamera()} id="child" />,
      ),
      "",
    );
    const selection = renderToStaticMarkup(
      <CanvasSelectionOutline document={document} camera={new StaticCamera()} ids={["child"]} />,
    );
    assert.ok(!selection.includes("data-handle"));
  });

  it("uses screen-space bounds while keeping selection handle geometry unscaled", () => {
    const camera = new StaticCamera({
      viewport: { x: 10, y: 20, zoom: 2 },
      size: { x: 1000, y: 800 },
    });
    const document = new CanvasDocument([parent]);
    const markup = renderToStaticMarkup(
      <CanvasSelectionOutline document={document} camera={camera} ids={["parent"]} />,
    );
    assert.match(markup, /translate3d\(210px, 220px, 0\);width:800px;height:600px/);
    assert.ok(!markup.includes("scale("));
  });
});
