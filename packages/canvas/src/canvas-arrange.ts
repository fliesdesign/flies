import type { CanvasFrame } from "./canvas-document";
import type { Point } from "./canvas-geometry";
import { selectionBounds, selectionRoots } from "./canvas-operations";
import { frameSource, worldBounds, moveSelectionWorld, hasRotation } from "./canvas-transform";

export type CanvasArrangeAction =
  | "left"
  | "center"
  | "right"
  | "top"
  | "middle"
  | "bottom"
  | "horizontal"
  | "vertical";

/** Align selected roots; distribute equal gaps with the outermost objects fixed. */
export function arrangeSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  action: CanvasArrangeAction,
): CanvasFrame[] {
  const source = frameSource(nodes);
  const rootIds = selectionRoots(nodes, ids);

  if (rootIds.some((id) => hasRotation(source, source.getFrame(id)!))) {
    const worldNodes = rootIds.map((id) => ({
      ...source.getFrame(id)!,
      ...worldBounds(source, source.getFrame(id)!),
      parentId: undefined,
      rotation: undefined,
    }));

    const aligned = arrangeSelection(worldNodes, rootIds, action);

    return aligned.flatMap((next) => {
      const before = worldNodes.find((node) => node.id === next.id)!;

      return moveSelectionWorld(nodes, [next.id], { x: next.x - before.x, y: next.y - before.y });
    });
  }

  const roots = new Set(rootIds);
  const selected = nodes.filter((node) => roots.has(node.id));
  if (selected.length < 2) return [];
  const bounds = selectionBounds(selected, [...roots])!;
  const offsets = new Map<string, Point>();

  if (action === "horizontal" || action === "vertical") {
    if (selected.length < 3) return [];
    const horizontal = action === "horizontal";
    const axis = horizontal ? "x" : "y";
    const dimension = horizontal ? "width" : "height";
    selected.sort((first, second) => first[axis] - second[axis]);

    const gap =
      (selected[selected.length - 1][axis] -
        selected[0][axis] -
        selected.slice(0, -1).reduce((sum, node) => sum + node[dimension], 0)) /
      (selected.length - 1);

    let next = selected[0][axis];

    for (const node of selected) {
      offsets.set(node.id, horizontal ? { x: next - node.x, y: 0 } : { x: 0, y: next - node.y });
      next += node[dimension] + gap;
    }
  } else {
    for (const node of selected) {
      let x = 0;
      let y = 0;

      switch (action) {
        case "left":
          x = bounds.x - node.x;
          break;
        case "center":
          x = bounds.x + (bounds.width - node.width) / 2 - node.x;
          break;
        case "right":
          x = bounds.x + bounds.width - node.width - node.x;
          break;
        case "top":
          y = bounds.y - node.y;
          break;
        case "middle":
          y = bounds.y + (bounds.height - node.height) / 2 - node.y;
          break;
        case "bottom":
          y = bounds.y + bounds.height - node.height - node.y;
          break;
      }

      offsets.set(node.id, { x, y });
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inherited = new Map<string, Point | null>();
  const updates: CanvasFrame[] = [];

  for (const node of nodes) {
    let current: CanvasFrame | undefined = node;
    let offset: Point | null = null;
    const path = new Set<string>();

    while (current && !path.has(current.id)) {
      if (offsets.has(current.id)) {
        offset = offsets.get(current.id)!;
        break;
      }

      if (inherited.has(current.id)) {
        offset = inherited.get(current.id)!;
        break;
      }

      path.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    for (const id of path) inherited.set(id, offset);

    if (offset && (offset.x || offset.y)) {
      updates.push({ ...node, x: node.x + offset.x, y: node.y + offset.y });
    }
  }

  return updates;
}
