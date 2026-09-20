import assert from "node:assert/strict";

import { CanvasDocument, agentActivity, withAgentActivity } from "@flies/canvas";
import { test } from "vite-plus/test";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { editorTool } from "./editor";

const makeDocument = () =>
  new CanvasDocument([{ id: "frame", name: "Frame", x: 0, y: 0, width: 400, height: 300 }]);

test("presence follows actual MCP edits and remains saving until persistence completes", async () => {
  const document = makeDocument();
  const store = agentActivity(document);
  let finishSave!: () => void;
  const saved = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const task = withAgentActivity(document, "update_node", { nodeId: "frame" }, async (saving) => {
    await editorTool({ document, prepare: () => {} } as CanvasControls, "update_node", {
      nodeId: "frame",
      properties: { x: 120 },
    });
    saving();
    await saved;
  });
  await Promise.resolve();
  assert.equal(store.getSnapshot()?.phase, "saving");
  assert.deepEqual(store.getSnapshot()?.changedIds, ["frame"]);
  finishSave();
  await task;
  assert.equal(store.getSnapshot()?.label, "Synced");
});

test("failed saves show attention rather than synced", async () => {
  const document = makeDocument();
  await assert.rejects(
    withAgentActivity(document, "save_file", {}, async (saving) => {
      saving();
      throw new Error("Disk full");
    }),
  );
  assert.equal(agentActivity(document).getSnapshot()?.phase, "error");
});

test("human changes are not attributed to the agent and files have independent presence", () => {
  const document = makeDocument();
  const store = agentActivity(document);
  store.begin("write_html", { parentId: "frame" });
  document.update({ ...document.getFrame("frame")!, x: 75 });
  assert.deepEqual(store.getSnapshot()?.changedIds, []);
  assert.equal(agentActivity(makeDocument()).getSnapshot(), null);
});

test("deleted footprints remain available and stale requests cannot clear newer activity", () => {
  const document = makeDocument();
  const store = agentActivity(document);
  const first = store.begin("delete_nodes", { nodeIds: ["frame"] });
  store.capture(document, () => document.remove("frame"));
  assert.deepEqual(store.getSnapshot()?.changedIds, []);
  assert.equal(store.getSnapshot()?.removed[0].width, 400);
  const second = store.begin("get_tree", {});
  store.finish(first, true);
  assert.equal(store.getSnapshot()?.sequence, second);
  assert.equal(store.getSnapshot()?.phase, "working");
});

test("HTML replacement presence follows its target rather than its parent", () => {
  const document = makeDocument();
  const store = agentActivity(document);
  store.begin("write_html", { targetId: "section", parentId: "frame" });
  assert.deepEqual(store.getSnapshot()?.nodeIds, ["section"]);
  store.begin("write_html", { parentId: "frame" });
  assert.deepEqual(store.getSnapshot()?.nodeIds, ["frame"]);
});
