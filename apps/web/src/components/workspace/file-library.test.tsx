/// <reference types="node" />

import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import type { FileLibrary } from "@/lib/local-files";
import { WORKSPACE_SESSION_KEY } from "@/lib/workspace-session";

import { FileLibraryView } from "./file-library";

const library: FileLibrary = {
  directory: "/tmp/flies",
  warnings: [],
  files: [
    {
      id: "poster",
      name: "Poster",
      updatedAt: 2_000,
      createdAt: 1_000,
      nodeCount: 3,
      preview: [
        { id: "board", kind: "frame", x: 0, y: 0, width: 800, height: 600, fill: "#ffffff" },
        {
          id: "hero",
          parentId: "board",
          kind: "rectangle",
          x: 40,
          y: 40,
          width: 720,
          height: 180,
          fill: "#3b82f6",
        },
        {
          id: "title",
          parentId: "board",
          kind: "text",
          x: 40,
          y: 248,
          width: 400,
          height: 40,
          text: "Summer sale",
          color: "#111111",
          fontSize: 32,
        },
      ],
      archived: false,
    },
    {
      id: "notes",
      name: "Notes",
      updatedAt: 1_000,
      createdAt: 500,
      nodeCount: 2,
      preview: [],
      archived: false,
    },
    {
      id: "old",
      name: "Old Draft",
      updatedAt: 500,
      createdAt: 400,
      nodeCount: 1,
      preview: [],
      archived: true,
    },
  ],
};

function render(desktop = true) {
  return renderToStaticMarkup(
    <FileLibraryView
      library={library}
      busy={false}
      error=""
      desktop={desktop}
      onCreate={async () => {}}
      onOpen={() => {}}
      onImport={() => {}}
      onArchive={async () => {}}
      onRestore={async () => {}}
      onRefresh={async () => {}}
      onBrowser={() => {}}
    />,
  );
}

function withSession(session: Record<string, unknown> | null, run: () => void) {
  const store = new Map<string, string>();
  if (session) store.set(WORKSPACE_SESSION_KEY, JSON.stringify(session));
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
    run();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previous });
  }
}

describe("file library startup sidebar", () => {
  it("defaults to Recents with muted nav icons and a search field", () => {
    withSession(null, () => {
      const markup = render();
      assert.match(markup, /aria-label="Search files"/);
      assert.match(markup, /<h1[^>]*>Recents<\/h1>/);
      assert.match(markup, /aria-current="page"/);
      assert.match(markup, /<span>Recents<\/span>/);
      assert.match(markup, /<span>Files<\/span>/);
      assert.match(markup, /<span>Archive<\/span>/);
      assert.match(markup, /<span>Settings<\/span>/);
      assert.doesNotMatch(markup, /data-sidebar="footer"/);
      assert.ok(markup.indexOf("<span>Archive</span>") < markup.indexOf("<span>Settings</span>"));
      assert.match(
        markup,
        /data-sidebar="menu-button"[^>]*>[\s\S]*?<svg[\s\S]*?text-muted-foreground/,
      );
      assert.match(markup, />Poster</);
      assert.match(markup, /class="library-grid"/);
      assert.match(markup, /class="library-preview"/);
      assert.match(markup, /fill="#3b82f6"/);
      assert.match(markup, />Summer sale</);
      assert.match(markup, /class="library-preview library-preview-empty"/);
      assert.ok(markup.indexOf("Poster") < markup.indexOf("Notes"));
      assert.doesNotMatch(markup, /Old Draft/);
    });
  });

  it("restores the last library section", () => {
    withSession({ librarySection: "settings" }, () => {
      const markup = render();
      assert.match(markup, /<h1[^>]*>Settings<\/h1>/);
      assert.match(markup, />Updates</);
      assert.match(markup, /Check for updates/);
      assert.doesNotMatch(markup, /<h1[^>]*>Recents<\/h1>/);
    });
  });
});
