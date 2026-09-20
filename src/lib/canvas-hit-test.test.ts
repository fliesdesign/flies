/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import { CanvasHitTester } from "./canvas-hit-test";

function frame(id: string, overrides: Partial<CanvasFrame> = {}): CanvasFrame {
  return { id, name: id, x: 0, y: 0, width: 100, height: 100, ...overrides } as CanvasFrame;
}

function withTester(
  initial: readonly CanvasFrame[],
  run: (tester: CanvasHitTester, document: CanvasDocument) => void,
) {
  const document = new CanvasDocument(initial);
  const tester = new CanvasHitTester(document);
  const disconnect = tester.connect();
  try {
    run(tester, document);
  } finally {
    disconnect();
  }
}

describe("canvas world-space hit testing", () => {
  it("picks the top painted subtree, including reordered and interleaved input", () => {
    withTester(
      [frame("back"), frame("front"), frame("child", { parentId: "back" })],
      (tester, document) => {
        assert.equal(tester.hit({ x: 20, y: 20 }), "front");
        document.reorder(["back"], "front");
        assert.equal(tester.hit({ x: 20, y: 20 }), "child");
        document.undo();
        assert.equal(tester.hit({ x: 20, y: 20 }), "front");
        document.redo();
        assert.equal(tester.hit({ x: 20, y: 20 }), "child");
      },
    );
  });

  it("ignores hidden and locked subtrees and reflects changes to ancestors", () => {
    withTester(
      [frame("back"), frame("parent"), frame("child", { parentId: "parent" })],
      (tester, document) => {
        for (const flag of ["hidden", "locked"] as const) {
          document.update({ ...document.getFrame("parent")!, [flag]: true });
          assert.equal(tester.hit({ x: 20, y: 20 }), "back");
          document.update({ ...document.getFrame("parent")!, [flag]: false });
          assert.equal(tester.hit({ x: 20, y: 20 }), "child");
          document.update({ ...document.getFrame("child")!, [flag]: true });
          assert.equal(tester.hit({ x: 20, y: 20 }), "parent");
          document.update({ ...document.getFrame("child")!, [flag]: false });
        }
      },
    );
  });

  it("uses rounded body bounds for artboards and shapes", () => {
    withTester([frame("back"), frame("rounded", { cornerRadius: 50 })], (tester, document) => {
      assert.equal(tester.hit({ x: 1, y: 1 }), "back");
      assert.equal(tester.hit({ x: 50, y: 0 }), "rounded");
      assert.equal(tester.hit({ x: 20, y: 20 }), "rounded");
      document.remove("rounded");
      document.add(frame("rectangle", { kind: "rectangle", fill: "#fff", cornerRadius: 50 }));
      assert.equal(tester.hit({ x: 1, y: 1 }), "back");
      assert.equal(tester.hit({ x: 50, y: 50 }), "rectangle");
    });
  });

  it("intersects every rounded clipping ancestor, even when children overflow", () => {
    withTester(
      [
        frame("back", { x: -100, y: -100, width: 500, height: 500 }),
        frame("parent", { cornerRadius: 50 }),
        frame("inner", { parentId: "parent", x: -10, y: -10, width: 200, height: 200 }),
        frame("child", { parentId: "inner", x: -10, y: -10, width: 200, height: 200 }),
      ],
      (tester, document) => {
        assert.equal(tester.hit({ x: 1, y: 1 }), "back");
        assert.equal(tester.hit({ x: 150, y: 50 }), "back");
        assert.equal(tester.hit({ x: 50, y: 50 }), "child");
        document.update({ ...document.getFrame("parent")!, kind: "frame", clipContent: false });
        assert.equal(tester.hit({ x: 1, y: 1 }), "child");
        assert.equal(tester.hit({ x: 150, y: 50 }), "child");
      },
    );
  });

  it("keeps transparent groups and text editable within their full bounds", () => {
    withTester(
      [
        frame("group", { kind: "group" }),
        frame("text", {
          kind: "text",
          parentId: "group",
          width: 20,
          height: 20,
          text: "Hello",
          fontSize: 16,
          color: "#000",
        }),
        frame("spacer", {
          kind: "rectangle",
          fill: "#fff",
          parentId: "group",
          x: 80,
          y: 80,
          width: 20,
          height: 20,
        }),
      ],
      (tester) => {
        assert.equal(tester.hit({ x: 10, y: 10 }), "text");
        assert.equal(tester.hit({ x: 50, y: 50 }), "group");
      },
    );
  });

  it("updates only committed index entries across moving, adding, deleting and undo", () => {
    withTester([frame("moving")], (tester, document) => {
      document.update(frame("moving", { x: 5000 }));
      assert.equal(tester.hit({ x: 20, y: 20 }), undefined);
      assert.equal(tester.hit({ x: 5020, y: 20 }), "moving");
      document.add(frame("new"));
      assert.equal(tester.hit({ x: 20, y: 20 }), "new");
      document.remove("new");
      assert.equal(tester.hit({ x: 20, y: 20 }), undefined);
      document.undo();
      assert.equal(tester.hit({ x: 20, y: 20 }), "new");
    });
  });

  it("uses preview bounds outside indexed cells and restores cancelled gestures", () => {
    withTester([frame("moving")], (tester, document) => {
      document.beginGesture("moving");
      document.preview(frame("moving", { x: 5000 }));
      assert.equal(tester.hit({ x: 20, y: 20 }), undefined);
      assert.equal(tester.hit({ x: 5020, y: 20 }), "moving");
      document.endGesture(true);
      assert.equal(tester.hit({ x: 20, y: 20 }), "moving");
      assert.equal(tester.hit({ x: 5020, y: 20 }), undefined);
      document.beginGesture("moving");
      document.preview(frame("moving", { x: -5000 }));
      document.endGesture();
      assert.equal(tester.hit({ x: -4980, y: 20 }), "moving");
      assert.equal(tester.hit({ x: 20, y: 20 }), undefined);
    });
  });

  it("picks live derived layout changes without subscriptions to individual nodes", () => {
    withTester(
      [
        frame("row", {
          width: 6000,
          layout: { direction: "row", gap: 0, padding: 0, align: "start", justify: "start" },
        }),
        frame("first", { parentId: "row" }),
        frame("second", { parentId: "row" }),
      ],
      (tester, document) => {
        assert.equal(tester.hit({ x: 120, y: 20 }), "second");
        document.beginGesture("first");
        document.preview({ ...document.getFrame("first")!, width: 5000 });
        assert.equal(tester.hit({ x: 120, y: 20 }), "first");
        assert.equal(tester.hit({ x: 5020, y: 20 }), "second");
        document.endGesture(true);
        assert.equal(tester.hit({ x: 120, y: 20 }), "second");
        assert.equal(tester.hit({ x: 5020, y: 20 }), "row");
      },
    );
  });

  it("initializes committed bounds when connected during an active gesture", () => {
    const document = new CanvasDocument([frame("moving")]);
    document.beginGesture("moving");
    document.preview(frame("moving", { x: 5000 }));
    const tester = new CanvasHitTester(document);
    const disconnect = tester.connect();
    assert.equal(tester.hit({ x: 5020, y: 20 }), "moving");
    document.endGesture(true);
    assert.equal(tester.hit({ x: 20, y: 20 }), "moving");
    assert.equal(tester.hit({ x: 5020, y: 20 }), undefined);
    disconnect();
  });

  it("refreshes edits made while disconnected", () => {
    const document = new CanvasDocument([frame("old")]);
    const tester = new CanvasHitTester(document);
    tester.connect()();
    document.replaceAll([frame("new", { x: 5000 })]);
    const disconnect = tester.connect();
    assert.equal(tester.hit({ x: 20, y: 20 }), undefined);
    assert.equal(tester.hit({ x: 5020, y: 20 }), "new");
    disconnect();
  });

  it("does not walk distant nodes on every pointer move", () => {
    const frames = Array.from({ length: 10_000 }, (_, index) =>
      frame(`node-${index}`, { x: index * 2000 }),
    );
    withTester(frames, (tester, document) => {
      const getFrame = document.getFrame;
      let reads = 0;
      document.getFrame = (id) => {
        reads++;
        return getFrame(id);
      };
      for (let x = 0; x < 100; x++) assert.equal(tester.hit({ x, y: 20 }), "node-0");
      assert.equal(reads, 100);
    });
  });

  it("returns no hit outside artwork or for invalid world coordinates", () => {
    withTester([frame("node")], (tester) => {
      assert.equal(tester.hit({ x: -1, y: -1 }), undefined);
      assert.equal(tester.hit({ x: Infinity, y: 0 }), undefined);
      assert.equal(tester.hit({ x: 0, y: NaN }), undefined);
    });
  });
});
