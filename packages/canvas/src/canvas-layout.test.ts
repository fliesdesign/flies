/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CanvasDocument,
  loadCanvasFrames,
  saveCanvasFrames,
  type CanvasFrame,
  type CanvasFrameNode,
} from "./canvas-document";
import {
  canvasLayoutPositions,
  DEFAULT_CANVAS_LAYOUT,
  isCanvasLayout,
  type CanvasLayout,
} from "./canvas-layout";

const layout: CanvasLayout = {
  direction: "row",
  gap: 10,
  padding: 20,
  align: "start",
  justify: "start",
};

const parent: CanvasFrameNode = {
  id: "parent",
  name: "Parent",
  x: 100,
  y: 200,
  width: 300,
  height: 160,
  layout,
};

function child(id: string, overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  return {
    id,
    name: id,
    kind: "rectangle",
    x: 0,
    y: 0,
    width: 50,
    height: 40,
    fill: "#fff",
    parentId: "parent",
    ...overrides,
  } as CanvasFrame;
}

function position(document: CanvasDocument, id: string) {
  const node = document.getFrame(id)!;

  return { x: node.x, y: node.y };
}

describe("fixed-size canvas auto layout", () => {
  it("positions rows in world coordinates with padding and gaps", () => {
    assert.deepEqual(
      [...canvasLayoutPositions(parent, [child("a"), child("b")])],
      [
        ["a", { x: 120, y: 220 }],
        ["b", { x: 180, y: 220 }],
      ],
    );
  });

  it("positions columns with independent cross-axis alignment and main-axis justification", () => {
    const column = {
      ...parent,
      layout: {
        ...layout,
        direction: "column" as const,
        align: "end" as const,
        justify: "center" as const,
      },
    };

    assert.deepEqual(
      [...canvasLayoutPositions(column, [child("a"), child("b", { width: 80 })])],
      [
        ["a", { x: 330, y: 235 }],
        ["b", { x: 300, y: 285 }],
      ],
    );
  });

  it("distributes free space, keeping the configured gap as the minimum during overflow", () => {
    const distributed = {
      ...parent,
      layout: { ...layout, justify: "space-between" as const, align: "center" as const },
    };

    assert.deepEqual(
      [...canvasLayoutPositions(distributed, [child("a"), child("b")])],
      [
        ["a", { x: 120, y: 260 }],
        ["b", { x: 330, y: 260 }],
      ],
    );

    const positions = canvasLayoutPositions({ ...distributed, width: 100 }, [
      child("a"),
      child("b"),
    ]);

    assert.deepEqual(positions.get("b"), { x: 180, y: 260 });
    assert.equal(canvasLayoutPositions(distributed, [child("a")]).get("a")?.x, 120);
  });

  it("omits hidden children without reserving their space", () => {
    const positions = canvasLayoutPositions(parent, [
      child("a"),
      child("hidden", { hidden: true }),
      child("b"),
    ]);

    assert.equal(positions.size, 2);
    assert.equal(positions.get("b")?.x, 180);
    assert.equal(canvasLayoutPositions({ ...parent, layout: undefined }, [child("a")]).size, 0);
  });

  it("rejects malformed or non-finite layout options", () => {
    assert.ok(isCanvasLayout(DEFAULT_CANVAS_LAYOUT));

    for (const invalid of [
      null,
      [],
      {},
      { ...layout, gap: -1 },
      { ...layout, gap: NaN },
      { ...layout, padding: Infinity },
      { ...layout, direction: "grid" },
      { ...layout, align: "stretch" },
      { ...layout, justify: "between" },
    ]) {
      assert.equal(isCanvasLayout(invalid), false);
    }
  });
});

describe("auto layout document operations", () => {
  it("rejects arithmetic overflow during load, update and preview without publishing invalid geometry", () => {
    const overflowing: CanvasFrameNode = {
      ...parent,
      x: 1e308,
      layout: { ...layout, padding: 1e308 },
    };

    assert.throws(() => new CanvasDocument([overflowing, child("a")]), /finite, valid bounds/);
    const document = new CanvasDocument([{ ...parent, x: 1e308 }, child("a")]);
    const initial = document.getFrames();
    const snapshot = document.getSnapshot();
    let notifications = 0;
    document.subscribeFrame("a", () => notifications++);
    assert.equal(document.update(overflowing), false);
    assert.deepEqual(document.getFrames(), initial);
    assert.strictEqual(document.getSnapshot(), snapshot);
    document.beginGesture("parent");
    assert.equal(document.preview(overflowing), false);
    assert.deepEqual(document.getFrames(), initial);
    assert.deepEqual(document.getCommittedFrames(), initial);
    assert.equal(notifications, 0);
    document.endGesture();
    assert.equal(document.getHistoryStats().undoEntries, 0);
    assert.equal(document.replaceAll([overflowing, child("a")]), false);
    assert.deepEqual(document.getFrames(), initial);
  });

  it("normalizes loaded layout and deeply freezes, validates and persists its options", () => {
    const incoming = { ...layout };
    const document = new CanvasDocument([{ ...parent, layout: incoming }, child("a")]);
    incoming.gap = 999;
    const stored = document.getFrame("parent") as CanvasFrameNode;
    assert.equal(stored.layout?.gap, 10);
    assert.ok(Object.isFrozen(stored.layout));
    assert.deepEqual(position(document, "a"), { x: 120, y: 220 });
    assert.equal(document.getHistoryStats().undoEntries, 0);
    let saved = "";
    saveCanvasFrames(document.getFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(loadCanvasFrames({ getItem: () => saved }), document.getFrames());
    const invalid = { ...parent, layout: { ...layout, gap: -10 } };
    assert.equal(document.update(invalid), false);
    assert.equal(document.getHistoryStats().undoEntries, 0);
    assert.deepEqual(
      loadCanvasFrames({ getItem: () => JSON.stringify({ version: 2, nodes: [invalid] }) }),
      [],
    );
    assert.throws(
      () =>
        new CanvasDocument([{ ...child("bad", { parentId: undefined }), layout } as CanvasFrame]),
    );
  });

  it("enables layout and restores the freely placed document in one undo", () => {
    const nodes = [
      { ...parent, layout: undefined },
      child("a", { x: 501, y: 302 }),
      child("b", { x: -5, y: -10 }),
    ];

    const document = new CanvasDocument(nodes);
    const original = document.getFrames();
    document.update(parent);
    assert.deepEqual(position(document, "b"), { x: 180, y: 220 });
    assert.equal(document.getHistoryStats().undoEntries, 1);
    const laidOut = document.getFrames();
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.redo();
    assert.deepEqual(document.getFrames(), laidOut);
    document.update({ ...parent, layout: undefined });
    assert.deepEqual(position(document, "b"), { x: 180, y: 220 });
  });

  it("reflows on size, visibility, insertion, deletion and order changes", () => {
    const document = new CanvasDocument([parent, child("a"), child("b")]);
    document.update({ ...document.getFrame("a")!, width: 80 });
    assert.equal(document.getFrame("b")?.x, 210);
    document.update({ ...document.getFrame("a")!, hidden: true });
    assert.equal(document.getFrame("b")?.x, 120);
    document.add(child("c"));
    assert.equal(document.getFrame("c")?.x, 180);
    document.reorder(["c"], "back");
    assert.equal(document.getFrame("c")?.x, 120);
    assert.equal(document.getFrame("b")?.x, 180);
    const reordered = document.getFrames();
    document.remove("c");
    assert.equal(document.getFrame("b")?.x, 120);
    document.undo();
    assert.deepEqual(document.getFrames(), reordered);
    document.undo();
    assert.equal(document.getFrame("b")?.x, 120);
    assert.equal(document.getFrame("c")?.x, 180);
  });

  it("translates child descendants and resolves nested layouts before parent positioning", () => {
    const inner: CanvasFrameNode = {
      id: "inner",
      name: "Inner",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      parentId: "parent",
      layout: { ...layout, direction: "column", padding: 5, gap: 4 },
    };

    const nested = child("nested", { parentId: "inner", width: 20, height: 20 });

    const document = new CanvasDocument([
      parent,
      child("a"),
      inner,
      nested,
      child("nested2", { parentId: "inner", width: 20, height: 20 }),
    ]);

    assert.deepEqual(position(document, "inner"), { x: 180, y: 220 });
    assert.deepEqual(position(document, "nested"), { x: 185, y: 225 });
    assert.deepEqual(position(document, "nested2"), { x: 185, y: 249 });
    const original = document.getFrames();
    document.update({ ...document.getFrame("a")!, width: 90 });
    assert.deepEqual(position(document, "nested"), { x: 225, y: 225 });
    document.update({ ...document.getFrame("nested")!, height: 40 });
    assert.deepEqual(position(document, "nested2"), { x: 225, y: 269 });
    document.undo();
    document.undo();
    assert.deepEqual(document.getFrames(), original);
  });

  it("derives group bounds before positioning the group and translates all of its children", () => {
    const group: CanvasFrame = {
      id: "group",
      name: "Group",
      kind: "group",
      parentId: "parent",
      x: 0,
      y: 0,
      width: 50,
      height: 40,
    };

    const document = new CanvasDocument([
      parent,
      group,
      child("inside", { parentId: "group" }),
      child("b"),
    ]);

    assert.deepEqual(position(document, "inside"), { x: 120, y: 220 });
    const before = document.getFrames();
    document.update({ ...document.getFrame("inside")!, width: 90 });
    assert.equal(document.getFrame("group")?.width, 90);
    assert.equal(document.getFrame("b")?.x, 220);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("reparents and reorders layers into their layout positions in one atomic history entry", () => {
    const second: CanvasFrameNode = { ...parent, id: "second", x: 500 };

    const document = new CanvasDocument([
      parent,
      child("a"),
      child("b"),
      second,
      child("c", { parentId: "second" }),
    ]);

    const before = document.getFrames();
    document.moveLayers(["a"], "second", "inside");
    assert.deepEqual(position(document, "a"), { x: 580, y: 220 });
    assert.equal(document.getFrame("a")?.parentId, "second");
    assert.equal(document.getFrame("b")?.x, 120);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    document.moveLayers(["b"], "a", "after");
    assert.equal(document.getFrame("b")?.x, 120);
    assert.equal(document.getFrame("a")?.x, 180);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("can translate a subtree while removing an emptied nested group in the same transaction", () => {
    const inner: CanvasFrameNode = {
      ...parent,
      id: "inner",
      parentId: "parent",
      width: 100,
      height: 100,
      layout: undefined,
    };

    const group: CanvasFrame = {
      id: "group",
      name: "Group",
      kind: "group",
      parentId: "inner",
      x: 0,
      y: 0,
      width: 50,
      height: 40,
    };

    const destination: CanvasFrameNode = {
      ...parent,
      id: "destination",
      x: 600,
      layout: undefined,
    };

    const document = new CanvasDocument([
      parent,
      child("a"),
      inner,
      group,
      child("nested", { parentId: "group" }),
      destination,
    ]);

    const before = document.getFrames();
    assert.equal(
      document.transact({
        update: [
          { ...document.getFrame("a")!, width: 100 },
          { ...document.getFrame("nested")!, parentId: "destination" },
        ],
      }),
      true,
    );
    assert.equal(document.getFrame("group"), undefined);
    assert.equal(document.getFrame("inner")?.x, 230);
    assert.equal(document.getFrame("nested")?.parentId, "destination");
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("previews derived sibling positions without persisting them and cancels or commits atomically", () => {
    const document = new CanvasDocument([parent, child("a"), child("b")]);
    const before = document.getFrames();
    const b = document.getFrame("b")!;
    let globalNotifications = 0;
    let bNotifications = 0;
    document.subscribe(() => globalNotifications++);
    document.subscribeFrame("b", () => bNotifications++);
    document.beginGesture("a");
    for (const width of [60, 80, 100]) document.preview({ ...document.getFrame("a")!, width });
    assert.equal(document.getFrame("b")?.x, 230);
    assert.equal(bNotifications, 3);
    assert.equal(globalNotifications, 0);
    assert.deepEqual(document.getCommittedFrames(), before);
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), before);
    assert.strictEqual(document.getFrame("b"), b);
    assert.equal(document.getHistoryStats().undoEntries, 0);
    document.beginGesture("a");
    document.preview({ ...document.getFrame("a")!, width: 120 });
    document.endGesture();
    assert.equal(document.getFrame("b")?.x, 250);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
  });

  it("restores derived descendants when an in-progress layout gesture returns to its start", () => {
    const document = new CanvasDocument([parent, child("a"), child("b")]);
    const before = document.getFrames();
    document.beginGesture("parent");
    document.preview({ ...parent, layout: { ...layout, padding: 40 } });
    document.preview(parent);
    document.endGesture();
    assert.deepEqual(document.getFrames(), before);
    assert.equal(document.getHistoryStats().undoEntries, 0);
  });

  it("leaves unrelated nodes and document snapshots untouched during local layout preview", () => {
    const unrelated = Array.from({ length: 10000 }, (_, index) =>
      child(`unrelated-${index}`, { parentId: undefined }),
    );

    const document = new CanvasDocument([parent, child("a"), child("b"), ...unrelated]);
    const snapshot = document.getSnapshot();
    const untouched = document.getFrame("unrelated-5000");
    let notifications = 0;
    document.subscribeFrame("unrelated-5000", () => notifications++);
    document.beginGesture("a");
    document.preview({ ...document.getFrame("a")!, width: 100 });
    assert.strictEqual(document.getFrame("unrelated-5000"), untouched);
    assert.strictEqual(document.getSnapshot(), snapshot);
    assert.equal(notifications, 0);
    assert.equal(document.getFrame("b")?.x, 230);
  });
});

describe("wrapping layout and bounded sizing", () => {
  it("wraps rows with per-side padding and a separate line gap, then updates hug height", () => {
    const document = new CanvasDocument([
      {
        ...parent,
        width: 260,
        heightSizing: "hug",
        layout: {
          ...layout,
          padding: 10,
          paddingTop: 15,
          paddingBottom: 25,
          rowGap: 20,
          wrap: true,
        },
      },
      child("a", { width: 100, height: 30 }),
      child("b", { width: 100, height: 30 }),
      child("c", { width: 100, height: 30 }),
    ]);

    assert.deepEqual(position(document, "a"), { x: 110, y: 215 });
    assert.deepEqual(position(document, "b"), { x: 220, y: 215 });
    assert.deepEqual(position(document, "c"), { x: 110, y: 265 });
    assert.equal(document.getFrame("parent")?.height, 120);
    document.update({ ...document.getFrame("parent")!, width: 150 });
    assert.equal(document.getFrame("parent")?.height, 170);
    assert.deepEqual(position(document, "c"), { x: 110, y: 315 });
    document.undo();
    assert.equal(document.getFrame("parent")?.height, 120);
  });

  it("wraps columns using horizontal line gap and independent padding", () => {
    const document = new CanvasDocument([
      {
        ...parent,
        height: 140,
        layout: {
          ...layout,
          direction: "column",
          padding: 10,
          paddingLeft: 15,
          paddingBottom: 20,
          wrap: true,
          rowGap: 15,
        },
      },
      child("a", { height: 50 }),
      child("b", { height: 50 }),
      child("c", { height: 50 }),
    ]);

    assert.deepEqual(position(document, "a"), { x: 115, y: 210 });
    assert.deepEqual(position(document, "b"), { x: 115, y: 270 });
    assert.deepEqual(position(document, "c"), { x: 180, y: 210 });
  });

  it("redistributes fill space when one child reaches its maximum", () => {
    const document = new CanvasDocument([
      { ...parent, width: 400 },
      child("a", { widthSizing: "fill", minWidth: 100, maxWidth: 120 }),
      child("b", { widthSizing: "fill", minWidth: 80 }),
    ]);

    assert.equal(document.getFrame("a")?.width, 120);
    assert.equal(document.getFrame("b")?.width, 230);
    assert.equal(document.getFrame("b")?.x, 250);
  });

  it("caps hugged frames and rejects malformed extended layout options", () => {
    const document = new CanvasDocument([
      { ...parent, widthSizing: "hug", maxWidth: 200 },
      child("a", { width: 150 }),
      child("b", { width: 150 }),
    ]);

    assert.equal(document.getFrame("parent")?.width, 200);
    for (const invalid of [
      { wrap: "true" },
      { rowGap: -1 },
      { paddingLeft: Infinity },
      { paddingTop: -2 },
    ])
      assert.equal(isCanvasLayout({ ...layout, ...invalid }), false);
  });
});

describe("mixed bounded fill allocation", () => {
  it("rebalances opposing minimum and maximum limits without exceeding available space", () => {
    const document = new CanvasDocument([
      { ...parent, width: 100, layout: { ...layout, padding: 0, gap: 0 } },
      child("min", { widthSizing: "fill", minWidth: 80 }),
      child("cap", { widthSizing: "fill", maxWidth: 10 }),
      child("flex", { widthSizing: "fill", maxWidth: 30 }),
    ]);

    assert.equal(document.getFrame("min")?.width, 80);
    assert.equal(document.getFrame("cap")?.width, 10);
    assert.equal(document.getFrame("flex")?.width, 10);
    assert.equal(document.getFrame("flex")!.x + document.getFrame("flex")!.width, parent.x + 100);
  });
});
