import { loadCanvasFrames, type CanvasFrame } from "./canvas-document";
import type { FrameRect, Point } from "./canvas-geometry";

export const CANVAS_CLIPBOARD_MIME = "application/x-flies-canvas+json";
export const LEGACY_CANVAS_CLIPBOARD_MIME = "application/x-lra-canvas+json";
const CANVAS_CLIPBOARD_TYPE = "flies-canvas";
const LEGACY_CANVAS_CLIPBOARD_TYPE = "lra-canvas";

export function readCanvasClipboardMime(getData: (type: string) => string): string {
  return getData(CANVAS_CLIPBOARD_MIME) || getData(LEGACY_CANVAS_CLIPBOARD_MIME);
}

export type CanvasOperationPlan = {
  upsert: CanvasFrame[];
  remove: string[];
  selection: string[];
};

function nodeMap(nodes: readonly CanvasFrame[]) {
  return new Map(nodes.map((node) => [node.id, node]));
}

function ancestors(node: CanvasFrame, byId: ReadonlyMap<string, CanvasFrame>): string[] {
  const result: string[] = [];
  const visited = new Set([node.id]);
  let parent = node.parentId;
  while (parent && !visited.has(parent) && byId.has(parent)) {
    result.push(parent);
    visited.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return result;
}

/** Selecting a container and its child must never transform the child twice. */
export function selectionRoots(nodes: readonly CanvasFrame[], ids: readonly string[]): string[] {
  const byId = nodeMap(nodes);
  const selected = new Set(ids);
  return nodes
    .filter(
      (node) => selected.has(node.id) && !ancestors(node, byId).some((id) => selected.has(id)),
    )
    .map((node) => node.id);
}

/** Document order is preserved so copied subtrees keep their stacking order. */
export function selectionDescendants(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
): CanvasFrame[] {
  const byId = nodeMap(nodes);
  const selected = new Set(ids);
  return nodes.filter(
    (node) => selected.has(node.id) || ancestors(node, byId).some((id) => selected.has(id)),
  );
}

export function selectionBounds(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
): FrameRect | null {
  const roots = new Set(selectionRoots(nodes, ids));
  const selected = nodes.filter((node) => roots.has(node.id));
  if (!selected.length) return null;
  let x = Infinity;
  let y = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of selected) {
    x = Math.min(x, node.x);
    y = Math.min(y, node.y);
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

export function moveSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  delta: Point,
): CanvasFrame[] {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return [];
  const moved: CanvasFrame[] = [];
  for (const node of selectionDescendants(nodes, ids)) {
    moved.push({ ...node, x: node.x + delta.x, y: node.y + delta.y });
  }
  return moved;
}

/** Frame edges crop/reveal children; groups and multiple selections scale their contents. */
export function resizeSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  start: FrameRect,
  next: FrameRect,
): CanvasFrame[] {
  if (
    ![start.x, start.y, start.width, start.height].every(Number.isFinite) ||
    ![next.x, next.y, next.width, next.height].every(Number.isFinite) ||
    start.width <= 0 ||
    start.height <= 0 ||
    next.width <= 0 ||
    next.height <= 0
  )
    return [];
  const roots = selectionRoots(nodes, ids);
  const single = roots.length === 1 ? nodes.find((node) => node.id === roots[0]) : undefined;
  if (single && (single.kind === undefined || single.kind === "frame")) {
    return [
      { ...single, ...next, width: Math.max(40, next.width), height: Math.max(40, next.height) },
    ];
  }
  const scaleX = next.width / start.width;
  const scaleY = next.height / start.height;
  const scaleContents = roots.length > 1 || single?.kind === "group";
  const updates: CanvasFrame[] = [];
  for (const node of selectionDescendants(nodes, roots)) {
    const minimum = node.kind === undefined || node.kind === "frame" ? 40 : 1;
    const resized = {
      ...node,
      x: next.x + (node.x - start.x) * scaleX,
      y: next.y + (node.y - start.y) * scaleY,
      width: Math.max(minimum, node.width * scaleX),
      height: Math.max(minimum, node.height * scaleY),
    };
    // A text box resized directly reflows; scaling a group scales its typography as well.
    updates.push(
      scaleContents && resized.kind === "text"
        ? { ...resized, fontSize: resized.fontSize * Math.min(scaleX, scaleY) }
        : resized,
    );
  }
  return updates;
}

function containsPoint(rect: FrameRect, point: Point) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

function containsRect(outer: FrameRect, inner: FrameRect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function withParent(node: CanvasFrame, parentId: string | undefined): CanvasFrame {
  const { parentId: _oldParent, ...rest } = node;
  return parentId ? { ...rest, parentId } : rest;
}

/** Visible bounds account for every clipping ancestor, while groups never clip. */
function visibleBounds(
  node: CanvasFrame,
  byId: ReadonlyMap<string, CanvasFrame>,
): FrameRect | null {
  if (node.hidden || ancestors(node, byId).some((id) => byId.get(id)?.hidden)) return null;
  let x = node.x;
  let y = node.y;
  let right = node.x + node.width;
  let bottom = node.y + node.height;
  for (const id of ancestors(node, byId)) {
    const parent = byId.get(id)!;
    if ((parent.kind === undefined || parent.kind === "frame") && parent.clipContent !== false) {
      x = Math.max(x, parent.x);
      y = Math.max(y, parent.y);
      right = Math.min(right, parent.x + parent.width);
      bottom = Math.min(bottom, parent.y + parent.height);
      if (right <= x || bottom <= y) return null;
    }
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Enclose visible bounds; hidden overflow and locked container contents cannot be selected. */
export function marqueeSelection(nodes: readonly CanvasFrame[], rect: FrameRect): string[] {
  const byId = nodeMap(nodes);
  const hits: string[] = [];
  for (const node of nodes) {
    if (node.locked || ancestors(node, byId).some((id) => byId.get(id)!.locked)) continue;
    const visible = visibleBounds(node, byId);
    if (visible && containsRect(rect, visible)) hits.push(node.id);
  }
  return selectionRoots(nodes, hits);
}

function paintsAbove(path: readonly number[], previous: readonly number[]) {
  for (let i = 0; i < Math.min(path.length, previous.length); i++) {
    if (path[i] !== previous[i]) return path[i] > previous[i];
  }
  return path.length > previous.length;
}

/** Drop roots into the deepest visible frame under their center, with frontmost ties. */
export function reparentSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  options: { requireContainment?: boolean } = {},
): CanvasFrame[] {
  const byId = nodeMap(nodes);
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const roots = new Set(selectionRoots(nodes, ids));
  const excluded = new Set(selectionDescendants(nodes, ids).map((node) => node.id));
  const candidates = nodes
    .filter(
      (node) =>
        (node.kind === undefined || node.kind === "frame") &&
        !excluded.has(node.id) &&
        !node.locked &&
        !node.hidden,
    )
    .map((node) => {
      const parents = ancestors(node, byId);
      const path: number[] = [];
      for (let index = parents.length - 1; index >= 0; index--)
        path.push(order.get(parents[index])!);
      path.push(order.get(node.id)!);
      return { node, parents, path };
    });
  const updates: CanvasFrame[] = [];
  for (const node of nodes) {
    if (!roots.has(node.id)) continue;
    // Groups express explicit membership; their bounds grow when an edited child moves.
    if (node.parentId && byId.get(node.parentId)?.kind === "group") continue;
    const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    let parent: CanvasFrame | undefined;
    let path: readonly number[] = [];
    for (const candidate of candidates) {
      if (
        !(options.requireContainment
          ? containsRect(candidate.node, node)
          : containsPoint(candidate.node, center)) ||
        candidate.parents.some((id) => {
          const ancestor = byId.get(id)!;
          return (
            ancestor.locked ||
            ancestor.hidden ||
            ((ancestor.kind === undefined || ancestor.kind === "frame") &&
              ancestor.clipContent !== false &&
              !containsPoint(ancestor, center))
          );
        })
      )
        continue;
      if (!parent || paintsAbove(candidate.path, path)) {
        parent = candidate.node;
        path = candidate.path;
      }
    }
    if (node.parentId !== parent?.id) updates.push(withParent(node, parent?.id));
  }
  return updates;
}

/** Drawing a frame around siblings wraps them without changing any world coordinates. */
export function adoptFrameContents(nodes: readonly CanvasFrame[], frameId: string): CanvasFrame[] {
  const frame = nodes.find((node) => node.id === frameId);
  if (!frame || (frame.kind !== undefined && frame.kind !== "frame")) return [];
  return nodes
    .filter(
      (node) =>
        node.id !== frame.id &&
        node.parentId === frame.parentId &&
        !node.locked &&
        !node.hidden &&
        containsRect(frame, node),
    )
    .map((node) => withParent(node, frameId));
}

export function groupSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  group: { id: string; name?: string },
): CanvasOperationPlan | null {
  const roots = selectionRoots(nodes, ids);
  if (roots.length === 0 || nodes.some((node) => node.id === group.id)) return null;
  const byId = nodeMap(nodes);
  const rootNodes = roots.map((id) => byId.get(id)!);
  const firstParents = ancestors(rootNodes[0], byId);
  const parentId = firstParents.find((id) =>
    rootNodes.every((node) => ancestors(node, byId).includes(id)),
  );
  const bounds = selectionBounds(nodes, roots)!;
  const container: CanvasFrame = {
    id: group.id,
    name: group.name ?? "Group",
    kind: "group",
    ...bounds,
    ...(parentId ? { parentId } : {}),
  };
  return {
    upsert: [container, ...rootNodes.map((node) => withParent(node, container.id))],
    remove: [],
    selection: [container.id],
  };
}

export function ungroupSelection(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
): CanvasOperationPlan {
  const roots = new Set(selectionRoots(nodes, ids));
  const groups = nodes.filter((node) => roots.has(node.id) && node.kind === "group");
  const groupById = nodeMap(groups);
  const children = nodes.filter((node) => node.parentId && groupById.has(node.parentId));
  return {
    upsert: children.map((node) => withParent(node, groupById.get(node.parentId!)?.parentId)),
    remove: groups.map((node) => node.id),
    selection: [
      ...nodes.filter((node) => roots.has(node.id) && node.kind !== "group").map((node) => node.id),
      ...children.map((node) => node.id),
    ],
  };
}

export function encodeCanvasClipboard(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
): string | null {
  const selected = selectionDescendants(nodes, ids);
  if (!selected.length) return null;
  const included = new Set(selected.map((node) => node.id));
  return JSON.stringify({
    type: CANVAS_CLIPBOARD_TYPE,
    version: 1,
    nodes: selected.map((node) =>
      withParent(node, node.parentId && included.has(node.parentId) ? node.parentId : undefined),
    ),
  });
}

/** Never treat arbitrary JSON or malformed node data as a canvas clipboard payload. */
export function decodeCanvasClipboard(text: string): CanvasFrame[] | null {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !value ||
      typeof value !== "object" ||
      !("type" in value) ||
      (value.type !== CANVAS_CLIPBOARD_TYPE && value.type !== LEGACY_CANVAS_CLIPBOARD_TYPE) ||
      !("version" in value) ||
      value.version !== 1 ||
      !("nodes" in value) ||
      !Array.isArray(value.nodes) ||
      !value.nodes.length
    )
      return null;
    const serialized = JSON.stringify(value.nodes);
    const nodes = loadCanvasFrames({ getItem: () => serialized });
    return nodes.length === value.nodes.length ? nodes : null;
  } catch {
    return null;
  }
}

/** Copy subtrees as a unit, remapping only internal parents and detaching copied roots. */
export function pasteCanvasClipboard(
  payload: readonly CanvasFrame[],
  offset: Point,
  idFactory: () => string = () => crypto.randomUUID(),
): { nodes: CanvasFrame[]; selection: string[] } {
  const replacements = new Map<string, string>();
  const generated = new Set<string>();
  for (const node of payload) {
    const id = idFactory();
    if (!id || generated.has(id) || replacements.has(node.id)) {
      throw new Error("Pasted nodes require unique nonempty IDs.");
    }
    replacements.set(node.id, id);
    generated.add(id);
  }
  const nodes = payload.map((node) => ({
    ...withParent(node, node.parentId ? replacements.get(node.parentId) : undefined),
    id: replacements.get(node.id)!,
    x: node.x + offset.x,
    y: node.y + offset.y,
  }));
  return { nodes, selection: nodes.filter((node) => !node.parentId).map((node) => node.id) };
}
