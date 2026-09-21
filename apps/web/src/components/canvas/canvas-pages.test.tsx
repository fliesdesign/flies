/// <reference types="node" />

import assert from "node:assert/strict";

import { canvasPage } from "@flies/canvas";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { CanvasPages } from "./canvas-pages";

const pages = [canvasPage("Default", "home"), canvasPage("Drafts", "drafts")];

function render(activePageId: string | undefined, list = pages) {
  return renderToStaticMarkup(
    <CanvasPages
      pages={list}
      activePageId={activePageId}
      onSelect={() => {}}
      onAdd={() => {}}
      onRename={() => {}}
      onRemove={() => {}}
    />,
  );
}

function rows(markup: string) {
  return [...markup.matchAll(/<div(?=[^>]*role="tab")[^>]*>/g)].map(([element]) =>
    Object.fromEntries([...element.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, v]) => [key, v])),
  );
}

describe("canvas pages panel", () => {
  it("lists every page and marks the one being edited", () => {
    const markup = render("drafts");
    const listed = rows(markup);
    assert.equal(listed.length, 2);
    assert.deepEqual(
      listed.map((row) => row["aria-selected"]),
      ["false", "true"],
    );
    assert.ok(markup.includes("Default"));
    assert.ok(markup.includes("Drafts"));
    assert.ok(markup.includes('aria-label="Add page"'));
  });

  it("keeps only the active row in the tab order", () => {
    assert.deepEqual(
      rows(render("home")).map((row) => row.tabindex),
      ["0", "-1"],
    );
  });

  it("renders a single-page document without an active row missing", () => {
    const markup = render("home", [pages[0]]);
    assert.equal(rows(markup).length, 1);
    assert.equal(rows(markup)[0]["aria-selected"], "true");
  });
});
