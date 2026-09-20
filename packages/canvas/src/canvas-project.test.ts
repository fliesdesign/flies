import assert from "node:assert/strict";

import { gzipSync } from "fflate";
import { describe, it } from "vite-plus/test";

import {
  packCanvasProject,
  parseCanvasProject,
  projectFilename,
  serializeCanvasProject,
  unpackCanvasProject,
} from "./canvas-project";

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";

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
      theme: { tokens: [] },
    });
  });
  it("supports an intentionally empty project", () => {
    assert.deepEqual(parseCanvasProject(serializeCanvasProject("", [])), {
      name: "Untitled",
      nodes: [],
      theme: { tokens: [] },
    });
  });
  it("still opens legacy lra-design JSON", () => {
    const project = parseCanvasProject(
      JSON.stringify({ type: "lra-design", version: 1, name: "Legacy", nodes: [] }),
    );
    assert.deepEqual(project, { name: "Legacy", nodes: [], theme: { tokens: [] } });
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
    assert.equal(projectFilename("App/Design: 1"), "App-Design- 1.zip");
    assert.equal(projectFilename("   ", "png"), "Untitled.png");
    assert.equal(projectFilename("Board", "json"), "Board.json");
  });
  it("packs images as zip files and restores data URLs on open", () => {
    const nodes = [
      {
        id: "img",
        name: "Photo",
        kind: "image" as const,
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        src: `data:image/png;base64,${png}`,
      },
    ];
    const packed = packCanvasProject("Pics", nodes);
    assert.equal(packed[0], 0x50);
    assert.equal(packed[1], 0x4b);
    assert.deepEqual(unpackCanvasProject(packed), { name: "Pics", nodes, theme: { tokens: [] } });
  });
  it("opens gzip JSON and plain JSON bytes", () => {
    const json = serializeCanvasProject("Gzipped", []);
    assert.deepEqual(unpackCanvasProject(gzipSync(new TextEncoder().encode(json))), {
      name: "Gzipped",
      nodes: [],
      theme: { tokens: [] },
    });
    assert.deepEqual(unpackCanvasProject(new TextEncoder().encode(json)), {
      name: "Gzipped",
      nodes: [],
      theme: { tokens: [] },
    });
  });
});
