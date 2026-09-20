/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CANVAS_STORAGE_KEY,
  CanvasDocument,
  loadCanvasFrames,
  saveCanvasFrames,
  type CanvasFrame,
  type CanvasFrameNode,
  type CanvasPen,
  type CanvasShadow,
  type CanvasText,
} from "./canvas-document";

function frame(id: string, x = 0): CanvasFrameNode {
  return { id, name: `Frame ${id}`, x, y: 0, width: 320, height: 240 };
}

describe("canvas project replacement", () => {
  it("replaces nodes and ordering atomically with overlapping IDs and a single undo", () => {
    const document = new CanvasDocument([frame("a"), frame("b"), frame("c")]);
    const original = document.getFrames();
    const replacement = [frame("b", 200), frame("a", 400), frame("new", 600)];
    let commits = 0;
    const unsubscribe = document.subscribe(() => {
      commits++;
      assert.deepEqual(document.getFrames(), replacement);
    });
    assert.equal(document.replaceAll(replacement), true);
    assert.equal(commits, 1);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    unsubscribe();
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.redo();
    assert.deepEqual(document.getFrames(), replacement);
  });

  it("supports empty and order-only projects without recording a no-op", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    assert.equal(document.replaceAll([frame("b"), frame("a")]), true);
    assert.deepEqual(document.getIds(), ["b", "a"]);
    assert.equal(document.replaceAll([frame("b"), frame("a")]), false);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "b"]);
    assert.equal(document.replaceAll([]), true);
    assert.deepEqual(document.getFrames(), []);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "b"]);
  });

  it("rejects invalid projects before changing an existing document or active preview", () => {
    const document = new CanvasDocument([frame("a")]);
    document.beginGesture("a");
    document.preview(frame("a", 40));
    const snapshot = document.getSnapshot();
    for (const invalid of [
      [frame("b"), frame("b")],
      [{ ...frame("b"), width: -1 }],
      [{ ...frame("b"), parentId: "missing" }],
    ]) {
      assert.equal(document.replaceAll(invalid), false);
      assert.deepEqual(document.getFrames(), [frame("a", 40)]);
      assert.strictEqual(document.getSnapshot(), snapshot);
      assert.deepEqual(document.getCommittedFrames(), [frame("a")]);
    }
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), [frame("a")]);
  });
});

describe("canvas document subscriptions", () => {
  it("changes only the previewed frame among 10,000 nodes until the gesture commits", () => {
    const document = new CanvasDocument(Array.from({ length: 10000 }, (_, i) => frame(String(i))));
    const ids = document.getIds();
    const snapshot = document.getSnapshot();
    const unchanged = document.getFrame("10");
    let targetNotifications = 0;
    let unrelatedNotifications = 0;
    let globalNotifications = 0;
    const commits: (readonly string[])[] = [];
    document.subscribeFrame("5000", () => targetNotifications++);
    document.subscribeFrame("10", () => unrelatedNotifications++);
    document.subscribe(() => globalNotifications++);
    document.subscribeChanges((changed) => commits.push(changed));

    document.beginGesture("5000");
    for (let x = 1; x <= 60; x++) document.preview(frame("5000", x));

    assert.equal(document.getFrame("5000")?.x, 60);
    assert.equal(targetNotifications, 60);
    assert.equal(unrelatedNotifications, 0);
    assert.equal(globalNotifications, 0);
    assert.equal(commits.length, 0);
    assert.strictEqual(document.getIds(), ids);
    assert.strictEqual(document.getSnapshot(), snapshot);
    assert.strictEqual(document.getFrame("10"), unchanged);

    document.endGesture();
    assert.equal(globalNotifications, 1);
    assert.equal(targetNotifications, 60);
    assert.deepEqual(commits, [["5000"]]);
    assert.strictEqual(document.getIds(), ids);
    assert.equal(document.getSnapshot().revision, 1);
    document.undo();
    assert.equal(document.getFrame("5000")?.x, 0);
    assert.equal(document.getSnapshot().canUndo, false);
    document.redo();
    assert.equal(document.getFrame("5000")?.x, 60);
  });

  it("caches immutable snapshots and copies caller-owned frames", () => {
    const input = { ...frame("a") };
    const document = new CanvasDocument([input]);
    input.x = 999;
    assert.equal(document.getFrame("a")?.x, 0);
    assert.ok(Object.isFrozen(document.getFrame("a")));
    assert.ok(Object.isFrozen(document.getIds()));
    assert.ok(Object.isFrozen(document.getSnapshot()));
    assert.strictEqual(document.getSnapshot(), document.getSnapshot());
    const ids = document.getIds();
    const old = document.getSnapshot();
    document.update(frame("a", 30));
    assert.notStrictEqual(document.getSnapshot(), old);
    assert.strictEqual(document.getIds(), ids);
    const afterUpdate = document.getSnapshot();
    document.update(frame("a", 30));
    assert.strictEqual(document.getSnapshot(), afterUpdate);
    document.add(frame("b"));
    assert.notStrictEqual(document.getIds(), ids);
  });

  it("notifies index consumers after frame and ordering are updated and supports unsubscribe", () => {
    const document = new CanvasDocument();
    const events: string[] = [];
    const unsubscribeChanges = document.subscribeChanges(([id]) => {
      assert.equal(id, "a");
      assert.deepEqual(document.getIds(), ["a"]);
      assert.equal(document.getFrame(id)?.x, 30);
      assert.equal(document.getSnapshot().revision, 1);
      events.push("index");
    });
    const unsubscribe = document.subscribe(() => events.push("global"));
    let frameNotifications = 0;
    const unsubscribeFrame = document.subscribeFrame("a", () => frameNotifications++);
    document.add(frame("a", 30));
    assert.deepEqual(events, ["index", "global"]);
    assert.equal(frameNotifications, 1);
    unsubscribeChanges();
    unsubscribe();
    unsubscribeFrame();
    document.update(frame("a", 40));
    assert.deepEqual(events, ["index", "global"]);
    assert.equal(frameNotifications, 1);
  });
});

describe("canvas node content", () => {
  const text: CanvasText = {
    ...frame("text"),
    kind: "text",
    text: "A caption",
    fontSize: 24,
    color: "#ededed",
    height: 30,
  };
  const pen: CanvasPen = {
    ...frame("pen"),
    kind: "pen",
    points: [
      { x: 0, y: 0 },
      { x: 30, y: 20 },
    ],
    stroke: "#4285d4",
    strokeWidth: 2,
    pathWidth: 30,
    pathHeight: 20,
  };
  const variants: CanvasFrame[] = [
    frame("legacy"),
    { ...frame("explicit"), kind: "frame" },
    { ...frame("rectangle"), kind: "rectangle", fill: "#abc8" },
    text,
    { ...frame("image"), kind: "image", src: "data:image/png;base64,AAAA" },
    pen,
  ];

  it("roundtrips every node kind alongside unchanged legacy frames", () => {
    const document = new CanvasDocument(variants);
    let saved = "";
    saveCanvasFrames(document.getCommittedFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const loaded = loadCanvasFrames({ getItem: () => saved });
    assert.deepEqual(loaded, variants);
    assert.equal(loaded[0].kind, undefined);
    assert.equal(loaded[1].kind, "frame");
    assert.ok(loaded.every(Object.isFrozen));
    const loadedPen = loaded.find((node) => node.kind === "pen")!;
    assert.ok(Object.isFrozen(loadedPen.points));
    assert.ok(loadedPen.points.every(Object.isFrozen));
  });

  it("records content-only changes, including undo and redo, without geometry changes", () => {
    const changes: [CanvasFrame, CanvasFrame][] = [
      [text, { ...text, text: "Edited caption" }],
      [text, { ...text, fontSize: 48 }],
      [text, { ...text, color: "#ffffff" }],
      [text, { ...text, fontFamily: "Georgia" as const }],
      [text, { ...text, fontWeight: 600 as const }],
      [text, { ...text, lineHeight: 1.75 }],
      [text, { ...text, letterSpacing: -0.5 }],
      [text, { ...text, textAlign: "center" as const }],
      [text, { ...text, opacity: 0.35 }],
      [text, { ...text, fontStyle: "italic" as const }],
      [text, { ...text, textDecoration: "underline" as const }],
      [text, { ...text, textDecoration: "line-through" as const }],
      [text, { ...text, borderWidth: 2 }],
      [text, { ...text, borderColor: "#4285f4" }],
      [frame("styled"), { ...frame("styled"), cornerRadius: 16 }],
      [frame("styled"), { ...frame("styled"), fill: "#ffcc88" }],
      [
        { ...frame("rect"), kind: "rectangle", fill: "#000" },
        { ...frame("rect"), kind: "rectangle", fill: "#fff" },
      ],
      [
        { ...frame("image"), kind: "image", src: "data:image/png;base64,AAAA" },
        { ...frame("image"), kind: "image", src: "data:image/webp;base64,BBBB" },
      ],
      [pen, { ...pen, stroke: "#fff" }],
      [pen, { ...pen, strokeWidth: 3 }],
      [pen, { ...pen, pathWidth: 40 }],
      [pen, { ...pen, pathHeight: 40 }],
      [pen, { ...pen, points: [...pen.points, { x: 10, y: 5 }] }],
      [
        { ...frame("convert"), kind: "rectangle", fill: "#000" },
        { ...text, id: "convert" },
      ],
    ];
    for (const [before, after] of changes) {
      const document = new CanvasDocument([before]);
      document.update(after);
      assert.deepEqual(document.getFrame(before.id), after);
      assert.equal(document.getHistoryStats().undoEntries, 1);
      document.undo();
      assert.deepEqual(document.getFrame(before.id), before);
      document.redo();
      assert.deepEqual(document.getFrame(before.id), after);
    }
  });

  it("roundtrips optional appearance and typography without changing legacy defaults", () => {
    const styled: CanvasFrame[] = [
      {
        ...frame("styled"),
        fill: "#fff8",
        opacity: 0,
        cornerRadius: 12,
        borderWidth: 1.5,
        borderColor: "#ddd",
        shadows: [
          { offsetX: 0, offsetY: 2, blur: 6, spread: -1, color: "#0003" },
          { offsetX: -1, offsetY: -2, blur: 0, spread: 2, color: "#ffffff80", inset: true },
        ],
      },
      {
        ...text,
        fontFamily: "Courier New" as const,
        fontWeight: 700 as const,
        lineHeight: 1.6,
        letterSpacing: 2,
        textAlign: "right" as const,
        fontStyle: "italic" as const,
        textDecoration: "underline" as const,
        opacity: 0.8,
      },
      { ...frame("image"), kind: "image", src: "data:image/png;base64,AAAA", cornerRadius: 8 },
      frame("legacy"),
    ];
    const document = new CanvasDocument(styled);
    let saved = "";
    saveCanvasFrames(document.getFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    const loaded = loadCanvasFrames({ getItem: () => saved });
    assert.deepEqual(loaded, styled);
    assert.equal(loaded[loaded.length - 1].opacity, undefined);
    assert.ok(loaded.every(Object.isFrozen));
  });

  it("rejects invalid optional style properties in storage and updates without damaging history", () => {
    const invalid: unknown[] = [
      { ...text, opacity: -0.01 },
      { ...text, opacity: 1.01 },
      { ...text, opacity: "0.5" },
      { ...text, opacity: NaN },
      { ...text, cornerRadius: -1 },
      { ...text, cornerRadius: Infinity },
      { ...text, borderWidth: -1 },
      { ...text, borderWidth: "2" },
      { ...text, borderWidth: Infinity },
      { ...text, borderColor: "red" },
      { ...text, fontStyle: "oblique" },
      { ...text, textDecoration: "url(https://example.com)" },
      { ...frame("a"), fill: "red" },
      { ...text, fontFamily: "arbitrary-font" },
      { ...text, fontWeight: 300 },
      { ...text, fontWeight: "bold" },
      { ...text, lineHeight: 0.49 },
      { ...text, lineHeight: 4.01 },
      { ...text, letterSpacing: -10.01 },
      { ...text, letterSpacing: 100.01 },
      { ...text, textAlign: "justify" },
    ];
    for (const node of invalid) {
      assert.deepEqual(loadCanvasFrames({ getItem: () => JSON.stringify([node]) }), []);
      const document = new CanvasDocument([text]);
      document.update(node as CanvasFrame);
      assert.deepEqual(document.getFrames(), [text]);
      assert.equal(document.getHistoryStats().undoEntries, 0);
    }
  });

  it("commits a content preview as one operation and restores it on cancellation", () => {
    const document = new CanvasDocument([text]);
    document.beginGesture(text.id);
    document.preview({ ...text, text: "A" });
    document.preview({ ...text, text: "A longer caption" });
    assert.deepEqual(document.getCommittedFrames(), [text]);
    document.endGesture();
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrame(text.id), text);
    document.beginGesture(text.id);
    document.preview({ ...text, text: "Canceled" });
    document.endGesture(true);
    assert.deepEqual(document.getFrame(text.id), text);
    document.redo();
    assert.deepEqual(document.getFrame(text.id), { ...text, text: "A longer caption" });
  });

  it("deep-copies incoming pen points but reuses trusted paths for move, resize, and duplication", () => {
    const inputPoints = [
      { x: 0, y: 0 },
      { x: 5, y: 8 },
    ];
    const document = new CanvasDocument([{ ...pen, points: inputPoints }]);
    inputPoints[0].x = 999;
    inputPoints.push({ x: 50, y: 50 });
    const original = document.getFrame(pen.id) as CanvasPen;
    assert.deepEqual(original.points, [
      { x: 0, y: 0 },
      { x: 5, y: 8 },
    ]);
    assert.ok(Object.isFrozen(original.points));
    assert.ok(original.points.every(Object.isFrozen));
    document.beginGesture(pen.id);
    for (let x = 1; x <= 60; x++) {
      document.preview({ ...original, x, width: original.width + x });
      assert.strictEqual((document.getFrame(pen.id) as CanvasPen).points, original.points);
    }
    document.endGesture();
    document.undo();
    assert.strictEqual((document.getFrame(pen.id) as CanvasPen).points, original.points);
    document.redo();
    assert.strictEqual((document.getFrame(pen.id) as CanvasPen).points, original.points);
    document.add({ ...original, id: "duplicate" });
    assert.strictEqual((document.getFrame("duplicate") as CanvasPen).points, original.points);
    const snapshot = document.getSnapshot();
    document.update({
      ...original,
      id: "duplicate",
      points: original.points.map((point) => ({ x: point.x, y: point.y })),
    });
    assert.strictEqual(document.getSnapshot(), snapshot);
  });

  it("copies even externally frozen arrays whose point objects remain mutable", () => {
    const mutablePoint = { x: 1, y: 2 };
    const input = Object.freeze([mutablePoint]);
    const document = new CanvasDocument([{ ...pen, points: input }]);
    mutablePoint.x = 100;
    assert.deepEqual((document.getFrame(pen.id) as CanvasPen).points, [{ x: 1, y: 2 }]);
  });

  it("permits one-pixel non-frame nodes while preserving the frame minimum", () => {
    const small = variants
      .filter((node) => node.kind && node.kind !== "frame")
      .map((node) => Object.assign({}, node, { width: 1, height: 1 }));
    assert.deepEqual(new CanvasDocument(small).getFrames(), small);
    const document = new CanvasDocument();
    document.add({ ...frame("legacy"), width: 39 });
    document.add({ ...frame("explicit"), kind: "frame", height: 39 });
    assert.equal(document.getIds().length, 0);
  });

  it("rejects invalid kinds, styles, image sources, and path payloads from storage", () => {
    const invalid: unknown[] = [
      { ...frame("unknown"), kind: "circle" },
      { ...frame("null"), kind: null },
      { ...text, width: 0 },
      { ...text, text: { html: "<b>unsafe</b>" } },
      { ...text, fontSize: 0 },
      { ...text, fontSize: Infinity },
      { ...text, color: "url(https://example.com/image)" },
      { ...text, color: "#12" },
      { ...frame("rect"), kind: "rectangle", fill: "red;position:fixed" },
      { ...frame("img"), kind: "image", src: "javascript:alert(1)" },
      { ...frame("img"), kind: "image", src: "https://example.com/image.png" },
      { ...frame("img"), kind: "image", src: "data:image/svg+xml;base64,AAAA" },
      { ...frame("img"), kind: "image", src: "data:image/png;base64," },
      { ...frame("img"), kind: "image", src: "data:image/png;base64,AAAA<script>" },
      { ...pen, points: [] },
      { ...pen, points: [{ x: null, y: 0 }] },
      { ...pen, points: [{ x: 0, y: Infinity }] },
      { ...pen, strokeWidth: -1 },
      { ...pen, pathWidth: 0 },
      { ...pen, pathHeight: Number.NaN },
      { ...pen, stroke: "invalid" },
    ];
    for (const item of invalid) {
      assert.deepEqual(loadCanvasFrames({ getItem: () => JSON.stringify([item]) }), []);
      assert.throws(() => new CanvasDocument([item as CanvasFrame]));
    }
    const document = new CanvasDocument(variants);
    const snapshot = document.getSnapshot();
    document.update({ ...text, fontSize: 0 });
    document.beginGesture(pen.id);
    document.preview({ ...pen, points: [{ x: Number.NaN, y: 0 }] });
    document.endGesture();
    assert.strictEqual(document.getSnapshot(), snapshot);
  });
});

describe("canvas gesture history", () => {
  it("cancels a preview without changing history, revision, or the redo branch", () => {
    const document = new CanvasDocument([frame("a")]);
    document.update(frame("a", 10));
    document.undo();
    const before = document.getSnapshot();
    document.beginGesture("a");
    document.preview(frame("a", 999));
    document.endGesture(true);
    assert.equal(document.getFrame("a")?.x, 0);
    assert.strictEqual(document.getSnapshot(), before);
    document.redo();
    assert.equal(document.getFrame("a")?.x, 10);
  });

  it("does not retain a gesture that finishes at its original geometry", () => {
    const document = new CanvasDocument([frame("a")]);
    const before = document.getSnapshot();
    document.beginGesture("a");
    document.preview(frame("a", 50));
    document.preview(frame("a"));
    document.endGesture();
    assert.strictEqual(document.getSnapshot(), before);
    assert.equal(document.getHistoryStats().undoEntries, 0);
  });

  it("requires a matching active gesture and ignores missing or invalid edits", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    document.preview(frame("a", 10));
    document.beginGesture("a");
    document.preview(frame("b", 10));
    document.preview({ ...frame("a"), x: Number.NaN });
    document.endGesture();
    document.update(frame("missing"));
    document.remove("missing");
    document.add(frame("a"));
    document.add({ ...frame("small"), width: 1 });
    assert.deepEqual(document.getFrames(), [frame("a"), frame("b")]);
    assert.equal(document.getSnapshot().revision, 0);
  });

  it("preserves the original stacking order through delete undo and redo", () => {
    const document = new CanvasDocument([frame("a"), frame("b"), frame("c")]);
    document.remove("b");
    assert.deepEqual(document.getIds(), ["a", "c"]);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "b", "c"]);
    document.redo();
    assert.deepEqual(document.getIds(), ["a", "c"]);
    document.undo();
    document.add(frame("d"));
    assert.deepEqual(document.getIds(), ["a", "b", "c", "d"]);
    assert.equal(document.getSnapshot().canRedo, false);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "b", "c"]);
  });

  it("bounds history to 100 operation patches regardless of document size", () => {
    const document = new CanvasDocument(Array.from({ length: 1000 }, (_, i) => frame(String(i))));
    for (let x = 1; x <= 120; x++) document.update(frame("0", x));
    assert.deepEqual(document.getHistoryStats(), {
      undoEntries: 100,
      redoEntries: 0,
      retainedFrameReferences: 200,
    });
    for (let i = 0; i < 110; i++) document.undo();
    assert.equal(document.getFrame("0")?.x, 20);
    assert.deepEqual(document.getHistoryStats(), {
      undoEntries: 0,
      redoEntries: 100,
      retainedFrameReferences: 200,
    });
    for (let i = 0; i < 110; i++) document.redo();
    assert.equal(document.getFrame("0")?.x, 120);
  });
});

describe("canvas persistence", () => {
  it("loads the legacy array format and ignores unknown properties", () => {
    const loaded = loadCanvasFrames({
      getItem: (key) => {
        assert.equal(key, CANVAS_STORAGE_KEY);
        return JSON.stringify([{ ...frame("a", -40), arbitrary: "ignored" }, frame("b")]);
      },
    });
    assert.deepEqual(loaded, [frame("a", -40), frame("b")]);
    assert.ok(Object.isFrozen(loaded[0]));
  });

  it("rejects corrupt documents, duplicate ids, invalid bounds, and unavailable storage", () => {
    for (const saved of [
      "not json",
      "{}",
      "null",
      JSON.stringify([frame("a"), frame("a")]),
      JSON.stringify([{ ...frame("a"), width: 39 }]),
      JSON.stringify([{ ...frame("a"), x: null }]),
      JSON.stringify([{ ...frame("a"), name: 10 }]),
      '[{"id":"a","name":"a","x":1e999,"y":0,"width":100,"height":100}]',
    ]) {
      assert.deepEqual(loadCanvasFrames({ getItem: () => saved }), []);
    }
    assert.deepEqual(loadCanvasFrames({ getItem: () => null }), []);
    assert.deepEqual(
      loadCanvasFrames({
        getItem: () => {
          throw new Error("Storage unavailable");
        },
      }),
      [],
    );
  });

  it("persists committed geometry when a prior save flushes during an unfinished gesture", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    document.update(frame("b", 50));
    document.beginGesture("a");
    document.preview(frame("a", 999));
    let stored = "";
    assert.equal(
      saveCanvasFrames(document.getCommittedFrames(), {
        setItem: (key, value) => {
          assert.equal(key, CANVAS_STORAGE_KEY);
          stored = value;
        },
      }),
      true,
    );
    assert.deepEqual(JSON.parse(stored), { version: 2, nodes: [frame("a"), frame("b", 50)] });
    document.endGesture();
    assert.deepEqual(document.getCommittedFrames(), [frame("a", 999), frame("b", 50)]);
  });

  it("handles quota failures without throwing", () => {
    assert.equal(
      saveCanvasFrames([frame("a")], {
        setItem: () => {
          throw new Error("Quota exceeded");
        },
      }),
      false,
    );
  });
});

const group = (id: string, parentId?: string): CanvasFrame => ({
  id,
  name: "Group",
  kind: "group",
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  ...(parentId && { parentId }),
});

describe("canvas hierarchy and atomic operations", () => {
  const child = (id: string, parentId: string, x = 20): CanvasFrame => ({
    ...frame(id, x),
    kind: "rectangle",
    fill: "#fff",
    width: 60,
    height: 50,
    parentId,
  });

  it("normalizes unordered input into contiguous subtrees and exposes stable child lists", () => {
    const document = new CanvasDocument([
      child("first", "a"),
      frame("b"),
      child("nested-child", "nested"),
      { ...frame("nested"), parentId: "a" },
      frame("a"),
      child("second", "a"),
    ]);
    assert.deepEqual(document.getIds(), ["b", "a", "first", "nested", "nested-child", "second"]);
    assert.deepEqual(document.getChildren(), ["b", "a"]);
    assert.deepEqual(document.getChildren("a"), ["first", "nested", "second"]);
    assert.deepEqual(document.getChildren("missing"), []);
    assert.ok(Object.isFrozen(document.getChildren("a")));
    const children = document.getChildren("a");
    document.update({ ...document.getFrame("first")!, x: 70 });
    assert.strictEqual(document.getChildren("a"), children);
    assert.deepEqual(document.getRootIds(["nested-child", "b", "nested", "a", "a", "missing"]), [
      "b",
      "a",
    ]);
    assert.deepEqual(document.getDescendantIds(["second", "nested", "nested-child"]), [
      "nested",
      "nested-child",
      "second",
    ]);
    assert.deepEqual(document.getDescendantIds(["a", "nested-child"]), [
      "a",
      "first",
      "nested",
      "nested-child",
      "second",
    ]);
  });

  it("roundtrips hierarchy, group, lock, and clipping metadata without changing world coordinates", () => {
    const nodes: CanvasFrame[] = [
      { ...frame("a", 100), clipContent: false, locked: true },
      { ...group("g", "a"), x: 125 },
      { ...child("c", "g", 140), locked: false },
    ];
    let saved = "";
    saveCanvasFrames(new CanvasDocument(nodes).getFrames(), {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(loadCanvasFrames({ getItem: () => saved }), nodes);
    const document = new CanvasDocument(nodes);
    document.update({ ...nodes[0], kind: "frame", clipContent: true, locked: false });
    assert.equal(document.getFrame("a")?.locked, false);
    document.undo();
    assert.deepEqual(document.getFrames(), nodes);
  });

  it("rejects missing, self, cyclic, and non-container parents on load and construction", () => {
    const invalid: CanvasFrame[][] = [
      [child("child", "missing")],
      [{ ...frame("a"), parentId: "a" }],
      [
        { ...frame("a"), parentId: "b" },
        { ...frame("b"), parentId: "a" },
      ],
      [{ ...child("rect", "a"), parentId: undefined }, child("nested", "rect")],
      [{ ...frame("a"), locked: "yes" } as unknown as CanvasFrame],
      [{ ...frame("a"), clipContent: "yes" } as unknown as CanvasFrame],
      [{ ...frame("a"), parentId: null } as unknown as CanvasFrame],
    ];
    for (const nodes of invalid) {
      assert.throws(() => new CanvasDocument(nodes));
      assert.deepEqual(loadCanvasFrames({ getItem: () => JSON.stringify(nodes) }), []);
    }
  });

  it("validates every change and the resulting graph before applying a transaction", () => {
    const document = new CanvasDocument([frame("a"), { ...frame("b"), parentId: "a" }]);
    const before = document.getSnapshot();
    assert.equal(
      document.updateMany([
        { ...frame("a"), parentId: "b" },
        { ...frame("b", 50), parentId: "a" },
      ]),
      false,
    );
    assert.equal(document.addMany([frame("new"), child("invalid", "missing")]), false);
    assert.equal(document.updateMany([frame("a", 50), { ...frame("b"), width: 0 }]), false);
    assert.equal(document.transact({ remove: ["a"] }), false);
    assert.equal(document.transact({ update: [frame("a", 50)], remove: ["a"] }), false);
    assert.equal(document.addMany([frame("same"), frame("same")]), false);
    assert.equal(document.updateMany([{ ...child("a", "missing"), parentId: undefined }]), false);
    assert.strictEqual(document.getSnapshot(), before);
    assert.deepEqual(document.getIds(), ["a", "b"]);
    assert.equal(document.getFrame("a")?.x, 0);
  });

  it("groups and ungroups mixed additions, parent edits, and removal as individual undo steps", () => {
    const a = { ...child("a", "unused"), parentId: undefined };
    const b = { ...child("b", "unused", 100), parentId: undefined };
    const document = new CanvasDocument([a, b]);
    const original = document.getFrames();
    assert.equal(
      document.transact({
        add: [group("g")],
        update: [
          { ...a, parentId: "g" },
          { ...b, parentId: "g" },
        ],
      }),
      true,
    );
    assert.deepEqual(document.getIds(), ["g", "a", "b"]);
    assert.deepEqual(document.getFrame("g"), { ...group("g"), x: 20, width: 140, height: 50 });
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.redo();
    assert.equal(document.transact({ remove: ["g"], update: [a, b] }), true);
    assert.deepEqual(document.getFrames(), original);
    document.undo();
    assert.deepEqual(document.getIds(), ["g", "a", "b"]);
    assert.deepEqual(document.getChildren("g"), ["a", "b"]);
  });

  it("keeps newly grouped or framed objects below unselected higher siblings", () => {
    for (const kind of ["group", "frame"] as const) {
      const nodes = [frame("a"), frame("b"), frame("higher")];
      const document = new CanvasDocument(nodes);
      const container: CanvasFrame = { ...frame("wrapper"), kind };
      document.transact({
        add: [container],
        update: nodes.slice(0, 2).map((node) => Object.assign({}, node, { parentId: "wrapper" })),
      });
      assert.deepEqual(document.getIds(), ["wrapper", "a", "b", "higher"]);
      document.undo();
      assert.deepEqual(document.getFrames(), nodes);
      document.redo();
      assert.deepEqual(document.getIds(), ["wrapper", "a", "b", "higher"]);
    }
  });

  it("places non-adjacent wrapped nodes at the highest selected sibling position", () => {
    const document = new CanvasDocument(["a", "between", "b", "higher"].map((id) => frame(id)));
    document.transact({
      add: [group("g")],
      update: ["a", "b"].map((id) => Object.assign({}, frame(id), { parentId: "g" })),
    });
    assert.deepEqual(document.getIds(), ["between", "g", "a", "b", "higher"]);
  });

  it("preserves stacking when wrapping children inside a frame", () => {
    const document = new CanvasDocument([
      frame("parent"),
      child("a", "parent"),
      child("b", "parent"),
      child("higher", "parent"),
      frame("outside"),
    ]);
    document.transact({ add: [group("g", "parent")], update: [child("a", "g"), child("b", "g")] });
    assert.deepEqual(document.getIds(), ["parent", "g", "a", "b", "higher", "outside"]);
    assert.deepEqual(document.getChildren("parent"), ["g", "higher"]);
  });

  it("cascades removal once per selected subtree and restores all nodes and order atomically", () => {
    const document = new CanvasDocument([frame("a"), child("c", "a"), frame("b"), frame("d")]);
    const changes: (readonly string[])[] = [];
    document.subscribeChanges((ids) => changes.push(ids));
    document.removeMany(["a", "c", "b", "missing"]);
    assert.deepEqual(document.getIds(), ["d"]);
    assert.deepEqual(changes, [["a", "c", "b"]]);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "c", "b", "d"]);
    assert.deepEqual(document.getChildren("a"), ["c"]);
    document.redo();
    assert.deepEqual(document.getIds(), ["d"]);
  });

  it("notifies only after every node in a transaction or preview has been applied", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    let calls = 0;
    document.subscribeFrame("a", () => {
      assert.equal(document.getFrame("a")?.x, document.getFrame("b")?.x);
      calls++;
    });
    document.updateMany([frame("a", 20), frame("b", 20)]);
    document.beginGesture(["a", "b"]);
    document.previewMany([frame("a", 50), frame("b", 50)]);
    document.endGesture();
    document.undo();
    document.redo();
    assert.equal(calls, 4);
  });

  it("previews an entire selection without global commits and persists all original nodes", () => {
    const nodes = [frame("a"), child("c", "a"), frame("b")];
    const document = new CanvasDocument(nodes);
    const snapshot = document.getSnapshot();
    document.beginGesture(["a", "c"]);
    for (let delta = 1; delta <= 60; delta++) {
      document.previewMany(
        nodes.slice(0, 2).map((node) => Object.assign({}, node, { x: node.x + delta })),
      );
    }
    assert.strictEqual(document.getSnapshot(), snapshot);
    assert.deepEqual(document.getCommittedFrames(), nodes);
    document.endGesture();
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), nodes);
    document.redo();
    assert.equal(document.getFrame("a")?.x, 60);
    assert.equal(document.getFrame("c")?.x, 80);
  });

  it("cancels every previewed node and leaves the redo branch intact", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    document.updateMany([frame("a", 10), frame("b", 20)]);
    document.undo();
    const snapshot = document.getSnapshot();
    document.beginGesture(["a", "b"]);
    document.previewMany([frame("a", 50), frame("b", 60)]);
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), [frame("a"), frame("b")]);
    assert.strictEqual(document.getSnapshot(), snapshot);
    document.redo();
    assert.deepEqual(document.getFrames(), [frame("a", 10), frame("b", 20)]);
  });

  it("ignores an invalid whole preview and invalid final parent metadata", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    document.beginGesture(["a", "b"]);
    assert.equal(document.previewMany([frame("a", 20), { ...frame("b"), width: 0 }]), false);
    assert.equal(document.previewMany([frame("a", 20), frame("a", 40)]), false);
    assert.equal(document.previewMany([{ ...frame("a"), parentId: "b" }]), false);
    assert.equal(document.endGesture(false, [{ ...frame("a"), parentId: "a" }]), false);
    assert.deepEqual(document.getFrames(), [frame("a"), frame("b")]);
    document.previewMany([frame("a", 30), frame("b", 40)]);
    document.endGesture();
    assert.equal(document.getHistoryStats().undoEntries, 1);
  });

  it("commits a drag and its final parent change in a single undo operation", () => {
    const document = new CanvasDocument([frame("a"), child("c", "a"), frame("b", 400)]);
    const original = document.getFrames();
    document.beginGesture("c");
    document.preview({ ...child("c", "a"), x: 430 });
    document.endGesture(false, [{ ...child("c", "b"), x: 430 }]);
    assert.deepEqual(document.getIds(), ["a", "b", "c"]);
    assert.equal(document.getFrame("c")?.parentId, "b");
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.redo();
    assert.equal(document.getFrame("c")?.x, 430);
    assert.equal(document.getFrame("c")?.parentId, "b");
  });

  it("updates nested group bounds when a child moves and undoes those bounds together", () => {
    const document = new CanvasDocument();
    document.addMany([
      group("outer"),
      group("inner", "outer"),
      child("c", "inner"),
      child("other", "outer", 100),
    ]);
    assert.equal(document.getFrame("inner")?.x, 20);
    assert.equal(document.getFrame("outer")?.width, 140);
    const original = document.getFrames();
    let notifications = 0;
    document.subscribeFrame("inner", () => notifications++);
    document.subscribeFrame("outer", () => notifications++);
    document.beginGesture("c");
    document.preview({ ...child("c", "inner"), x: -80 });
    assert.equal(document.getFrame("inner")?.x, 20);
    document.endGesture();
    assert.equal(document.getFrame("inner")?.x, -80);
    assert.equal(document.getFrame("outer")?.x, -80);
    assert.equal(document.getFrame("outer")?.width, 240);
    assert.equal(notifications, 2);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
  });

  it("restores derived group bounds even when a gesture settles to a no-op", () => {
    const document = new CanvasDocument();
    document.addMany([group("g"), child("c", "g"), frame("f")]);
    const original = document.getFrame("g")!;
    const snapshot = document.getSnapshot();
    document.beginGesture("g");
    document.preview({ ...original, x: 500 });
    document.endGesture();
    assert.deepEqual(document.getFrame("g"), original);
    assert.strictEqual(document.getSnapshot(), snapshot);
    document.beginGesture(["g", "f"]);
    document.previewMany([{ ...original, x: 800 }, frame("f", 20)]);
    document.endGesture();
    assert.deepEqual(document.getFrame("g"), original);
    assert.equal(document.getFrame("f")?.x, 20);
    document.undo();
    assert.equal(document.getFrame("f")?.x, 0);
  });

  it("removes groups emptied by deleting or reparenting the last child and restores them on undo", () => {
    const document = new CanvasDocument();
    document.addMany([group("outer"), group("inner", "outer"), child("c", "inner"), frame("f")]);
    const original = document.getFrames();
    document.remove("c");
    assert.deepEqual(document.getIds(), ["f"]);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
    document.update({ ...child("c", "f") });
    assert.deepEqual(document.getIds(), ["f", "c"]);
    document.undo();
    assert.deepEqual(document.getFrames(), original);
  });

  it("preserves group bounds with a new transaction immediately after a gesture", () => {
    const document = new CanvasDocument();
    document.addMany([group("g"), child("c", "g")]);
    document.beginGesture("c");
    document.preview({ ...child("c", "g"), x: 100 });
    document.add(child("new", "g", 200));
    assert.equal(document.getFrame("g")?.x, 100);
    assert.equal(document.getFrame("g")?.width, 160);
    document.undo();
    assert.equal(document.getFrame("g")?.width, 60);
    assert.equal(document.getFrame("g")?.x, 100);
    document.undo();
    assert.equal(document.getFrame("g")?.x, 20);
  });

  it("orders whole subtrees while moving child selections only within their sibling list", () => {
    const document = new CanvasDocument([
      frame("a"),
      child("a1", "a"),
      child("a2", "a"),
      frame("b"),
      frame("c"),
    ]);
    document.reorder(["a", "a1"], "front");
    assert.deepEqual(document.getIds(), ["b", "c", "a", "a1", "a2"]);
    document.undo();
    assert.deepEqual(document.getIds(), ["a", "a1", "a2", "b", "c"]);
    document.reorder(["a1", "c"], "back");
    assert.deepEqual(document.getIds(), ["c", "a", "a1", "a2", "b"]);
    document.reorder(["a1"], "forward");
    assert.deepEqual(document.getChildren("a"), ["a2", "a1"]);
    document.reorder(["a1"], "backward");
    assert.deepEqual(document.getChildren("a"), ["a1", "a2"]);
  });

  it("keeps selected sibling blocks ordered through forward/backward moves and redo", () => {
    const document = new CanvasDocument(["a", "b", "c", "d", "e"].map((id) => frame(id)));
    document.reorder(["b", "c"], "forward");
    assert.deepEqual(document.getIds(), ["a", "d", "b", "c", "e"]);
    document.undo();
    document.redo();
    assert.deepEqual(document.getIds(), ["a", "d", "b", "c", "e"]);
    document.reorder(["b", "c"], "backward");
    assert.deepEqual(document.getIds(), ["a", "b", "c", "d", "e"]);
    const snapshot = document.getSnapshot();
    assert.equal(document.reorder(["a"], "backward"), false);
    assert.strictEqual(document.getSnapshot(), snapshot);
  });
});

function legacyObject(id: string, x: number, y: number): CanvasFrame {
  return { id, name: id, kind: "rectangle", fill: "#123456", x, y, width: 50, height: 50 };
}

describe("canvas legacy migration", () => {
  it("adopts legacy objects and nested frames without losing content or changing world coordinates", () => {
    const nodes: CanvasFrame[] = [
      { ...frame("outer"), width: 800, height: 600 },
      { ...frame("inner", 100), y: 100 },
      legacyObject("inside-inner", 150, 150),
      legacyObject("inside-outer", 600, 400),
      legacyObject("outside", 900, 900),
    ];
    const migrated = loadCanvasFrames(
      { getItem: () => JSON.stringify(nodes) },
      { migrateLegacy: true },
    );
    const byId = new Map(migrated.map((node) => [node.id, node]));
    assert.equal(byId.get("inner")?.parentId, "outer");
    assert.equal(byId.get("inside-inner")?.parentId, "inner");
    assert.equal(byId.get("inside-outer")?.parentId, "outer");
    assert.equal(byId.get("outside")?.parentId, undefined);
    assert.equal(migrated.length, nodes.length);
    for (const original of nodes) {
      const { parentId: _parent, ...node } = byId.get(original.id)!;
      assert.deepEqual(node, original);
    }
    const document = new CanvasDocument(migrated);
    assert.deepEqual(document.getDescendantIds(["outer"]), [
      "outer",
      "inner",
      "inside-inner",
      "inside-outer",
    ]);
  });

  it("uses the nearest enclosing parent for frames and never creates equal-frame cycles", () => {
    const nodes: CanvasFrame[] = [
      { ...frame("outer"), width: 900, height: 900 },
      { ...frame("middle", 50), y: 50, width: 600, height: 600 },
      { ...frame("inner", 100), y: 100 },
      { ...frame("equal-a", 1000), y: 1000 },
      { ...frame("equal-b", 1000), y: 1000 },
      legacyObject("on-equal", 1100, 1100),
    ];
    const migrated = loadCanvasFrames(
      { getItem: () => JSON.stringify(nodes) },
      { migrateLegacy: true },
    );
    const byId = new Map(migrated.map((node) => [node.id, node]));
    assert.equal(byId.get("inner")?.parentId, "middle");
    assert.equal(byId.get("middle")?.parentId, "outer");
    assert.equal(byId.get("equal-a")?.parentId, undefined);
    assert.equal(byId.get("equal-b")?.parentId, undefined);
    assert.equal(byId.get("on-equal")?.parentId, "equal-b");
    assert.deepEqual(new CanvasDocument(migrated).getChildren(), ["outer", "equal-a", "equal-b"]);
  });

  it("leaves clipboard arrays and legacy arrays with explicit hierarchy unchanged", () => {
    const nodes = [frame("outer"), legacyObject("object", 10, 10)];
    assert.deepEqual(loadCanvasFrames({ getItem: () => JSON.stringify(nodes) }), nodes);
    const explicit = [...nodes, { ...legacyObject("child", 20, 20), parentId: "outer" }];
    const loaded = loadCanvasFrames(
      { getItem: () => JSON.stringify(explicit) },
      { migrateLegacy: true },
    );
    assert.equal(loaded.find((node) => node.id === "object")?.parentId, undefined);
    assert.equal(loaded.find((node) => node.id === "child")?.parentId, "outer");
  });

  it("saves version 2 so intentionally detached nodes remain detached on later reloads", () => {
    const nodes = [frame("outer"), legacyObject("detached", 10, 10)];
    let saved = "";
    saveCanvasFrames(nodes, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(JSON.parse(saved), { version: 2, nodes });
    assert.deepEqual(loadCanvasFrames({ getItem: () => saved }, { migrateLegacy: true }), nodes);
    const migrated = loadCanvasFrames(
      { getItem: () => JSON.stringify(nodes) },
      { migrateLegacy: true },
    );
    saveCanvasFrames(migrated, {
      setItem: (_key, value) => {
        saved = value;
      },
    });
    assert.deepEqual(loadCanvasFrames({ getItem: () => saved }, { migrateLegacy: true }), migrated);
  });

  it("rejects unsupported or corrupt versioned payloads", () => {
    for (const value of [
      { version: 3, nodes: [frame("a")] },
      { version: 2, nodes: {} },
      { version: 2 },
      { nodes: [frame("a")] },
      { version: 2, nodes: [frame("a"), frame("a")] },
    ]) {
      assert.deepEqual(
        loadCanvasFrames({ getItem: () => JSON.stringify(value) }, { migrateLegacy: true }),
        [],
      );
    }
  });
});

describe("canvas border and shadow appearance", () => {
  const shadow: CanvasShadow = { offsetX: 1, offsetY: 2, blur: 3, spread: -1, color: "#0008" };

  it("isolates caller-owned shadows and reuses only trusted deeply frozen snapshots", () => {
    const input = [{ ...shadow }];
    const node = { ...frame("effects"), shadows: Object.freeze(input) };
    const document = new CanvasDocument([node]);
    input[0].blur = 999;
    const original = document.getFrame(node.id)!;
    assert.deepEqual(original.shadows, [shadow]);
    assert.ok(Object.isFrozen(original.shadows));
    assert.ok(original.shadows?.every(Object.isFrozen));
    document.beginGesture(node.id);
    for (let x = 1; x < 10; x++) {
      document.preview({ ...original, x });
      assert.strictEqual(document.getFrame(node.id)?.shadows, original.shadows);
    }
    document.endGesture();
    document.undo();
    assert.strictEqual(document.getFrame(node.id)?.shadows, original.shadows);
    document.redo();
    assert.strictEqual(document.getFrame(node.id)?.shadows, original.shadows);
  });

  it("compares every shadow property and list order without adding history for equivalent values", () => {
    const before = { ...frame("effects"), shadows: [shadow] };
    const variants: readonly CanvasShadow[][] = [
      [{ ...shadow, offsetX: 4 }],
      [{ ...shadow, offsetY: -5 }],
      [{ ...shadow, blur: 6 }],
      [{ ...shadow, spread: 7 }],
      [{ ...shadow, color: "#4285f4" }],
      [{ ...shadow, inset: true }],
      [shadow, { ...shadow, offsetX: 8 }],
      [],
    ];
    for (const shadows of variants) {
      const document = new CanvasDocument([before]);
      const initialSnapshot = document.getSnapshot();
      document.update({ ...before, shadows: [{ ...shadow }] });
      assert.strictEqual(document.getSnapshot(), initialSnapshot);
      document.update({ ...before, shadows });
      assert.deepEqual(document.getFrame(before.id)?.shadows, shadows);
      assert.equal(document.getHistoryStats().undoEntries, 1);
      document.undo();
      assert.deepEqual(document.getFrame(before.id), before);
      document.redo();
      assert.deepEqual(document.getFrame(before.id)?.shadows, shadows);
    }
    const document = new CanvasDocument([
      { ...before, shadows: [shadow, { ...shadow, inset: true }] },
    ]);
    document.update({ ...before, shadows: [{ ...shadow, inset: true }, shadow] });
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.update({ ...frame("effects") });
    assert.equal(document.getFrame("effects")?.shadows, undefined);
  });

  it("rejects malformed effects atomically during persistence, updates, and project replacement", () => {
    const malformed = [
      null,
      "0 2px 3px black",
      {},
      [null],
      [{ ...shadow, offsetX: Infinity }],
      [{ ...shadow, offsetY: "2" }],
      [{ ...shadow, blur: -1 }],
      [{ ...shadow, spread: NaN }],
      [{ ...shadow, color: "red" }],
      [{ ...shadow, inset: "true" }],
      Array.from({ length: 9 }, () => shadow),
    ];
    for (const shadows of malformed) {
      const original = frame("effects");
      const node = { ...original, shadows } as CanvasFrame;
      const document = new CanvasDocument([original]);
      document.update(node);
      assert.equal(document.replaceAll([node]), false);
      assert.deepEqual(document.getFrames(), [original]);
      assert.equal(document.getHistoryStats().undoEntries, 0);
      assert.deepEqual(loadCanvasFrames({ getItem: () => JSON.stringify([node]) }), []);
    }
  });
});
