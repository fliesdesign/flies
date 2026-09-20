import {
  normalizeTheme,
  applyTokenBindings,
  ensureCanvasFonts,
  type CanvasDocument,
  type CanvasTheme,
  type CanvasFrame,
} from "@flies/canvas";

import { measureCanvasTextHeight } from "@/components/canvas/canvas-node-content";
export async function updateDocumentTheme(document: CanvasDocument, value: CanvasTheme) {
  const theme = normalizeTheme(value);
  const before = document.getTheme();
  const text = document.getFrames().flatMap((node) => {
    const updated = applyTokenBindings(node, theme);
    return updated.kind === "text" &&
      node.kind === "text" &&
      (updated.fontFamily !== node.fontFamily ||
        updated.fontSize !== node.fontSize ||
        updated.letterSpacing !== node.letterSpacing ||
        updated.fontWeight !== node.fontWeight ||
        updated.lineHeight !== node.lineHeight)
      ? [updated]
      : [];
  });
  if (text.length) await ensureCanvasFonts(text);
  if (document.getTheme() !== before)
    throw new Error("Theme changed while loading fonts. Try again.");
  document.setTheme(theme, measureCanvasTextHeight);
}

/** Load and remeasure text only when a binding changes its typography. */
export async function prepareTokenUpdates(
  updates: CanvasFrame[],
  originals: readonly CanvasFrame[],
) {
  const changed = updates.filter((node, index) => {
    const before = originals[index];
    return (
      node.kind === "text" &&
      before.kind === "text" &&
      (node.fontFamily !== before.fontFamily ||
        node.fontSize !== before.fontSize ||
        node.letterSpacing !== before.letterSpacing ||
        node.fontWeight !== before.fontWeight ||
        node.lineHeight !== before.lineHeight)
    );
  });
  await ensureCanvasFonts(changed.filter((node) => node.kind === "text"));
  for (let index = 0; index < updates.length; index++) {
    const node = updates[index];
    if (node.kind === "text" && changed.includes(node))
      updates[index] = { ...node, height: measureCanvasTextHeight(node) };
  }
}
