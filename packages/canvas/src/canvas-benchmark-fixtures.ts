import type { CanvasFrame } from "./canvas-document";

/** A repeatable scene, including frames above and to the left of the origin. */
export function createBenchmarkFrames(count: number): CanvasFrame[] {
  const length = Math.max(0, Math.floor(count));
  const columns = Math.ceil(Math.sqrt(length));

  return Array.from({ length }, (_, index) => ({
    id: `bench-${index}`,
    name: `Frame ${index + 1}`,
    x: ((index % columns) - 2) * 480,
    y: (Math.floor(index / columns) - 1) * 360,
    width: 400,
    height: 280,
  }));
}

// A small, embedded raster thumbnail exercises the real image-node decoder and renderer.
const THUMBNAIL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAYAAAAMJL+VAAAATklEQVR42mO48+zef1pihkFvwfs9jRh41IJhZgHBVFS3oPs/sTi4Lp9kzEBLw4m2gFzDibKAEsMJWkCp4XgtoIbhOC2gluFYLaCm4SAMAJVndAVQpoTkAAAAAElFTkSuQmCC";

/** Exact node counts: each board contains real editable nodes, including nested layout frames. */
export function createMixedBenchmarkNodes(count: number): CanvasFrame[] {
  const length = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  const boards = Math.ceil(length / 10);
  const columns = Math.ceil(Math.sqrt(boards));
  const nodes: CanvasFrame[] = [];

  for (let index = 0; index < boards; index++) {
    const x = (index % columns) * 440;
    const y = Math.floor(index / columns) * 360;
    const id = `mixed-${index}`;

    const base = (
      suffix: string,
      name: string,
      dx: number,
      dy: number,
      width: number,
      height: number,
    ) => ({
      id: `${id}-${suffix}`,
      name,
      parentId: `${id}-frame`,
      x: x + dx,
      y: y + dy,
      width,
      height,
    });

    nodes.push(
      {
        id: `${id}-frame`,
        name: `Board ${index + 1}`,
        kind: "frame",
        x,
        y,
        width: 360,
        height: 292,
        fill: index % 3 === 0 ? "#F3F7F2" : "#FFFFFF",
        cornerRadius: 12,
      },
      {
        ...base("title", "Title", 24, 24, 216, 28),
        kind: "text",
        text: `Project ${index + 1}`,
        fontSize: 20,
        fontWeight: 700,
        fontFamily: "Arial",
        lineHeight: 1.25,
        letterSpacing: -0.2,
        color: "#253D31",
      },
      {
        ...base("image", "Thumbnail", 24, 66, 96, 80),
        kind: "image",
        src: THUMBNAIL,
        cornerRadius: 8,
      },
      { ...base("group", "Details", 140, 66, 196, 80), kind: "group" },
      {
        ...base("description", "Description", 140, 66, 196, 40),
        parentId: `${id}-group`,
        kind: "text",
        text: "A little room to explore.\nIdeas for the next release.",
        fontSize: 14,
        lineHeight: 1.4,
        color: "#526359",
      },
      {
        ...base("badge", "Status", 140, 118, 84, 28),
        parentId: `${id}-group`,
        kind: "rectangle",
        fill: "#BFD7C9",
        cornerRadius: 6,
        opacity: 0.85,
      },
      {
        ...base("layout", "Cards", 24, 164, 312, 104),
        kind: "frame",
        fill: "#E4ECE4",
        cornerRadius: 8,
        ...(index % 2 === 0 && {
          layout: {
            direction: "row" as const,
            gap: 12,
            padding: 12,
            align: "center" as const,
            justify: "space-between" as const,
          },
        }),
      },
      {
        ...base("tile", "Color tile", 36, 180, 64, 72),
        parentId: `${id}-layout`,
        kind: "rectangle",
        fill: "#759084",
        cornerRadius: 6,
      },
      {
        ...base("caption", "Caption", 176, 184, 148, 64),
        parentId: `${id}-layout`,
        kind: "text",
        text: "Design\nPrototype\nReview",
        fontSize: 14,
        lineHeight: 1.5,
        fontWeight: 500,
        color: "#365343",
      },
      {
        ...base("pen", "Stroke", 260, 24, 76, 28),
        kind: "pen",
        points: [
          { x: 2, y: 20 },
          { x: 22, y: 4 },
          { x: 48, y: 24 },
          { x: 74, y: 8 },
        ],
        stroke: "#60876F",
        strokeWidth: 3,
        pathWidth: 76,
        pathHeight: 28,
      },
    );
  }

  return nodes.slice(0, length);
}
