/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  PREVIEW_NODE_LIMIT,
  previewBounds,
  previewTree,
  previewViewBox,
  readPreviewNodes,
} from "./file-preview-model";

describe("file preview scene", () => {
  it("keeps valid geometry and drops payloads that cannot paint a thumbnail", () => {
    const nodes = readPreviewNodes([
      { id: "board", kind: "frame", x: 0, y: 0, width: 400, height: 300, fill: "#ffffff" },
      { id: "ghost", x: 0, y: 0, width: 10, height: 10, opacity: 0 },
      { id: "bad-fill", kind: "rectangle", x: 0, y: 0, width: 10, height: 10, fill: "red" },
      {
        id: "src",
        kind: "image",
        x: 8,
        y: 8,
        width: 64,
        height: 48,
        src: "data:image/png;base64,xx",
      },
      null,
      { id: "missing" },
    ]);
    assert.equal(nodes.length, 3);
    assert.equal(nodes[0]?.fill, "#ffffff");
    assert.equal(nodes[1]?.fill, undefined);
    assert.equal(nodes[2]?.kind, "image");
    assert.equal("src" in (nodes[2] ?? {}), false);
  });

  it("fits nested layers into a padded viewBox and keeps document order", () => {
    const parsed = readPreviewNodes([
      { id: "board", kind: "frame", x: 100, y: 50, width: 200, height: 100, fill: "#ffffff" },
      {
        id: "title",
        parentId: "board",
        kind: "text",
        x: 120,
        y: 70,
        width: 80,
        height: 24,
        text: "Hello",
        color: "#111111",
        fontSize: 18,
      },
      { id: "orphan", kind: "rectangle", x: 400, y: 0, width: 40, height: 40, fill: "#3b82f6" },
    ]);
    const bounds = previewBounds(parsed);
    assert.deepEqual(bounds, { x: 100, y: 0, width: 340, height: 150 });
    const box = previewViewBox(bounds!);
    assert.ok(box.x < bounds!.x && box.y < bounds!.y);
    assert.ok(box.width > bounds!.width && box.height > bounds!.height);
    const tree = previewTree(parsed);
    assert.deepEqual(
      tree.roots.map((node) => node.id),
      ["board", "orphan"],
    );
    assert.deepEqual(
      tree.nested.get("board")?.map((node) => node.id),
      ["title"],
    );
  });

  it("caps thumbnail nodes so a large file still opens quickly", () => {
    const nodes = readPreviewNodes(
      Array.from({ length: PREVIEW_NODE_LIMIT + 20 }, (_, index) => ({
        id: `n${index}`,
        x: index,
        y: 0,
        width: 8,
        height: 8,
        fill: "#ffffff",
      })),
    );
    assert.equal(nodes.length, PREVIEW_NODE_LIMIT);
  });
});
