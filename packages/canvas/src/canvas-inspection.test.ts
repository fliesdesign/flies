import assert from "node:assert/strict";

import { afterEach, describe, it } from "vite-plus/test";

import {
  getCanvasInspection,
  getCanvasInspectionServerSnapshot,
  isCanvasInspectionForced,
  setCanvasInspection,
  subscribeCanvasInspection,
} from "./canvas-inspection";

describe("forced canvas inspection", () => {
  const storage = new Map<string, string>();
  const storageListeners = new Set<(event: Event) => void>();

  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };

  const windowStub = {
    localStorage,
    addEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === "storage") storageListeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      if (type === "storage") storageListeners.delete(listener);
    },
  };

  afterEach(() => {
    storage.clear();
    storageListeners.clear();
    Reflect.deleteProperty(globalThis, "window");
    setCanvasInspection(true);
  });

  it("stays on for hydration and leaves the saved preference untouched", () => {
    assert.equal(isCanvasInspectionForced(), true);
    assert.equal(getCanvasInspectionServerSnapshot(), true);
    let windowReads = 0;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      get() {
        windowReads += 1;

        return windowStub;
      },
    });
    localStorage.setItem("flies.canvas.inspect-html", "false");

    assert.equal(getCanvasInspection(), true);

    const unsubscribe = subscribeCanvasInspection(() => {});

    try {
      assert.ok(windowReads > 0);
      for (const listener of storageListeners) listener(new Event("storage"));
      assert.equal(getCanvasInspection(), true);
      assert.equal(storageListeners.size, 0);

      setCanvasInspection(false);
      assert.equal(getCanvasInspection(), false);
      assert.equal(localStorage.getItem("flies.canvas.inspect-html"), "false");

      setCanvasInspection(true);
      assert.equal(getCanvasInspection(), true);
      assert.equal(localStorage.getItem("flies.canvas.inspect-html"), "false");
    } finally {
      unsubscribe();
    }
  });
});
