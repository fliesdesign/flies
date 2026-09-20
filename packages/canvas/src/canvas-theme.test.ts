import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CanvasDocument,
  loadCanvasFrames,
  loadCanvasTheme,
  saveCanvasFrames,
  type CanvasFrame,
} from "./canvas-document";
import { packCanvasProject, unpackCanvasProject } from "./canvas-project";
import {
  EMPTY_THEME,
  STARTER_THEME,
  applyTokenBindings,
  normalizeTheme,
  themeCss,
  tokenMatchesProperty,
  type CanvasTheme,
} from "./canvas-theme";

const theme: CanvasTheme = {
  tokens: [
    { id: "brand", name: "Brand", type: "color", value: "#123456" },
    { id: "space", name: "Space", type: "spacing", value: 20 },
    { id: "body", name: "Body", type: "fontFamily", value: "Georgia" },
    { id: "large", name: "Large", type: "fontSize", value: 32 },
    { id: "bold", name: "Bold", type: "fontWeight", value: 700 },
    { id: "leading", name: "Leading", type: "lineHeight", value: 1.5 },
    { id: "track", name: "Track", type: "letterSpacing", value: 0.5 },
    { id: "page", name: "Page", type: "container", value: 1024 },
    { id: "tablet", name: "Tablet", type: "breakpoint", value: 768 },
  ],
};

const rectangle: CanvasFrame = {
  id: "rect",
  name: "Rectangle",
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  fill: "#000000",
  tokenBindings: { fill: "brand" },
};

const recolor = (value: string): CanvasTheme => ({
  tokens: theme.tokens.map((token) => (token.id === "brand" ? { ...token, value } : token)),
});

describe("document theme tokens", () => {
  it("updates linked layers and theme in a single undoable operation", () => {
    const doc = new CanvasDocument([rectangle], theme);
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#123456");
    const before = doc.getFrame("rect");
    doc.setTheme(recolor("#abcdef"));
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#abcdef");
    assert.equal(doc.getHistoryStats().undoEntries, 1);
    doc.undo();
    assert.deepEqual(doc.getTheme(), theme);
    assert.deepEqual(doc.getFrame("rect"), before);
    doc.redo();
    assert.deepEqual(doc.getTheme(), recolor("#abcdef"));
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#abcdef");
  });

  it("bakes deleted tokens and restores their bindings on undo", () => {
    const doc = new CanvasDocument([rectangle], theme);
    doc.setTheme(EMPTY_THEME);
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#123456");
    assert.equal(doc.getFrame("rect")!.tokenBindings, undefined);
    doc.undo();
    assert.deepEqual(doc.getFrame("rect")!.tokenBindings, { fill: "brand" });
    doc.setTheme(recolor("#abcdef"));
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#abcdef");
  });

  it("detaches manual values but restores bindings when a preview is cancelled", () => {
    const doc = new CanvasDocument([rectangle], theme);
    const before = doc.getFrame("rect")!;
    doc.beginGesture("rect");
    doc.preview({ ...before, fill: "#ffffff" } as CanvasFrame);
    assert.equal(doc.getFrame("rect")!.tokenBindings, undefined);
    doc.endGesture(true);
    assert.deepEqual(doc.getFrame("rect"), before);
    doc.update({ ...before, fill: "#ffffff" } as CanvasFrame);
    assert.equal(doc.getFrame("rect")!.tokenBindings, undefined);
    doc.setTheme(recolor("#abcdef"));
    assert.equal(Reflect.get(doc.getFrame("rect")!, "fill"), "#ffffff");
  });

  it("reflows token-driven layout on load and theme edits without replacing IDs", () => {
    const board: CanvasFrame = {
      id: "board",
      name: "Board",
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      tokenBindings: { layoutGap: "space", layoutPadding: "space" },
    };

    const doc = new CanvasDocument(
      [
        board,
        { ...rectangle, parentId: "board" },
        { ...rectangle, id: "other", parentId: "board" },
      ],
      theme,
    );

    assert.equal(doc.getFrame("rect")!.x, 20);
    assert.equal(doc.getFrame("other")!.x, 140);
    doc.setTheme({
      tokens: theme.tokens.map((token) => (token.id === "space" ? { ...token, value: 40 } : token)),
    });
    assert.equal(doc.getFrame("other")!.x, 180);
    doc.undo();
    assert.equal(doc.getFrame("other")!.x, 140);
    assert.deepEqual(doc.getIds(), ["board", "rect", "other"]);
  });

  it("remeasures linked typography and rejects incompatible bindings", () => {
    const text: CanvasFrame = {
      id: "text",
      name: "Text",
      kind: "text",
      text: "Hello",
      x: 0,
      y: 0,
      width: 100,
      height: 20,
      fontSize: 16,
      color: "#000000",
      tokenBindings: { fontSize: "large" },
    };

    const doc = new CanvasDocument([text], theme);
    doc.setTheme(
      {
        tokens: theme.tokens.map((token) =>
          token.id === "large" ? { ...token, value: 40 } : token,
        ),
      },
      (node) => node.fontSize * 2,
    );
    assert.equal(doc.getFrame("text")!.height, 80);

    const typed = applyTokenBindings(
      text,
      theme,
      { fontWeight: "bold", lineHeight: "leading", letterSpacing: "track" },
      true,
    );

    const legacy = applyTokenBindings(text, theme, { letterSpacing: "space" }, true);
    if (typed.kind !== "text" || legacy.kind !== "text") throw new Error("expected text");
    assert.equal(typed.fontWeight, 700);
    assert.equal(typed.lineHeight, 1.5);
    assert.equal(typed.letterSpacing, 0.5);
    assert.equal(legacy.letterSpacing, 20);
    assert.equal(
      tokenMatchesProperty(
        theme.tokens.find((token) => token.id === "space")!,
        "letterSpacing",
      ),
      true,
    );
    assert.throws(
      () => applyTokenBindings(text, theme, { fontSize: "brand" }, true),
      /incompatible/,
    );
    assert.throws(
      () => applyTokenBindings(rectangle, theme, { fontFamily: "body" }, true),
      /cannot/,
    );
    assert.throws(
      () => applyTokenBindings(rectangle, theme, { fontWeight: "bold" }, true),
      /cannot/,
    );
  });

  it("round trips themes and links through portable ZIP and browser storage", () => {
    const doc = new CanvasDocument([rectangle], theme);
    const project = unpackCanvasProject(packCanvasProject("Themed", doc.getFrames(), theme));
    assert.deepEqual(project.theme, theme);
    const reopened = new CanvasDocument(project.nodes, project.theme);
    reopened.setTheme(recolor("#fedcba"));
    assert.equal(Reflect.get(reopened.getFrame("rect")!, "fill"), "#fedcba");
    let stored = "";
    saveCanvasFrames(
      doc.getFrames(),
      {
        setItem: (_, value) => {
          stored = value;
        },
      },
      theme,
    );
    const storage = { getItem: () => stored };
    assert.deepEqual(loadCanvasTheme(storage), theme);
    assert.deepEqual(loadCanvasFrames(storage), doc.getFrames());
    assert.deepEqual(loadCanvasTheme({ getItem: () => '{"version":2,"nodes":[]}' }), EMPTY_THEME);
  });

  it("rejects invalid tokens without changing nodes, theme, or history", () => {
    const doc = new CanvasDocument([rectangle], theme);
    const before = doc.getSnapshot();

    for (const invalid of [
      recolor("red"),
      { tokens: [theme.tokens[0], theme.tokens[0]] },
      { tokens: [{ ...theme.tokens[1], value: -1 }] },
    ]) {
      assert.throws(() => doc.setTheme(invalid));
      assert.equal(doc.getSnapshot(), before);
      assert.deepEqual(doc.getTheme(), theme);
    }

    assert.throws(() => normalizeTheme({ tokens: [{ ...theme.tokens[0], id: "Bad ID" }] }));
    assert.throws(() =>
      normalizeTheme({ tokens: [{ id: "bad-lead", name: "Bad", type: "lineHeight", value: 5 }] }),
    );
    assert.match(themeCss(theme), /--brand:#123456;/);
    assert.match(themeCss(theme), /--space:20px;/);
    assert.match(themeCss(theme), /--body:"Georgia";/);
    assert.match(themeCss(theme), /--bold:700;/);
    assert.match(themeCss(theme), /--leading:1.5;/);
    assert.match(themeCss(theme), /--track:0.5px;/);
    assert.match(themeCss(theme), /--page:1024px;/);
    assert.match(themeCss(theme), /--tablet:768px;/);
  });

  it("accepts the starter theme used by the Theme tab", () => {
    const starter = normalizeTheme(STARTER_THEME);
    assert.equal(starter.tokens.length, STARTER_THEME.tokens.length);
    assert.equal(starter.tokens[0]?.id, "color-gray-50");
    assert.equal(starter.tokens.filter((token) => token.type === "color").length, 22);
    assert.equal(starter.tokens.filter((token) => token.type === "container").length, 10);
    assert.equal(starter.tokens.filter((token) => token.type === "breakpoint").length, 5);
    assert.equal(starter.tokens.filter((token) => token.type === "fontWeight").length, 9);
    assert.equal(starter.tokens.filter((token) => token.type === "lineHeight").length, 6);
    assert.equal(starter.tokens.filter((token) => token.type === "letterSpacing").length, 6);
    assert.equal(starter.tokens.find((token) => token.id === "font-weight-bold")?.name, "bold");
    assert.equal(starter.tokens.find((token) => token.id === "container-2xl")?.name, "2xl");
    assert.equal(starter.tokens.find((token) => token.id === "breakpoint-sm")?.name, "sm");
  });
});
