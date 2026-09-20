import { memo, useId, useMemo } from "react";

import type { FilePreviewNode } from "@/lib/files";

import { previewBounds, previewTree, previewViewBox, readPreviewNodes } from "./file-preview-model";

function clipName(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function PreviewShape({
  node,
  nested,
  clipPrefix,
}: {
  node: FilePreviewNode;
  nested: ReadonlyMap<string, FilePreviewNode[]>;
  clipPrefix: string;
}) {
  const kind = node.kind ?? "frame";
  const kids = nested.get(node.id) ?? [];
  const radius = Math.min(node.cornerRadius ?? 0, Math.min(node.width, node.height) / 2);

  const clips =
    (kind === "frame" || kind === "text") &&
    node.clipContent !== false &&
    (kind === "text" || kids.length > 0);

  const clipId = clips ? clipName(clipPrefix, node.id) : undefined;

  const fill =
    kind === "group"
      ? undefined
      : (node.fill ??
        (kind === "frame"
          ? "#ffffff"
          : kind === "image" || kind === "svg"
            ? "#2a2a2a"
            : undefined));

  const line = node.text?.split("\n")[0] ?? "";
  const fontSize = node.fontSize ?? 12;

  const textX =
    node.textAlign === "center"
      ? node.x + node.width / 2
      : node.textAlign === "right"
        ? node.x + node.width
        : node.x;

  const shape =
    kind === "text" ? (
      line ? (
        <text
          x={textX}
          y={node.y}
          fill={node.color ?? "#111111"}
          fontSize={fontSize}
          fontWeight={node.fontWeight ?? 400}
          fontFamily={node.fontFamily ?? "Arial, Helvetica, sans-serif"}
          fontStyle={node.fontStyle === "italic" ? "italic" : undefined}
          textAnchor={
            node.textAlign === "center" ? "middle" : node.textAlign === "right" ? "end" : "start"
          }
          dominantBaseline="hanging"
        >
          {line}
        </text>
      ) : null
    ) : fill ? (
      <rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={radius}
        ry={radius}
        fill={fill}
      />
    ) : null;

  return (
    <g opacity={node.opacity ?? 1}>
      {clipId ? (
        <clipPath id={clipId}>
          <rect
            x={node.x}
            y={node.y}
            width={node.width}
            height={node.height}
            rx={radius}
            ry={radius}
          />
        </clipPath>
      ) : null}
      <g clipPath={clipId ? `url(#${clipId})` : undefined}>
        {shape}
        {kids.map((child) => (
          <PreviewShape key={child.id} node={child} nested={nested} clipPrefix={clipPrefix} />
        ))}
      </g>
    </g>
  );
}

export const FilePreview = memo(function FilePreview({ nodes }: { nodes: unknown }) {
  const reactId = useId().replace(/:/g, "");

  const scene = useMemo(() => {
    const parsed = readPreviewNodes(nodes);
    const bounds = previewBounds(parsed);
    if (!bounds) return null;

    return { ...previewTree(parsed), viewBox: previewViewBox(bounds) };
  }, [nodes]);

  if (!scene) {
    return (
      <div className="library-preview library-preview-empty" aria-hidden="true">
        <span />
      </div>
    );
  }

  const box = `${scene.viewBox.x} ${scene.viewBox.y} ${scene.viewBox.width} ${scene.viewBox.height}`;

  return (
    <div className="library-preview" aria-hidden="true">
      <svg viewBox={box} focusable="false">
        {scene.roots.map((node) => (
          <PreviewShape key={node.id} node={node} nested={scene.nested} clipPrefix={reactId} />
        ))}
      </svg>
    </div>
  );
});
