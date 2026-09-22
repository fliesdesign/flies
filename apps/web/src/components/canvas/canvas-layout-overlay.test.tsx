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

describe("responsive spacing handles", () => {
  it("targets individual sides after padding overrides and only spans one wrapped row", () => {
    const container: CanvasFrame = {
      ...frame,
      width: 240,
      layout: {
        ...frame.layout!,
        padding: 10,
        paddingLeft: 20,
        paddingRight: 30,
        wrap: true,
        rowGap: 24,
        gap: 10,
      },
    };

    const children: CanvasFrame[] = [0, 1, 2].map((index) => ({
      id: `child-${index}`,
      name: `Child ${index}`,
      kind: "rectangle",
      fill: "#fff",
      parentId: container.id,
      x: 0,
      y: 0,
      width: 80,
      height: 40,
    }));

    const document = new CanvasDocument([container, ...children]);
    const resolved = document.getFrame(container.id)!;
    assert.ok(!resolved.kind || resolved.kind === "frame");

    const handles = layoutHandles(
      resolved,
      children.map((child) => document.getFrame(child.id)!),
      1,
    );

    const left = handles.find((handle) => handle.key === "padding-left")!;
    assert.equal(left.property, "layoutPaddingLeft");
    assert.equal(left.value, 20);
    assert.equal(left.rect.width, 20);
    const gap = handles.find((handle) => handle.property === "layoutGap")!;
    assert.deepEqual(gap.rect, { x: 100, y: 10, width: 10, height: 40 });
    const line = handles.find((handle) => handle.property === "layoutRowGap")!;
    assert.deepEqual(line.rect, { x: 20, y: 50, width: 190, height: 24 });
    assert.equal(line.value, 24);
    assert.equal(handles.filter((handle) => handle.property === "layoutGap").length, 1);
  });
});
