import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseCanvasProject, projectFilename, serializeCanvasProject } from "./canvas-project";

describe("portable projects", () => {
  it("round trips a named nested project with text, appearance, and embedded images", () => {
    const nodes = [
      {
        id: "frame",
        name: "Frame",
        x: -50,
        y: 20,
        width: 400,
        height: 300,
        fill: "#fff",
        cornerRadius: 16,
      },
      {
        id: "text",
        name: "Heading",
        parentId: "frame",
        kind: "text" as const,
        x: -20,
        y: 40,
        width: 100,
        height: 40,
        text: "Hello <world>",
        fontSize: 24,
        color: "#ff0055",
        fontWeight: 700 as const,
        opacity: 0.5,
      },
    ];
    assert.deepEqual(parseCanvasProject(serializeCanvasProject("My project", nodes)), {
      name: "My project",
      nodes,
    });
  });
  it("supports an intentionally empty project", () => {
    assert.deepEqual(parseCanvasProject(serializeCanvasProject("", [])), {
      name: "Untitled",
      nodes: [],
    });
  });
  it("rejects malformed, future, invalid, and cyclic documents without partial imports", () => {
    const node = { id: "a", name: "A", x: 0, y: 0, width: 100, height: 100 };
    for (const source of [
      "oops",
      "[]",
      JSON.stringify({ type: "lra-design", version: 2, name: "Future", nodes: [] }),
      serializeCanvasProject("Bad", [{ ...node, width: -1 }]),
      serializeCanvasProject("Duplicate", [node, node]),
      serializeCanvasProject("Cycle", [{ ...node, parentId: "a" }]),
    ])
      assert.throws(() => parseCanvasProject(source));
  });
  it("uses safe portable filenames", () => {
    assert.equal(projectFilename("App/Design: 1"), "App-Design- 1.lra");
    assert.equal(projectFilename("   ", "png"), "Untitled.png");
  });
});
