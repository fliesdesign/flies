/// <reference types="node" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { CanvasFrame, CanvasPen, CanvasText } from "@/lib/canvas-document";

import {
  CanvasNodeContent,
  CanvasTextEditor,
  canvasTextStyle,
  measureCanvasTextHeight,
  subscribeTextDraftLifecycle,
} from "./canvas-node-content";

const bounds = { id: "node", name: "Node", x: 0, y: 0, width: 240, height: 120 };
const render = (frame: CanvasFrame) =>
  renderToStaticMarkup(createElement(CanvasNodeContent, { frame }));

describe("canvas node content", () => {
  it("renders text as escaped multiline content instead of interpreting HTML", () => {
    const markup = render({
      ...bounds,
      kind: "text",
      text: '<img src="invalid" onerror="alert(1)">\nSecond line & detail',
      fontSize: 24,
      color: "#EDEDED",
    });
    assert.ok(!markup.includes("<img"));
    assert.match(markup, /&lt;img/);
    assert.match(markup, /\nSecond line &amp; detail/);
    assert.match(markup, /font-size:24px/);
  });

  it("starts text editing with the complete plain-text value and an accessible name", () => {
    const frame: CanvasText = {
      ...bounds,
      name: "Caption",
      kind: "text",
      text: "First line\n</textarea><script>alert(1)</script>",
      fontSize: 18,
      color: "#212121",
    };
    const markup = renderToStaticMarkup(createElement(CanvasTextEditor, { frame }));
    assert.match(markup, /aria-label="Edit Caption"/);
    assert.match(markup, /First line\n&lt;\/textarea&gt;&lt;script&gt;/);
    assert.ok(!markup.includes("<script>"));
    assert.equal(markup.match(/<\/textarea>/g)?.length, 1);
  });

  it("uses identical typography for the text node and its editor", () => {
    const frame: CanvasText = {
      ...bounds,
      kind: "text",
      text: "A caption",
      fontSize: 18,
      color: "#123456",
      fontFamily: "Georgia",
      fontWeight: 600,
      fontStyle: "italic",
      textDecoration: "underline",
      lineHeight: 1.8,
      letterSpacing: 1.5,
      textAlign: "right",
    };
    const content = render(frame);
    const editor = renderToStaticMarkup(createElement(CanvasTextEditor, { frame }));
    assert.equal(content.match(/style="([^"]*)"/)?.[1], editor.match(/style="([^"]*)"/)?.[1]);
    assert.match(content, /font-family:Georgia/);
    assert.match(content, /font-weight:600/);
    assert.match(content, /font-style:italic/);
    assert.match(content, /text-decoration:underline/);
    assert.match(content, /line-height:1.8/);
    assert.match(content, /letter-spacing:1.5px/);
    assert.match(content, /text-align:right/);
  });

  it("retains default typography and measures unwrapped line heights without a DOM", () => {
    const frame: CanvasText = {
      ...bounds,
      kind: "text",
      text: "One\nTwo\n",
      fontSize: 20,
      color: "#000",
    };
    assert.deepEqual(canvasTextStyle(frame), {
      color: "#000",
      fontSize: 20,
      fontFamily: "Arial, Helvetica, sans-serif",
      fontWeight: 400,
      fontStyle: "normal",
      textDecoration: "none",
      lineHeight: 1.25,
      letterSpacing: 0,
      textAlign: "left",
    });
    assert.equal(measureCanvasTextHeight(frame), 75);
    assert.equal(measureCanvasTextHeight({ ...frame, lineHeight: 2 }), 120);
    assert.equal(measureCanvasTextHeight({ ...frame, text: "" }), 25);
  });

  it("keeps pen geometry in its original viewBox when its node is resized", () => {
    const pen: CanvasPen = {
      ...bounds,
      kind: "pen",
      points: [
        { x: 2, y: 2 },
        { x: 20, y: 30 },
      ],
      stroke: "#EDEDED",
      strokeWidth: 2,
      pathWidth: 22,
      pathHeight: 32,
    };
    const initial = render(pen);
    assert.equal(render({ ...pen, width: 880, height: 64 }), initial);
    assert.match(initial, /viewBox="0 0 22 32"/);
    assert.match(initial, /preserveAspectRatio="none"/);
    assert.match(initial, /points="2,2 20,30"/);
    assert.match(initial, /stroke-linecap="round"/);
    assert.match(initial, /aria-hidden="true"/);
    assert.match(initial, /focusable="false"/);
  });

  it("renders a single pen point as a visible dot", () => {
    const markup = render({
      ...bounds,
      kind: "pen",
      points: [{ x: 2, y: 2 }],
      stroke: "#EDEDED",
      strokeWidth: 4,
      pathWidth: 4,
      pathHeight: 4,
    });
    assert.match(markup, /<circle cx="2" cy="2" r="2" fill="#EDEDED"/);
    assert.ok(!markup.includes("<polyline"));
  });

  it("keeps image content decorative and disables native dragging", () => {
    const markup = render({
      ...bounds,
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
    });
    assert.match(markup, /alt=""/);
    assert.match(markup, /draggable="false"/);
    assert.match(markup, /decoding="async"/);
  });

  it("renders rectangle fills while leaving legacy and explicit frame shells to the scene", () => {
    assert.match(render({ ...bounds, kind: "rectangle", fill: "#414141" }), /background:#414141/);
    assert.equal(render(bounds), "");
    assert.equal(render({ ...bounds, kind: "frame" }), "");
  });

  it("applies corner radius to both shape and image content", () => {
    const rectangle = render({ ...bounds, kind: "rectangle", fill: "#123", cornerRadius: 16 });
    const image = render({
      ...bounds,
      kind: "image",
      src: "data:image/png;base64,iVBORw0KGgo=",
      cornerRadius: 24,
    });
    assert.match(rectangle, /border-radius:16px/);
    assert.match(image, /border-radius:24px/);
  });
});

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
