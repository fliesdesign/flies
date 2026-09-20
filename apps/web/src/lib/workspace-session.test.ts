/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  DEFAULT_WORKSPACE_SESSION,
  MAX_OPEN_TABS,
  WORKSPACE_SESSION_KEY,
  loadWorkspaceSession,
  normalizeWorkspaceSession,
  patchWorkspaceSession,
  restoreableActiveId,
  restoreableOpenIds,
  saveWorkspaceSession,
} from "./workspace-session";

describe("workspace session", () => {
  it("keeps tab order, drops junk, and treats a missing active tab as Files", () => {
    const session = normalizeWorkspaceSession({
      openIds: ["aa", "aa", "../secret", "bb", 3, ""],
      activeId: "missing",
      librarySection: "settings",
      sidebarTab: "theme",
    });

    assert.deepEqual(session.openIds, ["aa", "bb"]);
    assert.equal(session.activeId, null);
    assert.equal(session.librarySection, "settings");
    assert.equal(session.sidebarTab, "theme");
    assert.deepEqual(restoreableOpenIds(session, ["bb", "cc"]), ["bb"]);
    assert.equal(restoreableActiveId({ ...session, activeId: "bb" }, ["aa", "bb"]), "bb");
    assert.equal(restoreableActiveId({ ...session, activeId: "bb" }, ["aa"]), null);
  });

  it("caps restored tabs and round-trips through storage", () => {
    const ids = Array.from({ length: MAX_OPEN_TABS + 4 }, (_, index) => index.toString(16));

    const session = normalizeWorkspaceSession({
      openIds: ids,
      activeId: ids[0],
    });

    assert.equal(session.openIds.length, MAX_OPEN_TABS);
    assert.equal(session.activeId, ids[0]);
    const store = new Map<string, string>();
    const previous = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });

    try {
      assert.deepEqual(loadWorkspaceSession(), DEFAULT_WORKSPACE_SESSION);
      saveWorkspaceSession({
        ...DEFAULT_WORKSPACE_SESSION,
        openIds: ["dead-beef"],
        activeId: "dead-beef",
        librarySection: "archive",
      });
      assert.equal(store.has(WORKSPACE_SESSION_KEY), true);
      assert.deepEqual(loadWorkspaceSession(), {
        ...DEFAULT_WORKSPACE_SESSION,
        openIds: ["dead-beef"],
        activeId: "dead-beef",
        librarySection: "archive",
      });
      patchWorkspaceSession({ sidebarTab: "theme", activeId: null });
      assert.equal(loadWorkspaceSession().sidebarTab, "theme");
      assert.equal(loadWorkspaceSession().activeId, null);
      assert.deepEqual(loadWorkspaceSession().openIds, ["dead-beef"]);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "localStorage");
      } else {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: previous,
        });
      }
    }
  });
});
