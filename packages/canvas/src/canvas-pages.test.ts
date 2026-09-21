/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { CanvasCamera } from "./canvas-camera";
import { CanvasDocument, type CanvasFrame, type CanvasFrameNode } from "./canvas-document";
import { CanvasHitTester } from "./canvas-hit-test";
import { canvasPage, ensureCanvasPages, nextPageName } from "./canvas-pages";
import { CanvasScene } from "./canvas-scene";

function frame(id: string, parentId?: string, x = 0): CanvasFrameNode {
  return { id, name: `Frame ${id}`, parentId, x, y: 0, width: 320, height: 240 };
}

const twoPages = () => [
  canvasPage("Default", "home"),
  frame("hero", "home"),
  canvasPage("Drafts", "drafts"),
  frame("sketch", "drafts"),
];

describe("canvas page migration", () => {
  it("moves root artwork of a document saved before pages into one page", () => {
    const nodes = ensureCanvasPages([frame("a"), frame("b", "a")], "Default", () => "page");

    assert.deepEqual(
      nodes.map((node) => [node.id, node.kind, node.parentId]),
      [
        ["page", "page", undefined],
        ["a", undefined, "page"],
        ["b", undefined, "a"],
      ],
    );
    assert.equal(nodes[0].name, "Default");
  });

  it("leaves a document that already has pages untouched", () => {
    const nodes = twoPages();
    assert.deepEqual(ensureCanvasPages(nodes), nodes);
  });

  it("adopts nodes orphaned by a concurrently deleted page instead of hiding them", () => {
    const stray = frame("stray");
    const nodes = ensureCanvasPages([...twoPages(), stray]);
    assert.equal(nodes.find((node) => node.id === "stray")!.parentId, "home");
    assert.equal(nodes.filter((node) => node.kind === "page").length, 2);
  });

  it("names new pages around the ones already taken", () => {
    assert.equal(nextPageName([]), "Page 1");
    // Names the user chose never push the counter forward.
    assert.equal(nextPageName([canvasPage("Page 1", "a"), canvasPage("Notes", "b")]), "Page 2");
    assert.equal(nextPageName([canvasPage("Page 1", "a"), canvasPage("Page 2", "b")]), "Page 3");
  });

  it("rejects a page carrying geometry or a parent", () => {
    const document = new CanvasDocument([canvasPage("Default", "home")]);
    assert.equal(document.add({ ...canvasPage("Bad", "bad"), width: 40 } as CanvasFrame), false);
    assert.equal(document.add({ ...canvasPage("Bad", "bad"), parentId: "home" }), false);
    assert.equal(document.getPageIds().length, 1);
  });
});

describe("canvas page scoping", () => {
  it("resolves roots, scene ids and new nodes against the active page", () => {
    const document = new CanvasDocument(twoPages());
    assert.deepEqual(document.getPageIds(), ["home", "drafts"]);
    assert.equal(document.getActivePageId(), "home");
    assert.deepEqual(document.getChildren(), ["hero"]);
    assert.deepEqual(document.getSceneIds(), ["hero"]);

    // A node added without a parent belongs to the canvas being edited.
    assert.equal(document.add(frame("added")), true);
    assert.equal(document.getFrame("added")!.parentId, "home");

    assert.equal(document.setActivePage("drafts"), true);
    assert.deepEqual(document.getChildren(), ["sketch"]);
    assert.deepEqual(document.getSceneIds(), ["sketch"]);
    assert.equal(document.getIds().length, 5);
  });

  it("keeps a page switch out of history and out of saved frames", () => {
    const document = new CanvasDocument(twoPages());
    const before = document.getCommittedFrames();
    document.setActivePage("drafts");
    assert.deepEqual(document.getCommittedFrames(), before);
    assert.equal(document.getSnapshot().canUndo, false);
    assert.equal(document.getHistoryStats().undoEntries, 0);
  });

  it("publishes a page switch so subscribed views re-read the scoped tree", () => {
    const document = new CanvasDocument(twoPages());
    let notifications = 0;
    let pageChanges = 0;
    document.subscribe(() => notifications++);
    document.subscribeActivePage(() => pageChanges++);
    const before = document.getSnapshot();
    assert.equal(document.setActivePage("drafts"), true);
    assert.equal(notifications, 1);
    assert.equal(pageChanges, 1);
    assert.notEqual(document.getSnapshot(), before);
    // Switching to the page already shown is not a change.
    assert.equal(document.setActivePage("drafts"), false);
    assert.equal(notifications, 1);
  });

  it("falls back to a surviving page when the active one is deleted", () => {
    const document = new CanvasDocument(twoPages());
    document.setActivePage("drafts");
    document.removeMany(["drafts"]);
    assert.equal(document.getActivePageId(), "home");
    assert.equal(document.getFrame("sketch"), undefined);
  });

  it("keeps documents without pages behaving exactly as before", () => {
    const document = new CanvasDocument([frame("a"), frame("b")]);
    assert.equal(document.getActivePageId(), undefined);
    assert.deepEqual(document.getPageIds(), []);
    assert.deepEqual(document.getChildren(), ["a", "b"]);
    assert.deepEqual(document.getSceneIds(), ["a", "b"]);
    assert.equal(document.add(frame("c")), true);
    assert.equal(document.getFrame("c")!.parentId, undefined);
  });

  it("drops layers onto the active page and keeps page reordering at the root", () => {
    const document = new CanvasDocument(twoPages());
    document.setActivePage("drafts");
    document.moveLayers(["sketch"], null, "after");
    assert.equal(document.getFrame("sketch")!.parentId, "drafts");

    // The layer list runs front-to-back, so "after" puts Drafts earlier in document order.
    assert.equal(document.moveLayers(["drafts"], "home", "after"), true);
    assert.deepEqual(document.getPageIds(), ["drafts", "home"]);
    assert.equal(document.getFrame("drafts")!.parentId, undefined);
  });
});

function withScene(
  initial: readonly CanvasFrame[],
  run: (scene: CanvasScene, document: CanvasDocument) => void,
) {
  const request = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const cancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: () => 1,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: () => {},
  });
  const document = new CanvasDocument(initial);
  const camera = new CanvasCamera();
  camera.setSize({ x: 1000, y: 800 });
  camera.flush();
  const scene = new CanvasScene(document, camera);
  const disconnect = scene.connect();

  try {
    run(scene, document);
  } finally {
    disconnect();
    camera.cancel();
    if (request) Object.defineProperty(globalThis, "requestAnimationFrame", request);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
    if (cancel) Object.defineProperty(globalThis, "cancelAnimationFrame", cancel);
    else Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
  }
}

describe("canvas page rendering and picking", () => {
  it("mounts only the active page and re-roots its children", () => {
    withScene(twoPages(), (scene, document) => {
      assert.deepEqual(scene.getSnapshot(), ["hero"]);
      // The page node itself never mounts; its children are the scene's roots.
      assert.deepEqual(scene.getVisibleChildren(), ["hero"]);

      document.setActivePage("drafts");
      assert.deepEqual(scene.getSnapshot(), ["sketch"]);
      assert.deepEqual(scene.getVisibleChildren(), ["sketch"]);
    });
  });

  it("never picks artwork from another page at the same coordinates", () => {
    const document = new CanvasDocument(twoPages());
    const tester = new CanvasHitTester(document);
    const disconnect = tester.connect();
    assert.equal(tester.hit({ x: 10, y: 10 }), "hero");

    document.setActivePage("drafts");
    assert.equal(tester.hit({ x: 10, y: 10 }), "sketch");
    disconnect();
  });
});
