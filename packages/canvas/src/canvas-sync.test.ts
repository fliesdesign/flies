import { describe, expect, test } from "vite-plus/test";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import { applyDocumentDelta, diffDocument, type SyncSnapshot } from "./canvas-sync";

const node: CanvasFrame = {
  id: "box",
  name: "Box",
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: "#fff",
};

const initial: SyncSnapshot = { name: "Design", nodes: [node], theme: { tokens: [] } };

describe("collaborative document changes", () => {
  test("concurrent edits to different properties and different nodes both survive", () => {
    const move = diffDocument(initial, { ...initial, nodes: [{ ...node, x: 80 }] });
    const color = diffDocument(initial, { ...initial, nodes: [{ ...node, fill: "#f00" }] });
    const merged = applyDocumentDelta(applyDocumentDelta(initial, move), color);
    expect(merged.nodes[0]).toMatchObject({ x: 80, fill: "#f00" });
    expect(applyDocumentDelta(applyDocumentDelta(initial, color), move)).toEqual(merged);
  });
  test("deletion wins over stale updates and removes concurrently added children", () => {
    const remove = diffDocument(initial, { ...initial, nodes: [] });
    const update = diffDocument(initial, { ...initial, nodes: [{ ...node, x: 80 }] });
    expect(applyDocumentDelta(applyDocumentDelta(initial, remove), update).nodes).toEqual([]);
    const added = { ...initial, nodes: [node, { ...node, id: "child", parentId: node.id }] };
    expect(applyDocumentDelta(added, remove).nodes).toEqual([]);
  });
  test("concurrent additions and reorder preserve all layers", () => {
    const two = { ...initial, nodes: [node, { ...node, id: "second" }] };
    const added = diffDocument(two, { ...two, nodes: [...two.nodes, { ...node, id: "third" }] });
    const reorder = diffDocument(two, { ...two, nodes: [two.nodes[1], two.nodes[0]] });
    expect(
      applyDocumentDelta(applyDocumentDelta(two, added), reorder).nodes.map((n) => n.id),
    ).toEqual(["second", "box", "third"]);
  });
  test("remote property updates preserve local undo without reverting remote fields", () => {
    const document = new CanvasDocument([node]);
    document.update({ ...node, x: 70 });
    document.replaceAll([{ ...node, x: 70, fill: "#f00" }], { tokens: [] }, true);
    document.undo();
    expect(document.getFrame(node.id)).toMatchObject({ x: 0, fill: "#f00" });
    document.redo();
    expect(document.getFrame(node.id)).toMatchObject({ x: 70, fill: "#f00" });
  });
  test("remote commits do not become local undo entries", () => {
    const document = new CanvasDocument([node]);
    document.replaceAll([{ ...node, x: 30 }], { tokens: [] }, true);
    expect(document.getSnapshot().canUndo).toBe(false);
  });
});
