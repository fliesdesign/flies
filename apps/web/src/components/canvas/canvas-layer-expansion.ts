import type { CanvasDocument } from "@flies/canvas";

export type LayerExpansion = {
  selectedIds: readonly string[];
  expanded: ReadonlySet<string>;
};

/** Reveal only a newly selected layer's ancestors; opening the layer itself is explicit. */
export function revealLayerSelection(
  document: CanvasDocument,
  selectedIds: readonly string[],
  previous?: LayerExpansion,
): LayerExpansion {
  const expanded = new Set(previous?.expanded);
  const selected = new Set(previous?.selectedIds);

  for (const id of selectedIds) {
    if (selected.has(id)) continue;
    let parentId = document.getFrame(id)?.parentId;

    while (parentId) {
      expanded.add(parentId);
      parentId = document.getFrame(parentId)?.parentId;
    }
  }

  return { selectedIds: [...selectedIds], expanded };
}
