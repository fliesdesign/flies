/// <reference types="node" />
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";

import { describe, it } from "vite-plus/test";

import { LayerHoverExpansion } from "./canvas-layer-hover";

describe("layer hover expansion", () => {
  it("expands a stable target once despite repeated pointer updates", async () => {
    const hover = new LayerHoverExpansion(5);
    const expanded: string[] = [];
    const expand = (id: string) => expanded.push(id);
    hover.update("frame", expand);
    hover.update("frame", expand);
    await wait(20);
    hover.update("frame", expand);
    await wait(10);
    assert.deepEqual(expanded, ["frame"]);
    hover.cancel();
  });

  it("cancels the previous target when the pointer chooses another container", async () => {
    const hover = new LayerHoverExpansion(5);
    const expanded: string[] = [];
    const expand = (id: string) => expanded.push(id);
    hover.update("first", expand);
    hover.update("second", expand);
    await wait(20);
    assert.deepEqual(expanded, ["second"]);
    hover.cancel();
  });

  it("does not expand after leaving, cancelling, completing, or unmounting a drag", async () => {
    const hover = new LayerHoverExpansion(5);
    const expanded: string[] = [];
    const expand = (id: string) => expanded.push(id);
    hover.update("left", expand);
    hover.update(null, expand);
    await wait(15);
    hover.update("cancelled", expand);
    hover.cancel();
    await wait(15);
    assert.deepEqual(expanded, []);
    hover.update("next drag", expand);
    await wait(15);
    assert.deepEqual(expanded, ["next drag"]);
    hover.cancel();
  });
});
