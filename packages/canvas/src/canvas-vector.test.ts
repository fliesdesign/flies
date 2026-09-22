import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import type { CanvasFrame } from "./canvas-document";
import { frameSource, multiplyMatrix, worldTransform, IDENTITY } from "./canvas-transform";
import {
  addCanvasVectorAnchor,
  booleanCanvasVectors,
  canvasVectorPath,
  canvasVectorPolygons,
  canvasVectorSource,
  convertCanvasNodeToVector,
  createCanvasVectorNode,
  flattenCanvasVectorContour,
  isCanvasVector,
  moveCanvasVectorAnchor,
  parseCanvasVectorPath,
  removeCanvasVectorAnchor,
  setCanvasVectorAnchorSmooth,
  type CanvasVectorData,
  type EditableCanvasSvg,
} from "./canvas-vector";

const vector: CanvasVectorData = {
  viewWidth: 100,
  viewHeight: 100,
  fill: "#ff0000",
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

const rectangle = (id: string, x: number, y: number, width = 100, height = 100): CanvasFrame => ({
  id,
  name: id,
  kind: "rectangle",
  x,
  y,
  width,
  height,
  fill: "#ff0000",
});

const area = (v: CanvasVectorData) =>
  canvasVectorPolygons(v).reduce(
    (sum, polygon) =>
      sum +
      polygon.reduce((total, ring, index) => {
        let a = 0;
        for (let i = 1; i < ring.length; i++)
          a += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1];

        return total + Math.abs(a / 2) * (index === 0 ? 1 : -1);
      }, 0),
    0,
  );

describe("editable vector geometry", () => {
  it("validates serialized geometry and derives safe image data without a DOM", () => {
    assert.equal(isCanvasVector(vector), true);
    assert.equal(isCanvasVector({ ...vector, fill: '"/><script/>' }), false);
    assert.equal(isCanvasVector({ ...vector, viewWidth: Infinity }), false);
    const source = canvasVectorSource(vector);
    assert.match(source, /^data:image\/svg\+xml;base64,/);
    assert.match(atob(source.split(",")[1]), /fill-rule="evenodd"/);
  });

  it("moves anchors and their handles together, or mirrors a dragged handle", () => {
    const smooth = setCanvasVectorAnchorSmooth(vector, 0, 1, true);
    const before = smooth.contours[0].anchors[1];
    const moved = moveCanvasVectorAnchor(smooth, 0, 1, { x: 120, y: 10 });
    assert.equal(moved.contours[0].anchors[1].in!.x, before.in!.x + 20);
    const mirrored = moveCanvasVectorAnchor(moved, 0, 1, { x: 140, y: 20 }, "out", true);
    assert.deepEqual(mirrored.contours[0].anchors[1].in, { x: 100, y: 0 });
    assert.deepEqual(vector.contours[0].anchors[1], { x: 100, y: 0 });
  });

  it("splits cubic segments without changing their geometry", () => {
    const curve: CanvasVectorData = {
      ...vector,
      contours: [
        {
          closed: false,
          anchors: [
            { x: 0, y: 0, out: { x: 0, y: 100 } },
            { x: 100, y: 0, in: { x: 100, y: 100 } },
          ],
        },
      ],
    };

    const split = addCanvasVectorAnchor(curve, 0, 0);
    assert.deepEqual(split.contours[0].anchors[1], {
      x: 50,
      y: 75,
      in: { x: 25, y: 75 },
      out: { x: 75, y: 75 },
    });
    assert.deepEqual(
      flattenCanvasVectorContour(split.contours[0]),
      flattenCanvasVectorContour(curve.contours[0]),
    );
    assert.throws(() =>
      removeCanvasVectorAnchor(
        {
          ...vector,
          contours: [{ closed: true, anchors: vector.contours[0].anchors.slice(0, 3) }],
        },
        0,
        0,
      ),
    );
  });

  it("does not flatten collinear control points that overshoot segment endpoints", () => {
    const points = flattenCanvasVectorContour({
      closed: false,
      anchors: [
        { x: 0, y: 0, out: { x: 200, y: 0 } },
        { x: 100, y: 0, in: { x: 200, y: 0 } },
      ],
    });

    assert.ok(Math.max(...points.map((point) => point.x)) > 150);
  });

  it("parses relative lines and quadratic/smooth/cubic commands into editable handles", () => {
    const contours = parseCanvasVectorPath("M10 10h20v20h-20z M0 0q50 100 100 0t100 0");
    assert.equal(contours.length, 2);
    assert.equal(contours[0].closed, true);
    assert.equal(contours[1].anchors.length, 3);
    assert.ok(contours[1].anchors[1].out!.y < 0);
    assert.match(canvasVectorPath(contours[1]), /C/);
    assert.throws(() => parseCanvasVectorPath("M0 0A20 20 0 0 0 40 0"), /cannot be converted/);
  });

  it("converts rectangles with rounded corners and pen strokes without mutating their source", () => {
    const original = { ...rectangle("rounded", 20, 30), cornerRadius: 12 };
    const converted = convertCanvasNodeToVector(original);
    assert.equal(converted.kind, "svg");
    assert.equal(converted.id, original.id);
    assert.equal(converted.vector.contours[0].anchors.length, 8);
    assert.match(canvasVectorPath(converted.vector.contours[0]), /C/);
    assert.equal(original.kind, "rectangle");

    const pen: CanvasFrame = {
      id: "pen",
      name: "Pen",
      kind: "pen",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      stroke: "#000000",
      strokeWidth: 2,
      pathWidth: 100,
      pathHeight: 100,
    };

    assert.equal(convertCanvasNodeToVector(pen).vector.contours[0].closed, false);
  });
});

describe("vector Boolean operations", () => {
  for (const [operation, expected] of [
    ["union", 15000],
    ["subtract", 5000],
    ["intersect", 5000],
    ["exclude", 10000],
  ] as const) {
    it(`${operation} overlapping shapes`, () => {
      const nodes = [rectangle("a", 0, 0), rectangle("b", 50, 0)];
      const result = booleanCanvasVectors(nodes, ["a", "b"], operation, () => "result");
      assert.equal(area((result.upsert[0] as EditableCanvasSvg).vector), expected);
      assert.deepEqual(result.remove, ["a", "b"]);
      assert.deepEqual(result.selection, ["result"]);
      assert.equal(nodes[0].kind, "rectangle");
    });
  }

  it("keeps subtraction holes editable and preserves them in subsequent unions", () => {
    const nodes = [rectangle("outside", 0, 0), rectangle("inside", 25, 25, 50, 50)];

    const hole = booleanCanvasVectors(nodes, ["outside", "inside"], "subtract", () => "hole")
      .upsert[0] as EditableCanvasSvg;

    assert.equal(hole.vector.contours.length, 2);
    assert.equal(area(hole.vector), 7500);
    const island = rectangle("island", 40, 40, 20, 20);

    const result = booleanCanvasVectors([hole, island], ["hole", "island"], "union", () => "result")
      .upsert[0] as EditableCanvasSvg;

    assert.equal(area(result.vector), 7900);
  });

  it("respects transformed parents and outputs geometry in the first shape's parent space", () => {
    const parent: CanvasFrame = {
      id: "parent",
      kind: "frame",
      name: "Parent",
      x: 200,
      y: 100,
      width: 400,
      height: 300,
      rotation: 35,
    };

    const nodes: CanvasFrame[] = [
      parent,
      { ...rectangle("a", 220, 130), parentId: parent.id },
      { ...rectangle("b", 270, 130), parentId: parent.id },
    ];

    const result = booleanCanvasVectors(nodes, ["a", "b"], "union", () => "result")
      .upsert[0] as EditableCanvasSvg;

    assert.equal(result.parentId, parent.id);
    assert.ok(Math.abs(area(result.vector) - 15000) < 0.0001);

    const world = multiplyMatrix(worldTransform(frameSource([parent, result]), result), {
      ...IDENTITY,
      a: result.width / result.vector.viewWidth,
      d: result.height / result.vector.viewHeight,
    });

    assert.equal(canvasVectorPolygons(result.vector, world).length, 1);
  });

  it("returns an empty atomic removal for disjoint intersection and rejects open paths", () => {
    const nodes = [rectangle("a", 0, 0), rectangle("b", 500, 0)];
    assert.deepEqual(booleanCanvasVectors(nodes, ["a", "b"], "intersect"), {
      upsert: [],
      remove: ["a", "b"],
      selection: [],
    });

    const open = createCanvasVectorNode(
      "open",
      "Open",
      { ...vector, contours: [{ ...vector.contours[0], closed: false }] },
      { x: 0, y: 0, width: 100, height: 100 },
    );

    assert.throws(
      () => booleanCanvasVectors([open, nodes[0]], ["open", "a"], "union"),
      /Close every path/,
    );
  });
});
