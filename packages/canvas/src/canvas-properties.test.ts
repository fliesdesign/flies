/// <reference types="node" />

import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  CanvasDocument,
  type CanvasFrame,
  type CanvasText,
  type CanvasFrameNode,
} from "./canvas-document";
import { changeCanvasProperty, type CanvasProperty } from "./canvas-properties";

const outer: CanvasFrame = {
  id: "outer",
  name: "Outer",
  x: 100,
  y: 200,
  width: 500,
  height: 500,
};

const frame: CanvasFrame = {
  id: "frame",
  name: "Frame",
  parentId: "outer",
  x: 120,
  y: 230,
  width: 200,
  height: 100,
};

const rectangle: CanvasFrame = {
  id: "rectangle",
  name: "Rectangle",
  kind: "rectangle",
  parentId: "frame",
  x: 130,
  y: 240,
  width: 80,
  height: 60,
  fill: "#abcdef",
};

const text: CanvasText = {
  id: "text",
  name: "Text",
  kind: "text",
  x: 700,
  y: 100,
  width: 240,
  height: 30,
  text: "A caption that can wrap",
  fontSize: 24,
  color: "#123456",
};

const noMeasurement = () => assert.fail("This property must not measure text");

describe("canvas property geometry", () => {
  it("moves a child frame in parent-relative coordinates with its descendants exactly once", () => {
    const document = new CanvasDocument([outer, frame, rectangle]);
    const initial = document.getFrames();
    const changed = changeCanvasProperty(initial, ["frame", "rectangle"], "x", 60, noMeasurement);
    assert.deepEqual(
      changed.map((node) => [node.id, node.x, node.y]),
      [
        ["frame", 160, 230],
        ["rectangle", 170, 240],
      ],
    );
    document.updateMany(changed);
    assert.equal(document.getHistoryStats().undoEntries, 1);
    assert.deepEqual(document.getFrame("outer"), outer);
    document.undo();
    assert.deepEqual(document.getFrames(), initial);
    document.redo();
    assert.equal(document.getFrame("rectangle")?.x, 170);

    const vertical = changeCanvasProperty(initial, ["frame"], "y", 80, noMeasurement);
    assert.deepEqual(
      vertical.map((node) => [node.id, node.x, node.y]),
      [
        ["frame", 120, 280],
        ["rectangle", 130, 290],
      ],
    );
  });

  it("uses world coordinates for multiple selection bounds", () => {
    const nodes = [outer, frame, rectangle, text];
    const changed = changeCanvasProperty(nodes, ["rectangle", "text"], "x", 20, noMeasurement);
    assert.deepEqual(
      changed.map((node) => [node.id, node.x]),
      [
        ["rectangle", 20],
        ["text", 590],
      ],
    );
    assert.equal(nodes[2].x, 130);
  });

  it("resizes a frame as a crop without moving or scaling children", () => {
    const document = new CanvasDocument([outer, frame, rectangle]);

    const changed = changeCanvasProperty(
      document.getFrames(),
      ["frame"],
      "width",
      90,
      noMeasurement,
    );

    assert.equal(changed.length, 1);
    assert.equal(changed[0].width, 90);
    document.updateMany(changed);
    assert.deepEqual(document.getFrame("rectangle"), rectangle);
    document.undo();
    assert.deepEqual(document.getFrame("frame"), frame);
  });

  it("preserves aspect ratio and enforces both frame minimum dimensions", () => {
    const changed = changeCanvasProperty(
      [outer, frame, rectangle],
      ["frame"],
      "width",
      300,
      noMeasurement,
      { preserveAspect: true },
    );

    assert.deepEqual(changed, [{ ...frame, width: 300, height: 150 }]);

    const minimum = changeCanvasProperty([outer, frame], ["frame"], "width", 1, noMeasurement, {
      preserveAspect: true,
    });

    assert.deepEqual(minimum, [{ ...frame, width: 80, height: 40 }]);
  });

  it("scales group contents and typography together in one document operation", () => {
    const group: CanvasFrame = {
      id: "group",
      name: "Group",
      kind: "group",
      x: 0,
      y: 0,
      width: 240,
      height: 60,
    };

    const child: CanvasText = { ...text, parentId: "group", x: 0, y: 0, height: 60 };
    const document = new CanvasDocument([group, child]);

    const changed = changeCanvasProperty(
      document.getFrames(),
      ["group"],
      "height",
      120,
      noMeasurement,
      { preserveAspect: true },
    );

    document.updateMany(changed);
    assert.equal(document.getFrame("group")?.width, 480);
    assert.deepEqual(document.getFrame("text"), {
      ...child,
      width: 480,
      height: 120,
      fontSize: 48,
    });
    assert.equal(document.getHistoryStats().undoEntries, 1);
    document.undo();
    assert.deepEqual(document.getFrames(), [group, child]);
  });
});

describe("canvas layout properties", () => {
  it("enables, adjusts and disables layout only on eligible frames", () => {
    const nodes = [outer, text];

    const enabled = changeCanvasProperty(
      nodes,
      ["outer", "text"],
      "layoutMode",
      "column",
      noMeasurement,
    );

    assert.equal(enabled.length, 1);
    const laidOut = enabled[0];
    assert.ok(!laidOut.kind || laidOut.kind === "frame");
    assert.deepEqual(laidOut.layout, {
      direction: "column",
      gap: 16,
      padding: 16,
      align: "start",
      justify: "start",
    });

    for (const [property, key, value] of [
      ["layoutGap", "gap", 24],
      ["layoutPadding", "padding", 8],
      ["layoutAlign", "align", "center"],
      ["layoutJustify", "justify", "space-between"],
    ] as const) {
      const changed: CanvasFrame = changeCanvasProperty(
        [laidOut],
        ["outer"],
        property,
        value,
        noMeasurement,
      )[0];

      assert.ok(!changed.kind || changed.kind === "frame");
      assert.equal(changed.layout?.[key], value);
    }

    assert.deepEqual(
      changeCanvasProperty([laidOut], ["outer"], "layoutMode", "none", noMeasurement),
      [outer],
    );
    assert.deepEqual(changeCanvasProperty([outer], ["outer"], "layoutGap", 12, noMeasurement), []);
  });

  it("rejects unsupported layout values and edits to locked frames", () => {
    const enabled = changeCanvasProperty([outer], ["outer"], "layoutMode", "row", noMeasurement)[0];

    for (const [property, value] of [
      ["layoutMode", "grid"],
      ["layoutGap", -1],
      ["layoutPadding", Infinity],
      ["layoutAlign", "stretch"],
      ["layoutJustify", "between"],
    ] as const) {
      assert.deepEqual(
        changeCanvasProperty([enabled], ["outer"], property, value, noMeasurement),
        [],
      );
    }

    assert.deepEqual(
      changeCanvasProperty(
        [{ ...enabled, locked: true }],
        ["outer"],
        "layoutGap",
        10,
        noMeasurement,
      ),
      [],
    );
  });
});

describe("canvas property text reflow", () => {
  it("measures the changed width and commits height together, while explicit height stays manual", () => {
    const measured: CanvasText[] = [];

    const changed = changeCanvasProperty([text], ["text"], "width", 120, (node) => {
      measured.push(node);

      return 90;
    });

    assert.equal(measured.length, 1);
    assert.equal(measured[0].width, 120);
    assert.deepEqual(changed, [{ ...text, width: 120, height: 90 }]);
    const document = new CanvasDocument([text]);
    document.updateMany(changed);
    document.undo();
    assert.deepEqual(document.getFrames(), [text]);
    assert.deepEqual(changeCanvasProperty([text], ["text"], "height", 75, noMeasurement), [
      { ...text, height: 75 },
    ]);
    assert.deepEqual(
      changeCanvasProperty([text], ["text"], "width", 480, noMeasurement, { preserveAspect: true }),
      [{ ...text, width: 480, height: 60 }],
    );
  });

  it("remeasures every wrapping-affecting typography property using the updated text style", () => {
    const cases: [CanvasProperty, string | number][] = [
      ["fontFamily", "Georgia"],
      ["fontWeight", 700],
      ["fontSize", 40],
      ["lineHeight", 2],
      ["letterSpacing", 3],
    ];

    for (const [property, value] of cases) {
      let calls = 0;

      const changed = changeCanvasProperty([text], ["text"], property, value, (node) => {
        calls++;
        assert.equal(node[property as keyof CanvasText], value);
        assert.equal(node.width, text.width);
        assert.equal(node.text, text.text);

        return 84;
      });

      assert.equal(calls, 1);
      assert.deepEqual(changed, [{ ...text, [property]: value, height: 84 }]);
    }

    assert.deepEqual(changeCanvasProperty([text], ["text"], "textAlign", "right", noMeasurement), [
      { ...text, textAlign: "right" },
    ]);
  });
});

describe("canvas property styling and guards", () => {
  const image: CanvasFrame = {
    id: "image",
    name: "Image",
    kind: "image",
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    src: "data:image/png;base64,AAAA",
  };

  const pen: CanvasFrame = {
    id: "pen",
    name: "Pen",
    kind: "pen",
    x: 0,
    y: 0,
    width: 50,
    height: 50,
    points: [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ],
    pathWidth: 50,
    pathHeight: 50,
    stroke: "#123",
    strokeWidth: 2,
  };

  const detachedRectangle: CanvasFrame = { ...rectangle, parentId: undefined };
  const nodes = [outer, detachedRectangle, text, image, pen];
  const ids = nodes.map((node) => node.id);

  it("applies shared color to supported kinds and ignores incompatible mixed styles", () => {
    assert.deepEqual(changeCanvasProperty(nodes, ids, "fill", "#ff0011", noMeasurement), [
      { ...outer, fill: "#ff0011" },
      { ...detachedRectangle, fill: "#ff0011" },
      { ...text, color: "#ff0011" },
      { ...pen, stroke: "#ff0011" },
    ]);
    assert.deepEqual(changeCanvasProperty(nodes, ids, "cornerRadius", 12, noMeasurement), [
      { ...outer, cornerRadius: 12 },
      { ...detachedRectangle, cornerRadius: 12 },
      { ...image, cornerRadius: 12 },
    ]);
    assert.deepEqual(changeCanvasProperty(nodes, ids, "strokeWidth", 4, noMeasurement), [
      { ...pen, strokeWidth: 4 },
    ]);
    assert.deepEqual(changeCanvasProperty(nodes, ids, "clipContent", false, noMeasurement), [
      { ...outer, clipContent: false },
    ]);
  });

  it("changes only text nodes for typography in a mixed selection", () => {
    const measured: string[] = [];

    const changed = changeCanvasProperty(nodes, ids, "fontSize", 32, (node) => {
      measured.push(node.id);

      return 80;
    });

    assert.deepEqual(measured, ["text"]);
    assert.deepEqual(changed, [{ ...text, fontSize: 32, height: 80 }]);
  });

  it("rejects invalid values and missing selections without text measurement or mutation", () => {
    const invalid: [CanvasProperty, string | number | boolean][] = [
      ["x", NaN],
      ["y", Infinity],
      ["width", 0],
      ["height", -1],
      ["width", "50"],
      ["opacity", -0.1],
      ["opacity", 1.1],
      ["opacity", NaN],
      ["cornerRadius", -1],
      ["fill", "red"],
      ["fill", "#fff;display:none"],
      ["fontFamily", ""],
      ["fontWeight", 1001],
      ["fontSize", 0],
      ["lineHeight", 0.4],
      ["lineHeight", 5],
      ["letterSpacing", -11],
      ["letterSpacing", 101],
      ["textAlign", "justify"],
      ["strokeWidth", 0],
      ["clipContent", "false"],
      ["hidden", 1],
      ["locked", "false"],
    ];

    for (const [property, value] of invalid) {
      assert.deepEqual(
        changeCanvasProperty(nodes, ids, property, value, noMeasurement),
        [],
        property,
      );
    }

    assert.deepEqual(changeCanvasProperty(nodes, ["missing"], "x", 20, noMeasurement), []);
    assert.equal(text.fontSize, 24);
    assert.equal(outer.width, 500);
  });

  it("blocks edits through locked ancestors, including a partially locked multi-selection", () => {
    const lockedNodes = [{ ...outer, locked: true }, frame, rectangle, text];

    for (const property of ["x", "width", "opacity", "fill"] as const) {
      const value = property === "fill" ? "#fff" : 0.5;
      assert.deepEqual(
        changeCanvasProperty(lockedNodes, ["rectangle"], property, value, noMeasurement),
        [],
      );
      assert.deepEqual(
        changeCanvasProperty(lockedNodes, ["rectangle", "text"], property, value, noMeasurement),
        [],
      );
    }

    assert.deepEqual(changeCanvasProperty(lockedNodes, ["outer"], "locked", false, noMeasurement), [
      { ...outer, locked: false },
    ]);
  });
});

describe("canvas effects and compact layout", () => {
  it("edits matching shadow stacks across mixed selections without overwriting other effects", () => {
    const outerShadow = { offsetX: 1, offsetY: 2, blur: 8, spread: -2, color: "#123456" };
    const innerShadow = { ...outerShadow, inset: true };
    const first = { ...text, shadows: [innerShadow, outerShadow] };

    const second = {
      ...text,
      id: "second",
      shadows: [outerShadow, innerShadow, { ...outerShadow, blur: 32 }],
    };

    const document = new CanvasDocument([first, second]);
    const initial = document.getFrames();

    const updates = changeCanvasProperty(
      initial,
      [text.id, second.id],
      "shadowBlur",
      20,
      noMeasurement,
      { shadowIndex: 0, shadowInset: false },
    );

    assert.ok(document.updateMany(updates));
    assert.equal(document.getFrame(text.id)?.shadows?.[0].blur, 8);
    assert.equal(document.getFrame(text.id)?.shadows?.[1].blur, 20);
    assert.equal(document.getFrame(second.id)?.shadows?.[0].blur, 20);
    assert.equal(document.getFrame(second.id)?.shadows?.[2].blur, 32);
    document.undo();
    assert.deepEqual(document.getFrames(), initial);
    document.redo();
    assert.equal(document.getFrame(text.id)?.shadows?.[1].blur, 20);

    const removed = changeCanvasProperty(
      document.getFrames(),
      [text.id, second.id],
      "shadowRemove",
      true,
      noMeasurement,
      { shadowInset: true },
    );

    assert.ok(removed.every((node) => node.shadows?.every((shadow) => !shadow.inset)));
  });

  it("validates effects, respects the shadow limit, and blocks locked ancestors", () => {
    const shadow = { offsetX: 0, offsetY: 4, blur: 12, spread: 0, color: "#00000040" };
    const node = { ...text, shadows: [shadow] };

    for (const [property, value] of [
      ["shadowBlur", -1],
      ["shadowSpread", Infinity],
      ["shadowColor", "garbage"],
      ["borderWidth", -1],
      ["borderColor", "bad"],
      ["fontStyle", "oblique"],
      ["textDecoration", "blink"],
    ] as const) {
      assert.deepEqual(changeCanvasProperty([node], [node.id], property, value, noMeasurement), []);
    }

    assert.deepEqual(
      changeCanvasProperty(
        [{ ...node, shadows: Array.from({ length: 8 }, () => ({ ...shadow })) }],
        [node.id],
        "shadowAdd",
        true,
        noMeasurement,
      ),
      [],
    );
    assert.deepEqual(
      changeCanvasProperty([node], [node.id], "shadowBlur", 10, noMeasurement, { shadowIndex: -1 }),
      [],
    );
    assert.deepEqual(
      changeCanvasProperty(
        [
          { ...outer, locked: true },
          { ...node, parentId: outer.id },
        ],
        [node.id],
        "shadowAdd",
        true,
        noMeasurement,
      ),
      [],
    );

    const added = changeCanvasProperty([node], [node.id], "shadowAdd", true, noMeasurement, {
      shadowInset: true,
    });

    assert.equal(added[0].shadows?.length, 2);
    assert.equal(added[0].shadows?.[1].inset, true);
  });

  it("keeps effect scrubs in one undo step and cancels previews cleanly", () => {
    const document = new CanvasDocument([{ ...text, borderWidth: 1, borderColor: "#abc" }]);
    const before = document.getFrames();
    document.beginGesture([text.id]);
    for (const width of [2, 8, 0])
      document.previewMany(
        changeCanvasProperty(before, [text.id], "borderWidth", width, noMeasurement),
      );
    document.endGesture();
    assert.equal(document.getHistoryStats().undoEntries, 1);
    assert.equal(document.getFrame(text.id)?.borderWidth, 0);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    document.beginGesture([text.id]);
    document.previewMany(
      changeCanvasProperty(before, [text.id], "borderColor", "#fff", noMeasurement),
    );
    document.endGesture(true);
    assert.deepEqual(document.getFrames(), before);
    const removed = changeCanvasProperty(before, [text.id], "borderRemove", true, noMeasurement)[0];
    assert.equal(removed.borderWidth, undefined);
    assert.equal(removed.borderColor, undefined);
  });

  it("maps visual alignment for each direction and undoes child reflow atomically", () => {
    const layout = {
      direction: "row",
      gap: 8,
      padding: 12,
      align: "start",
      justify: "start",
    } as const;

    const document = new CanvasDocument([
      { ...outer, layout },
      { ...rectangle, parentId: outer.id },
    ]);

    const before = document.getFrames();
    document.updateMany(
      changeCanvasProperty(before, [outer.id], "layoutPosition", "end:center", noMeasurement),
    );
    assert.deepEqual((document.getFrame(outer.id) as CanvasFrameNode).layout, {
      ...layout,
      align: "center",
      justify: "end",
    });
    assert.equal(document.getFrame(rectangle.id)?.x, outer.x + outer.width - 12 - rectangle.width);
    document.undo();
    assert.deepEqual(document.getFrames(), before);
    const column = { ...outer, layout: { ...layout, direction: "column" as const } };

    const changed = changeCanvasProperty(
      [column],
      [outer.id],
      "layoutPosition",
      "end:center",
      noMeasurement,
    )[0];

    assert.deepEqual((changed as CanvasFrameNode).layout, {
      ...column.layout,
      align: "end",
      justify: "center",
    });
    assert.deepEqual(
      changeCanvasProperty([column], [outer.id], "layoutPosition", "bad:end", noMeasurement),
      [],
    );
  });

  it("remeasures italic text and applies decoration without changing geometry", () => {
    const changed = changeCanvasProperty([text], [text.id], "fontStyle", "italic", (node) => {
      assert.equal(node.fontStyle, "italic");

      return 76;
    })[0] as CanvasText;

    assert.equal(changed.height, 76);

    const decorated = changeCanvasProperty(
      [changed],
      [text.id],
      "textDecoration",
      "underline",
      noMeasurement,
    )[0] as CanvasText;

    assert.equal(decorated.textDecoration, "underline");
    assert.equal(decorated.height, 76);
  });
});
