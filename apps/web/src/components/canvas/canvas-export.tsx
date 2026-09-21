import { gradientCss, filterCss, detachCanvasSelection, exportBounds } from "@flies/canvas";
import { CanvasDocument, ensureCanvasFonts, type CanvasFrame } from "@flies/canvas";
import { selectionBounds } from "@flies/canvas";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { CanvasNodeAppearance, CanvasNodeContent } from "./canvas-node-content";

function ExportNode({
  node,
  document,
  origin,
}: {
  node: CanvasFrame;
  document: CanvasDocument;
  origin: { x: number; y: number };
}) {
  if (node.hidden) return null;
  const frame = !node.kind || node.kind === "frame";

  return (
    <div
      style={{
        position: "absolute",
        left: node.x - origin.x,
        top: node.y - origin.y,
        width: node.width,
        height: node.height,
        opacity: node.opacity ?? 1,
        isolation: "isolate",
        transform: `rotate(${node.rotation ?? 0}deg)`,
        mixBlendMode: node.blendMode,
        filter: filterCss(node.filters),
      }}
    >
      {frame ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: node.gradient ? gradientCss(node.gradient) : (node.fill ?? "#fff"),
            borderRadius: node.cornerRadius ?? 0,
          }}
        />
      ) : (
        <CanvasNodeContent frame={node} />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: frame && node.clipContent !== false ? "hidden" : "visible",
          borderRadius: frame && node.clipContent !== false ? (node.cornerRadius ?? 0) : 0,
        }}
      >
        {document.getChildren(node.id).map((id) => (
          <ExportNode key={id} node={document.getFrame(id)!} document={document} origin={node} />
        ))}
      </div>
      <CanvasNodeAppearance frame={node} />
    </div>
  );
}

export function CanvasExportScene({
  document,
  ids,
}: {
  document: CanvasDocument;
  ids: readonly string[];
}) {
  const detached = new CanvasDocument(detachCanvasSelection(document.getFrames(), ids));
  const nodes = ids.map((id) => detached.getFrame(id)!).filter(Boolean);

  const bounds = selectionBounds(
    nodes.map((node) => ({ ...node, ...exportBounds(detached, node), parentId: undefined })),
    ids,
  );

  if (!bounds) return null;

  return (
    <div
      style={{
        position: "relative",
        width: Math.ceil(bounds.width),
        height: Math.ceil(bounds.height),
        overflow: "hidden",
        background: "transparent",
        margin: 0,
        padding: 0,
      }}
    >
      {nodes.map((node) => (
        <ExportNode key={node.id} node={node} document={detached} origin={bounds} />
      ))}
    </div>
  );
}

/** Render every descendant, including offscreen ones, without editor overlays or camera transforms. */
export async function exportCanvasPng(
  nodes: readonly CanvasFrame[],
  selectedIds: readonly string[],
): Promise<Blob> {
  const snapshot = new CanvasDocument(nodes);
  const roots = snapshot.getRootIds(selectedIds).filter((id) => !snapshot.isHidden(id));
  const exportedIds = new Set(snapshot.getDescendantIds(roots));
  await ensureCanvasFonts(
    nodes.filter((node) => node.kind === "text").filter((node) => exportedIds.has(node.id)),
  );

  const bounds = selectionBounds(
    roots.map((id) => ({
      ...snapshot.getFrame(id)!,
      ...exportBounds(snapshot, snapshot.getFrame(id)!),
      parentId: undefined,
    })),
    roots,
  );

  if (!bounds) throw new Error("Select a visible frame or layer to export.");
  const width = Math.ceil(bounds.width);
  const height = Math.ceil(bounds.height);
  if (width > 8192 || height > 8192 || width * height > 32_000_000)
    throw new Error(
      "This selection is too large for PNG export. Export a smaller frame (up to 8192 pixels per side and 32 million pixels).",
    );
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    pointerEvents: "none",
    width: `${width}px`,
    height: `${height}px`,
  });
  document.body.append(host);
  const root = createRoot(host);

  try {
    flushSync(() => root.render(<CanvasExportScene document={snapshot} ids={roots} />));
    await document.fonts.ready;
    await Promise.all(Array.from(host.querySelectorAll("img"), (image) => image.decode()));
    const { toBlob } = await import("html-to-image");

    const blob = await toBlob(host.firstElementChild as HTMLElement, {
      width,
      height,
      pixelRatio: 1,
      skipFonts: false,
      cacheBust: false,
    });

    if (!blob) throw new Error("PNG export could not finish. Try a smaller selection.");

    return blob;
  } finally {
    root.unmount();
    host.remove();
  }
}
