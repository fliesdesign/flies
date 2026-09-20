import type { CanvasFrame } from "./canvas-document";
import { reparentSelection, selectionDescendants } from "./canvas-operations";

/**
 * Layout may constrain previews to a slot. Determine the drop parent from the
 * requested world geometry, then carry that geometry only for reparented roots.
 */
export function finalizeCanvasMove(
  current: readonly CanvasFrame[],
  roots: readonly string[],
  requested: readonly CanvasFrame[],
): CanvasFrame[] {
  const requestedById = new Map(requested.map((node) => [node.id, node]));
  const proposed = current.map((node) => requestedById.get(node.id) ?? node);
  const parents = reparentSelection(proposed, roots);
  if (!parents.length) return [];
  const parentsById = new Map(parents.map((node) => [node.id, node]));

  return selectionDescendants(
    proposed,
    parents.map((node) => node.id),
  ).map((node) => parentsById.get(node.id) ?? node);
}
