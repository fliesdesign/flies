import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasDocument, loadCanvasFrames, type CanvasFrame } from "./canvas-document";
import { CanvasHitTester } from "./canvas-hit-test";
import {
  decodeCanvasClipboard,
  encodeCanvasClipboard,
  groupSelection,
  resizeSelection,
  ungroupSelection,
} from "./canvas-operations";
import { CANVAS_BLEND_MODES } from "./canvas-paint";
import { packCanvasProject, unpackCanvasProject } from "./canvas-project";
import { changeCanvasProperty } from "./canvas-properties";
import {
  frameSource,
  worldCorners,
  worldTransform,
  transformPoint,
  moveSelectionWorld,
  reparentTransformed,
  worldBounds,
} from "./canvas-transform";

const rect: CanvasFrame = {
  id: "rect",
  name: "Rectangle",
  kind: "rectangle",
  x: 30,
  y: 50,
  width: 160,
  height: 80,
  fill: "#f00",
};

const measure = () => 30;

const near = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);

function sameCorners(a: CanvasFrame[], b: CanvasFrame[], id: string) {
  const first = frameSource(a),
    second = frameSource(b);

  worldCorners(first, first.getFrame(id)!).forEach((p, i) => {
    const q = worldCorners(second, second.getFrame(id)!)[i];
    near(p.x, q.x);
    near(p.y, q.y);
  });
}

describe("native paint", () => {
  it("validates, freezes, persists and undoes all new fields", () => {
    const node: CanvasFrame = {
      ...rect,
      rotation: 37,
      blendMode: "multiply",
      gradient: {
        type: "radial",
        angle: 25,
        stops: [
          { offset: 0, color: "#abcd" },
          { offset: 1, color: "#fedcba" },
        ],
      },
      filters: { blur: 8, brightness: 1.2, hue: -30 },
    };

    const doc = new CanvasDocument([node]);
    assert.ok(Object.isFrozen(doc.getFrame(rect.id)?.gradient?.stops[0]));
    assert.ok(Object.isFrozen(doc.getFrame(rect.id)?.filters));

    const restored = unpackCanvasProject(
      packCanvasProject("Paint", doc.getFrames(), doc.getTheme()),
    );

    assert.deepEqual(restored.nodes, doc.getFrames());
    assert.deepEqual(
      loadCanvasFrames({ getItem: () => JSON.stringify(doc.getFrames()) }),
      doc.getFrames(),
    );
    doc.updateMany(
      changeCanvasProperty(doc.getFrames(), [rect.id], "filterValue", 16, measure, {
        filterName: "blur",
      }),
    );
    assert.equal(doc.getFrame(rect.id)?.filters?.blur, 16);
    doc.undo();
    assert.equal(doc.getFrame(rect.id)?.filters?.blur, 8);
    doc.redo();
    assert.equal(doc.getFrame(rect.id)?.filters?.blur, 16);
    for (const mode of CANVAS_BLEND_MODES)
      assert.ok(new CanvasDocument([{ ...node, blendMode: mode }]));
    for (const patch of [
      { rotation: Infinity },
      { blendMode: "unsupported" },
      { filters: { blur: -1 } },
      { filters: { evil: 1 } },
      { filters: { brightness: NaN } },
      {
        gradient: {
          ...node.gradient,
          stops: [
            { offset: 0.8, color: "#fff" },
            { offset: 0.1, color: "#000" },
          ],
        },
      },
    ])
      assert.throws(() => new CanvasDocument([{ ...node, ...patch } as CanvasFrame]));
  });
  it("gradient edits stay ordered, preserve alpha, and respect locks", () => {
    let nodes = changeCanvasProperty([rect], [rect.id], "gradientType", "linear", measure);
    nodes = changeCanvasProperty(nodes, [rect.id], "gradientStopAdd", true, measure);
    assert.equal(nodes[0].gradient?.stops.length, 3);
    nodes = changeCanvasProperty(nodes, [rect.id], "gradientStopColor", "#12345680", measure, {
      gradientStop: 1,
    });
    nodes = changeCanvasProperty(nodes, [rect.id], "gradientStopOffset", 1, measure, {
      gradientStop: 0,
    });
    assert.equal(nodes[0].gradient?.stops[0].offset, 0.5);
    assert.equal(nodes[0].gradient?.stops[1].color, "#12345680");
    assert.deepEqual(
      changeCanvasProperty([{ ...nodes[0], locked: true }], [rect.id], "rotation", 90, measure),
      [],
    );
  });
});

describe("rotation geometry", () => {
  const parent: CanvasFrame = {
    id: "parent",
    name: "Parent",
    x: 100,
    y: 100,
    width: 300,
    height: 200,
    rotation: 90,
    clipContent: false,
  };

  const child: CanvasFrame = { ...rect, parentId: parent.id, x: 120, y: 130, rotation: 25 };

  const other: CanvasFrame = {
    id: "other",
    name: "Other",
    x: 500,
    y: 300,
    width: 400,
    height: 400,
    rotation: -40,
  };

  it("transforms nested picking and updates inherited spatial bounds", () => {
    const doc = new CanvasDocument([parent, child]);
    const tester = new CanvasHitTester(doc);
    const stop = tester.connect();
    const point = transformPoint(worldTransform(doc, doc.getFrame(child.id)!), { x: 30, y: 20 });
    assert.equal(tester.hit(point), child.id);
    doc.update({ ...parent, rotation: 180 });
    const changed = transformPoint(worldTransform(doc, doc.getFrame(child.id)!), { x: 30, y: 20 });
    assert.equal(tester.hit(changed), child.id);
    assert.notEqual(tester.hit(point), child.id);
    stop();
  });
  it("moving a child follows world axes inside a rotated parent", () => {
    const nodes = [parent, child];
    const moved = moveSelectionWorld(nodes, [child.id], { x: 20, y: -10 });
    const after = [parent, ...moved];

    const a = worldBounds(frameSource(nodes), child),
      b = worldBounds(frameSource(after), moved[0]);

    near(b.x - a.x, 20);
    near(b.y - a.y, -10);
  });
  it("reparenting, layer moves and clipboard preserve inherited world poses", () => {
    const grandchild: CanvasFrame = {
      ...rect,
      id: "grandchild",
      kind: "rectangle",
      parentId: "child-frame",
      x: 135,
      y: 145,
    };

    const childFrame: CanvasFrame = {
      ...child,
      id: "child-frame",
      kind: "frame",
      width: 200,
      height: 160,
    };

    const nodes = [parent, childFrame, grandchild, other];

    const patches = new Map(
      reparentTransformed(nodes, childFrame.id, other.id).map((node) => [node.id, node]),
    );

    const after = nodes.map((node) => patches.get(node.id) ?? node);
    sameCorners(nodes, after, childFrame.id);
    sameCorners(nodes, after, grandchild.id);
    const doc = new CanvasDocument(nodes);
    assert.ok(doc.moveLayers([childFrame.id], other.id, "inside"));
    sameCorners(nodes, doc.getFrames(), grandchild.id);
    doc.undo();
    sameCorners(nodes, doc.getFrames(), childFrame.id);
    const clipboard = decodeCanvasClipboard(encodeCanvasClipboard(nodes, [childFrame.id])!)!;
    sameCorners(nodes, clipboard, childFrame.id);
    sameCorners(nodes, clipboard, grandchild.id);
  });
  it("grouping and ungrouping rotated roots does not move their artwork", () => {
    const nodes = [parent, child, { ...rect, id: "second", x: 540, y: 340, rotation: 50 }];
    const plan = groupSelection(nodes, [child.id, "second"], { id: "group" })!;
    const doc = new CanvasDocument(nodes);
    assert.ok(
      doc.transact({
        add: plan.upsert.filter((node) => !doc.getFrame(node.id)),
        update: plan.upsert.filter((node) => doc.getFrame(node.id)),
      }),
    );
    sameCorners(nodes, doc.getFrames(), child.id);
    sameCorners(nodes, doc.getFrames(), "second");
    const ungroup = ungroupSelection(doc.getFrames(), ["group"]);
    assert.ok(doc.transact({ update: ungroup.upsert, remove: ungroup.remove }));
    sameCorners(nodes, doc.getFrames(), child.id);
  });
});

it("rotated frame resizing crops without moving nested contents", () => {
  const parent: CanvasFrame = {
    ...rect,
    id: "parent",
    kind: "frame",
    rotation: 37,
    width: 240,
    height: 180,
  };

  const child: CanvasFrame = {
    ...rect,
    id: "child",
    parentId: parent.id,
    rotation: 19,
    x: 80,
    y: 100,
  };

  const nodes = [parent, child];

  for (const next of [
    { x: 20, y: 15, width: 300, height: 230 },
    { x: 30, y: 50, width: 300, height: 180 },
  ]) {
    const updates = resizeSelection(nodes, [parent.id], parent, next);
    sameCorners(nodes, updates, child.id);
  }
});

it("group bounds include rotated children and keep their world pose when recomputed", () => {
  const group: CanvasFrame = {
    ...rect,
    id: "group",
    kind: "group",
    rotation: 35,
    width: 240,
    height: 180,
  };

  const child: CanvasFrame = {
    ...rect,
    id: "child",
    parentId: group.id,
    rotation: 20,
    x: 80,
    y: 100,
  };

  const doc = new CanvasDocument([group, child]);
  const before = doc.getFrames();
  const changed = { ...doc.getFrame(child.id)!, rotation: 65, x: 140 };
  const intended = before.map((node) => (node.id === child.id ? changed : node));
  doc.updateMany([changed]);
  sameCorners(intended, doc.getFrames(), child.id);
  const parent = doc.getFrame(group.id)!;
  near(parent.width, 160 * Math.cos((65 * Math.PI) / 180) + 80 * Math.sin((65 * Math.PI) / 180));
  doc.undo();
  sameCorners(before, doc.getFrames(), child.id);
});

it("gradient interpolation and filter order persist, freeze and retain UI edits", () => {
  const node: CanvasFrame = {
    ...rect,
    gradient: {
      type: "linear",
      angle: 0,
      interpolation: "oklab",
      background: "#fff",
      stops: [
        { offset: 0, color: "#f00" },
        { offset: 1, color: "#00f" },
      ],
    },
    filters: { brightness: 0.5, contrast: 0.6, order: ["contrast", "brightness"] },
  };

  const doc = new CanvasDocument([node]);
  assert.ok(Object.isFrozen(doc.getFrame(rect.id)!.filters!.order));

  const changed = changeCanvasProperty(
    doc.getFrames(),
    [rect.id],
    "gradientType",
    "radial",
    measure,
  );

  assert.equal(changed[0].gradient?.interpolation, "oklab");
  assert.equal(changed[0].gradient?.background, "#fff");
  const restored = unpackCanvasProject(packCanvasProject("Paint", doc.getFrames(), doc.getTheme()));
  assert.deepEqual(restored.nodes, doc.getFrames());

  for (const filters of [{ order: ["blur", "blur"] }, { order: ["invalid"] }, { order: "blur" }]) {
    assert.equal(doc.updateMany([{ ...node, filters } as unknown as CanvasFrame]), false);
  }
});
