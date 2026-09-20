/// <reference types="node" />
/** @vitest-environment happy-dom */

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { subscribeTextDraftLifecycle } from "./canvas-node-content";

describe("text draft lifecycle commits", () => {
  it("commits the latest draft before an earlier-registered pagehide save listener", () => {
    const page = new EventTarget();
    const visibility = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
    let inputValue = "Initial text";
    let committed = inputValue;
    const saved: string[] = [];
    page.addEventListener("pagehide", () => saved.push(committed));

    const unsubscribe = subscribeTextDraftLifecycle(
      () => (committed = inputValue),
      page,
      visibility,
    );

    inputValue = "Latest input before blur";
    page.dispatchEvent(new Event("pagehide"));
    assert.deepEqual(saved, ["Latest input before blur"]);
    unsubscribe();
  });

  it("commits before hidden-page saving without committing visible transitions", () => {
    const page = new EventTarget();

    const visibility = Object.assign(new EventTarget(), {
      visibilityState: "visible" as DocumentVisibilityState,
    });

    let inputValue = "Initial text";
    let committed = inputValue;
    let commits = 0;
    const saved: string[] = [];
    visibility.addEventListener("visibilitychange", () => saved.push(committed));

    const unsubscribe = subscribeTextDraftLifecycle(
      () => {
        committed = inputValue;
        commits++;
      },
      page,
      visibility,
    );

    inputValue = "Unsaved draft";
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.equal(commits, 0);
    visibility.visibilityState = "hidden";
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.deepEqual(saved, ["Initial text", "Unsaved draft"]);
    assert.equal(commits, 1);
    unsubscribe();
  });

  it("removes both capture listeners when editing finishes", () => {
    const page = new EventTarget();
    const visibility = Object.assign(new EventTarget(), { visibilityState: "hidden" as const });
    let commits = 0;
    const unsubscribe = subscribeTextDraftLifecycle(() => commits++, page, visibility);
    unsubscribe();
    page.dispatchEvent(new Event("pagehide"));
    visibility.dispatchEvent(new Event("visibilitychange"));
    assert.equal(commits, 0);
  });
});
