/// <reference types="node" />

import assert from "node:assert/strict";

import { CanvasDocument, type CanvasFrame } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { CanvasLayers } from "./canvas-layers";

const frame: CanvasFrame = {
  id: "frame",
  name: "Frame",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
};
const back: CanvasFrame = {
  id: "back",
  name: "Back",
  kind: "rectangle",
  parentId: "frame",
  fill: "#212121",
  x: 20,
  y: 20,
  width: 100,
  height: 80,
};
const front: CanvasFrame = { ...frame, id: "front", name: "Front", parentId: "frame" };
const nested: CanvasFrame = { ...back, id: "nested", name: "Nested", parentId: "front" };
const root: CanvasFrame = { ...back, id: "root", name: "Root", parentId: undefined };

function render(document: CanvasDocument, selectedIds: readonly string[] = []) {
  return renderToStaticMarkup(
    <CanvasLayers
      document={document}
      selectedIds={selectedIds}
      onSelect={() => {}}
      onRename={() => {}}
      onToggleLock={() => {}}
      onToggleHidden={() => {}}
      onMove={() => {}}
      onHover={() => {}}
      onCollapse={() => {}}
    />,
  );
}

function rows(markup: string) {
  return [...markup.matchAll(/<div(?=[^>]*role="treeitem")[^>]*>/g)].map(([element]) => {
    const attributes = Object.fromEntries(
      [...element.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]),
    );
    return attributes;
  });
}

describe("canvas layers hierarchy", () => {
  it("lists frontmost siblings first while keeping each descendant under its own parent", () => {
    const document = new CanvasDocument([frame, back, front, nested, root]);
    const items = rows(render(document));
    assert.deepEqual(
      items.map((item) => item["data-layer-id"]),
      ["root", "frame", "front", "nested", "back"],
    );
    assert.deepEqual(
      items.map((item) => item["aria-level"]),
      ["1", "1", "2", "3", "2"],
    );
    assert.deepEqual(
      items.map((item) => item["aria-posinset"]),
      ["1", "2", "1", "1", "2"],
    );
    assert.deepEqual(
      items.map((item) => item["aria-setsize"]),
      ["2", "2", "2", "1", "2"],
    );
    assert.equal(items[1]["aria-expanded"], "true");
    assert.equal(items[2]["aria-expanded"], "true");
    assert.equal(items[0]["aria-expanded"], undefined);
  });

  it("reflects document stacking edits without flattening nested descendants", () => {
    const document = new CanvasDocument([frame, back, front, nested]);
    document.reorder(["back"], "front");
    assert.deepEqual(
      rows(render(document)).map((item) => item["data-layer-id"]),
      ["frame", "back", "front", "nested"],
    );
  });

  it("exposes independent selected rows and one keyboard entry point", () => {
    const items = rows(render(new CanvasDocument([frame, back, root]), ["back", "root"]));
    assert.deepEqual(
      items.filter((item) => item["aria-selected"] === "true").map((item) => item["data-layer-id"]),
      ["root", "back"],
    );
    assert.deepEqual(
      items.filter((item) => item.tabindex === "0").map((item) => item["data-layer-id"]),
      ["root"],
    );
  });

  it("distinguishes inherited locks from locks a user can clear on the layer itself", () => {
    const markup = render(
      new CanvasDocument([{ ...frame, locked: true }, back, { ...front, locked: true }]),
    );
    assert.equal(rows(markup).filter((item) => item["data-locked"] === "true").length, 3);
    const inheritedControl = markup.match(
      /<button[^>]*aria-label="Back is locked by its parent"[^>]*>/,
    )?.[0];
    assert.ok(inheritedControl?.includes('disabled=""'));
    const ownControl = markup.match(/<button[^>]*aria-label="Unlock Front"[^>]*>/)?.[0];
    assert.ok(ownControl);
    assert.ok(!ownControl.includes("disabled="));
    assert.match(markup, /aria-label="Unlock Frame"/);
  });

  it("bounds mounted rows for a large document while keeping an offscreen selection reachable", () => {
    const document = new CanvasDocument(
      Array.from({ length: 1000 }, (_, index) => ({
        ...root,
        id: `layer-${index}`,
        name: `Layer ${index}`,
      })),
    );
    const items = rows(render(document, ["layer-0"]));
    assert.ok(items.length < 50, `${items.length} layer rows were mounted`);
    assert.equal(items[0]["data-layer-id"], "layer-999");
    const selected = items.find((item) => item["data-layer-id"] === "layer-0");
    assert.equal(selected?.["aria-selected"], "true");
    assert.equal(selected?.["aria-posinset"], "1000");
    assert.equal(selected?.["aria-setsize"], "1000");
    assert.equal(selected?.tabindex, "0");
  });

  it("keeps hidden branches in the layer list with actionable eye controls", () => {
    const markup = render(
      new CanvasDocument([{ ...frame, hidden: true }, back, { ...front, hidden: true }]),
    );
    assert.equal(rows(markup).filter((item) => item["data-hidden"] === "true").length, 3);
    assert.match(markup, /aria-label="Show Frame"/);
    assert.match(markup, /aria-label="Show Front"/);
    const inherited = markup.match(
      /<button[^>]*aria-label="Back is hidden by its parent"[^>]*>/,
    )?.[0];
    assert.ok(inherited?.includes('disabled=""'));
  });

  it("retains the panel control on an empty canvas without an empty keyboard tree", () => {
    const markup = render(new CanvasDocument());
    assert.match(markup, /aria-label="Hide layers"/);
    assert.match(markup, /Your layers will appear here/);
    assert.ok(!markup.includes('role="tree"'));
  });
});
