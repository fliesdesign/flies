import assert from "node:assert/strict";

import { afterEach, describe, it } from "vite-plus/test";

import {
  getCanvasInspection,
  getCanvasInspectionServerSnapshot,
  setCanvasInspection,
  subscribeCanvasInspection,
} from "./canvas-inspection";

const STORAGE_KEY = "flies.canvas.renderer";

describe("canvas renderer preference", () => {
  const storage = new Map<string, string>();
  const storageListeners = new Set<(event: Event) => void>();
  const subscriptions: (() => void)[] = [];

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

  function mount(listener = () => {}) {
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
    const unsubscribe = subscribeCanvasInspection(listener);
    subscriptions.push(unsubscribe);

    return unsubscribe;
  }

  function storageEvent(key: string | null, newValue: string | null, storageArea = localStorage) {
    const event = Object.assign(new Event("storage"), { key, newValue, storageArea });
    for (const listener of storageListeners) listener(event);
  }

  afterEach(() => {
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    storage.clear();
    storageListeners.clear();
    Reflect.deleteProperty(globalThis, "window");
    setCanvasInspection(true);
  });

  it("defaults to HTML and ignores the previous GPU renderer preference", () => {
    localStorage.setItem("flies.canvas.inspect-html", "false");
    mount();
    assert.equal(getCanvasInspection(), true);
    assert.equal(getCanvasInspectionServerSnapshot(), true);
    assert.equal(localStorage.getItem(STORAGE_KEY), null);
  });

  it("persists explicit opt-in and keeps hydration on HTML", () => {
    mount();
    let updates = 0;
    subscriptions.push(subscribeCanvasInspection(() => updates++));

    setCanvasInspection(false);
    assert.equal(getCanvasInspection(), false);
    assert.equal(localStorage.getItem(STORAGE_KEY), "webgl2");
    assert.equal(getCanvasInspectionServerSnapshot(), true);
    assert.equal(updates, 1);

    setCanvasInspection(false);
    assert.equal(updates, 1);
    setCanvasInspection(true);
    assert.equal(getCanvasInspection(), true);
    assert.equal(localStorage.getItem(STORAGE_KEY), "dom");
    assert.equal(updates, 2);
  });

  it("restores a saved preference when an editor mounts", () => {
    localStorage.setItem(STORAGE_KEY, "webgl2");
    const unsubscribe = mount();
    assert.equal(getCanvasInspection(), false);
    assert.equal(storageListeners.size, 1);
    unsubscribe();
    assert.equal(storageListeners.size, 0);

    localStorage.setItem(STORAGE_KEY, "dom");
    mount();
    assert.equal(getCanvasInspection(), true);
  });

  it("synchronizes renderer changes across windows and resets after storage is cleared", () => {
    mount();
    storageEvent("unrelated", "webgl2");
    assert.equal(getCanvasInspection(), true);
    storageEvent(STORAGE_KEY, "webgl2", { ...localStorage });
    assert.equal(getCanvasInspection(), true);
    storageEvent(STORAGE_KEY, "webgl2");
    assert.equal(getCanvasInspection(), false);
    storageEvent(null, null);
    assert.equal(getCanvasInspection(), true);
    storageEvent(STORAGE_KEY, "unknown");
    assert.equal(getCanvasInspection(), true);
  });

  it("supports an in-memory renderer choice when browser storage is unavailable", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        ...windowStub,
        get localStorage() {
          throw new Error("Storage is disabled");
        },
      },
    });
    subscriptions.push(subscribeCanvasInspection(() => {}));
    setCanvasInspection(false);
    assert.equal(getCanvasInspection(), false);
    setCanvasInspection(true);
    assert.equal(getCanvasInspection(), true);
  });
});
