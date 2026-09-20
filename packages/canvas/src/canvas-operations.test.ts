/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import type { CanvasFrame } from "./canvas-document";
import {
  adoptFrameContents,
  decodeCanvasClipboard,
  encodeCanvasClipboard,
  groupSelection,
  marqueeSelection,
  moveSelection,
  pasteCanvasClipboard,
  reparentSelection,
  resizeSelection,
  selectionBounds,
  selectionDescendants,
  selectionRoots,
  ungroupSelection,
} from "./canvas-operations";

function frame(id: string, overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  return { id, name: id, x: 0, y: 0, width: 400, height: 300, ...overrides } as CanvasFrame;
}

function rectangle(id: string, overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  return frame(id, { kind: "rectangle", fill: "#ffffff", width: 80, height: 60, ...overrides });
}

const scene = [
  frame("outer"),
  frame("inner", { parentId: "outer", x: 40, y: 40, width: 160, height: 160 }),
  rectangle("child", { parentId: "inner", x: 60, y: 60 }),
  rectangle("sibling", { parentId: "outer", x: 260, y: 60 }),
  rectangle("outside", { x: 500, y: 20 }),
];

function clipboardPayload(nodes: unknown) {
  return JSON.stringify({ type: "lra-canvas", version: 1, nodes });
}

describe("canvas selection geometry", () => {
  it("normalizes ancestor selections and includes every descendant exactly once", () => {
    assert.deepEqual(selectionRoots(scene, ["child", "outer", "outer", "missing"]), ["outer"]);
    assert.deepEqual(
      selectionDescendants(scene, ["child", "outer"]).map((node) => node.id),
      ["outer", "inner", "child", "sibling"],
    );
    assert.deepEqual(selectionRoots(scene, ["outside", "child"]), ["child", "outside"]);
  });

  it("bounds a selected frame by its crop, not by overflowing children", () => {
    const nodes = [...scene, rectangle("overflow", { parentId: "outer", x: -100, y: -100 })];
    assert.deepEqual(selectionBounds(nodes, ["outer", "overflow"]), {
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    assert.deepEqual(selectionBounds(nodes, ["child", "outside"]), {
      x: 60,
      y: 20,
      width: 520,
      height: 100,
    });
    assert.equal(selectionBounds(nodes, []), null);
  });

  it("moves nested content by the same world delta without touching unrelated nodes", () => {
    const moved = moveSelection(scene, ["inner", "child"], { x: 25, y: -10 });
    assert.deepEqual(
      moved.map(({ id, x, y }) => ({ id, x, y })),
      [
        { id: "inner", x: 65, y: 30 },
        { id: "child", x: 85, y: 50 },
      ],
    );
    assert.equal(scene[1].x, 40);
    assert.deepEqual(moveSelection(scene, ["outer"], { x: Infinity, y: 0 }), []);
  });

  it("resizing a frame only adjusts its crop and preserves child coordinates", () => {
    const changed = resizeSelection(scene, ["inner", "child"], scene[1], {
      x: 70,
      y: 80,
      width: 100,
      height: 200,
    });
    assert.deepEqual(changed, [{ ...scene[1], x: 70, y: 80, width: 100, height: 200 }]);
  });

  it("scales multiple selections and all nested descendants around the original bounds", () => {
    const start = selectionBounds(scene, ["inner", "sibling"])!;
    const changed = resizeSelection(scene, ["inner", "sibling"], start, {
      x: 0,
      y: 0,
      width: start.width * 2,
      height: start.height * 3,
    });
    assert.deepEqual(
      changed.map(({ id, x, y, width, height }) => ({ id, x, y, width, height })),
      [
        { id: "inner", x: 0, y: 0, width: 320, height: 480 },
        { id: "child", x: 40, y: 60, width: 160, height: 180 },
        { id: "sibling", x: 440, y: 60, width: 160, height: 180 },
      ],
    );
  });

  it("scales group typography while direct text box resizing keeps its font size", () => {
    const group = frame("group", { kind: "group", width: 100, height: 100 });
    const text: CanvasFrame = {
      ...rectangle("text", { parentId: "group", x: 10, y: 10 }),
      kind: "text",
      text: "Hello",
      fontSize: 20,
      color: "#fff",
    };
    const doubled = { x: 0, y: 0, width: 200, height: 200 };
    const changed = resizeSelection([group, text], ["group"], group, doubled);
    assert.equal(changed[1].kind === "text" && changed[1].fontSize, 40);
    const direct = resizeSelection([group, text], ["text"], text, doubled);
    assert.equal(direct[0].kind === "text" && direct[0].fontSize, 20);
  });

  it("rejects invalid resize bounds without producing invalid document geometry", () => {
    assert.deepEqual(
      resizeSelection(scene, ["outer"], scene[0], { x: 0, y: 0, width: 0, height: 5 }),
      [],
    );
    assert.deepEqual(
      resizeSelection(scene, ["outer"], scene[0], { x: NaN, y: 0, width: 50, height: 50 }),
      [],
    );
  });
});

describe("canvas automatic frame containment", () => {
  it("adopts dropped roots into the deepest frame and preserves world position", () => {
    const dropped = rectangle("new", { x: 50, y: 50 });
    assert.deepEqual(reparentSelection([...scene, dropped], ["new"]), [
      { ...dropped, parentId: "inner" },
    ]);
  });

  it("chooses the frontmost overlapping sibling frame", () => {
    const back = frame("back");
    const front = frame("front");
    const dropped = rectangle("new", { x: 50, y: 50 });
    assert.equal(reparentSelection([back, front, dropped], ["new"])[0].parentId, "front");
  });

  it("a front frame covers a deeper frame belonging to a background branch", () => {
    const front = frame("front");
    const dropped = rectangle("new", { x: 50, y: 50 });
    assert.equal(reparentSelection([...scene, front, dropped], ["new"])[0].parentId, "front");
  });

  it("preserves explicit group membership while editing a child", () => {
    const group = frame("group", { kind: "group", parentId: "outer" });
    const moved = rectangle("child", { parentId: "group", x: 1000, y: 1000 });
    assert.deepEqual(reparentSelection([scene[0], group, moved], ["child"]), []);
  });

  it("detaches a node moved out of all frames", () => {
    const moved = { ...scene[2], x: 700 };
    const nodes = scene.map((node) => (node.id === moved.id ? moved : node));
    assert.equal(reparentSelection(nodes, ["child"])[0].parentId, undefined);
  });

  it("does not turn a descendant or another selected subtree into a parent", () => {
    assert.deepEqual(reparentSelection(scene, ["outer", "inner", "child"]), []);
    const siblingFrame = frame("also-moving", { x: -100, y: -100, width: 1000, height: 1000 });
    assert.deepEqual(reparentSelection([...scene, siblingFrame], ["outer", "also-moving"]), []);
  });

  it("does not drop into invisible overflow of a clipped ancestor", () => {
    const outer = frame("outer", { width: 100, height: 100 });
    const overflow = frame("overflow", { parentId: "outer", x: 200, y: 200 });
    const dropped = rectangle("new", { x: 250, y: 250 });
    assert.deepEqual(reparentSelection([outer, overflow, dropped], ["new"]), []);
    assert.equal(
      reparentSelection(
        [{ ...outer, clipContent: false } as CanvasFrame, overflow, dropped],
        ["new"],
      )[0].parentId,
      "overflow",
    );
  });

  it("excludes locked frames and frames inside locked containers", () => {
    const locked = scene.map((node) => (node.id === "outer" ? { ...node, locked: true } : node));
    assert.deepEqual(
      reparentSelection([...locked, rectangle("new", { x: 50, y: 50 })], ["new"]),
      [],
    );
  });

  it("a newly drawn frame wraps only fully contained unlocked siblings", () => {
    const wrapper = frame("wrapper", { parentId: "outer", x: 30, y: 30, width: 210, height: 210 });
    const locked = rectangle("locked", { parentId: "outer", x: 50, y: 50, locked: true });
    const partial = rectangle("partial", { parentId: "outer", x: 200, y: 100 });
    assert.deepEqual(adoptFrameContents([...scene, wrapper, locked, partial], "wrapper"), [
      { ...scene[1], parentId: "wrapper" },
    ]);
    assert.deepEqual(adoptFrameContents(scene, "child"), []);
  });

  it("requires full containment when deciding a newly drawn wrapper's parent", () => {
    const inner = frame("inner", { x: 50, y: 50, width: 100, height: 100 });
    const wrapper = frame("wrapper", { width: 200, height: 200 });
    assert.deepEqual(
      reparentSelection([inner, wrapper], ["wrapper"], { requireContainment: true }),
      [],
    );
    assert.deepEqual(adoptFrameContents([inner, wrapper], "wrapper"), [
      { ...inner, parentId: "wrapper" },
    ]);
  });
});

describe("canvas grouping", () => {
  it("creates a group in the common parent and preserves world coordinates", () => {
    const plan = groupSelection(scene, ["inner", "child", "sibling"], { id: "group" })!;
    assert.deepEqual(plan.selection, ["group"]);
    assert.deepEqual(plan.remove, []);
    assert.deepEqual(plan.upsert[0], {
      id: "group",
      name: "Group",
      kind: "group",
      parentId: "outer",
      x: 40,
      y: 40,
      width: 300,
      height: 160,
    });
    assert.deepEqual(plan.upsert.slice(1), [
      { ...scene[1], parentId: "group" },
      { ...scene[3], parentId: "group" },
    ]);
  });

  it("groups nodes from separate branches at their lowest common ancestor", () => {
    const plan = groupSelection(scene, ["child", "sibling"], { id: "group" })!;
    assert.equal(plan.upsert[0].parentId, "outer");
    const root = groupSelection(scene, ["child", "outside"], { id: "group" })!;
    assert.equal(root.upsert[0].parentId, undefined);
  });

  it("supports wrapping one object and does not create empty groups or duplicate IDs", () => {
    assert.equal(groupSelection(scene, [], { id: "group" }), null);
    const single = groupSelection(scene, ["outer", "child"], { id: "group" })!;
    assert.deepEqual(
      single.upsert.map((node) => node.id),
      ["group", "outer"],
    );
    assert.equal(single.upsert[1].parentId, "group");
    assert.equal(groupSelection(scene, ["child", "sibling"], { id: "outer" }), null);
  });

  it("ungroups direct children without destroying nested subtrees", () => {
    const plan = groupSelection(scene, ["inner", "sibling"], { id: "group" })!;
    const updates = new Map(plan.upsert.map((node) => [node.id, node]));
    const grouped = [...scene.map((node) => updates.get(node.id) ?? node), plan.upsert[0]];
    const ungrouped = ungroupSelection(grouped, ["group", "outside"]);
    assert.deepEqual(ungrouped.remove, ["group"]);
    assert.deepEqual(ungrouped.upsert, [scene[1], scene[3]]);
    assert.deepEqual(ungrouped.selection, ["outside", "inner", "sibling"]);
    assert.equal(grouped.find((node) => node.id === "child")?.parentId, "inner");
  });
});

describe("canvas marquee", () => {
  it("selects enclosed nodes and removes descendants when a container is enclosed", () => {
    assert.deepEqual(marqueeSelection(scene, { x: -10, y: -10, width: 420, height: 320 }), [
      "outer",
    ]);
    assert.deepEqual(marqueeSelection(scene, { x: 55, y: 55, width: 90, height: 70 }), ["child"]);
    assert.deepEqual(marqueeSelection(scene, { x: 61, y: 61, width: 10, height: 10 }), []);
  });

  it("ignores locked objects and every descendant of a locked container", () => {
    const locked = scene.map((node) => (node.id === "outer" ? { ...node, locked: true } : node));
    assert.deepEqual(marqueeSelection(locked, { x: -10, y: -10, width: 1000, height: 1000 }), [
      "outside",
    ]);
  });

  it("uses visible clipped bounds and excludes completely hidden children", () => {
    const outer = frame("outer", { width: 100, height: 100 });
    const partial = rectangle("partial", {
      parentId: "outer",
      x: 80,
      y: 20,
      width: 80,
      height: 40,
    });
    const hidden = rectangle("hidden", { parentId: "outer", x: 150, y: 20 });
    const nodes = [outer, partial, hidden];
    assert.deepEqual(marqueeSelection(nodes, { x: 79, y: 19, width: 22, height: 42 }), ["partial"]);
    assert.deepEqual(marqueeSelection(nodes, { x: 110, y: 0, width: 300, height: 200 }), []);
    const unclipped = frame("outer", { width: 100, height: 100, clipContent: false });
    assert.deepEqual(
      marqueeSelection([unclipped, partial, hidden], { x: 110, y: 0, width: 300, height: 200 }),
      ["hidden"],
    );
  });

  it("intersects every ancestor clip and allows group overflow", () => {
    const nodes = [
      frame("outer", { width: 100, height: 100 }),
      frame("inner", { parentId: "outer", x: 80, width: 100, height: 100 }),
      frame("group", { kind: "group", parentId: "inner", x: 80, width: 1, height: 1 }),
      rectangle("child", { parentId: "group", x: 95, y: 30, width: 50, height: 40 }),
    ];
    assert.deepEqual(marqueeSelection(nodes, { x: 94, y: 29, width: 7, height: 42 }), ["child"]);
  });
});

describe("canvas clipboard", () => {
  it("round-trips nested frame content with self-contained parent references", () => {
    const serialized = encodeCanvasClipboard(scene, ["inner", "child"])!;
    const decoded = decodeCanvasClipboard(serialized)!;
    assert.deepEqual(
      decoded.map((node) => node.id),
      ["inner", "child"],
    );
    assert.equal(decoded[0].parentId, undefined);
    assert.equal(decoded[1].parentId, "inner");
    assert.equal(decoded[1].x, 60);
    assert.equal(encodeCanvasClipboard(scene, []), null);
  });

  it("pastes with fresh IDs, remapped internal parents, and one common offset", () => {
    const decoded = decodeCanvasClipboard(encodeCanvasClipboard(scene, ["inner", "outside"])!)!;
    let sequence = 0;
    const pasted = pasteCanvasClipboard(decoded, { x: 24, y: -12 }, () => `pasted-${++sequence}`);
    assert.deepEqual(pasted.selection, ["pasted-1", "pasted-3"]);
    assert.equal(pasted.nodes[0].parentId, undefined);
    assert.equal(pasted.nodes[1].parentId, "pasted-1");
    assert.deepEqual(
      pasted.nodes.map(({ x, y }) => ({ x, y })),
      [
        { x: 64, y: 28 },
        { x: 84, y: 48 },
        { x: 524, y: 8 },
      ],
    );
    assert.equal(decoded[0].id, "inner");
  });

  it("does not preserve external parents even when duplicating nodes directly", () => {
    const pasted = pasteCanvasClipboard([scene[2]], { x: 0, y: 0 }, () => "new");
    assert.equal(pasted.nodes[0].parentId, undefined);
    assert.deepEqual(pasted.selection, ["new"]);
  });

  it("preserves groups, clipping settings, and node content", () => {
    const nodes = [
      frame("frame", { clipContent: false, locked: true }),
      frame("group", { kind: "group", parentId: "frame" }),
      {
        ...frame("text", { parentId: "group", width: 80, height: 60 }),
        kind: "text",
        text: "Two\nlines",
        fontSize: 24,
        color: "#fff",
      } as CanvasFrame,
    ];
    assert.deepEqual(decodeCanvasClipboard(encodeCanvasClipboard(nodes, ["frame"])!), nodes);
  });

  it("rejects malformed, foreign, obsolete, duplicate, and cyclic payloads", () => {
    for (const text of [
      "text",
      "{}",
      "[]",
      JSON.stringify({ type: "lra-canvas", version: 2, nodes: scene }),
    ]) {
      assert.equal(decodeCanvasClipboard(text), null);
    }
    assert.equal(decodeCanvasClipboard(clipboardPayload([{ ...scene[0], width: "400" }])), null);
    assert.equal(decodeCanvasClipboard(clipboardPayload([scene[0], scene[0]])), null);
    assert.equal(
      decodeCanvasClipboard(
        clipboardPayload([frame("a", { parentId: "b" }), frame("b", { parentId: "a" })]),
      ),
      null,
    );
    assert.equal(
      decodeCanvasClipboard(
        clipboardPayload([frame("a", { kind: "iframe" } as unknown as Partial<CanvasFrame>)]),
      ),
      null,
    );
  });

  it("detects an invalid ID factory rather than corrupting the document", () => {
    assert.throws(() => pasteCanvasClipboard(scene, { x: 0, y: 0 }, () => "same"), /unique/);
  });
});
