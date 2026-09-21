/* oxlint-disable oxc/no-map-spread -- Document nodes are immutable; geometry operations return new snapshots. */
import type { CanvasFrame } from "./canvas-document";
import type { FrameRect, Point } from "./canvas-geometry";

type FrameSource = { getFrame: (id: string) => CanvasFrame | undefined };
export type CanvasMatrix = { a: number; b: number; c: number; d: number; e: number; f: number };
export const IDENTITY: CanvasMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiplyMatrix(p: CanvasMatrix, m: CanvasMatrix): CanvasMatrix {
  return {
    a: p.a * m.a + p.c * m.b,
    b: p.b * m.a + p.d * m.b,
    c: p.a * m.c + p.c * m.d,
    d: p.b * m.c + p.d * m.d,
    e: p.a * m.e + p.c * m.f + p.e,
    f: p.b * m.e + p.d * m.f + p.f,
  };
}

export function inverseMatrix(m: CanvasMatrix): CanvasMatrix {
  const determinant = m.a * m.d - m.b * m.c;

  return {
    a: m.d / determinant,
    b: -m.b / determinant,
    c: -m.c / determinant,
    d: m.a / determinant,
    e: (m.c * m.f - m.d * m.e) / determinant,
    f: (m.b * m.e - m.a * m.f) / determinant,
  };
}

export function transformPoint(m: CanvasMatrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function transformVector(m: CanvasMatrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y, y: m.b * p.x + m.d * p.y };
}

export function matrixCss(m: CanvasMatrix) {
  return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
}

/** Stored positions remain in the unrotated document layout space. Rotation is local to the parent. */
export function localTransform(frame: CanvasFrame, parent?: CanvasFrame): CanvasMatrix {
  const angle = ((frame.rotation ?? 0) * Math.PI) / 180,
    a = Math.cos(angle),
    b = Math.sin(angle);

  const x = frame.width / 2,
    y = frame.height / 2;

  return {
    a,
    b,
    c: -b,
    d: a,
    e: frame.x - (parent?.x ?? 0) + x - a * x + b * y,
    f: frame.y - (parent?.y ?? 0) + y - b * x - a * y,
  };
}

export function worldTransform(source: FrameSource, frame: CanvasFrame): CanvasMatrix {
  const path: CanvasFrame[] = [frame],
    seen = new Set([frame.id]);

  let parent = frame.parentId ? source.getFrame(frame.parentId) : undefined;

  while (parent && !seen.has(parent.id)) {
    path.push(parent);
    seen.add(parent.id);
    parent = parent.parentId ? source.getFrame(parent.parentId) : undefined;
  }

  let matrix = IDENTITY;
  for (let i = path.length - 1; i >= 0; i--)
    matrix = multiplyMatrix(matrix, localTransform(path[i], path[i + 1]));

  return matrix;
}

export function frameSource(nodes: readonly CanvasFrame[]): FrameSource {
  const byId = new Map(nodes.map((n) => [n.id, n]));

  return { getFrame: (id) => byId.get(id) };
}

export function worldCorners(source: FrameSource, frame: CanvasFrame): Point[] {
  const matrix = worldTransform(source, frame);

  return [
    { x: 0, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height },
    { x: 0, y: frame.height },
  ].map((p) => transformPoint(matrix, p));
}

export function pointBounds(points: readonly Point[]): FrameRect {
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));

  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x,
    height: Math.max(...points.map((p) => p.y)) - y,
  };
}

export function worldBounds(source: FrameSource, frame: CanvasFrame): FrameRect {
  return pointBounds(worldCorners(source, frame));
}

export function hasRotation(source: FrameSource, frame: CanvasFrame): boolean {
  if ((frame.rotation ?? 0) % 360) return true;
  const parent = frame.parentId ? source.getFrame(frame.parentId) : undefined;

  return parent ? hasRotation(source, parent) : false;
}

export function worldPointInFrame(
  source: FrameSource,
  frame: CanvasFrame,
  point: Point,
  rounded = true,
): boolean {
  const p = transformPoint(inverseMatrix(worldTransform(source, frame)), point);
  if (p.x < -1e-8 || p.y < -1e-8 || p.x > frame.width + 1e-8 || p.y > frame.height + 1e-8)
    return false;
  const r = rounded ? Math.min(frame.cornerRadius ?? 0, frame.width / 2, frame.height / 2) : 0;

  return (
    !r ||
    Math.hypot(
      p.x - Math.max(r, Math.min(frame.width - r, p.x)),
      p.y - Math.max(r, Math.min(frame.height - r, p.y)),
    ) <=
      r + 1e-8
  );
}

/** Preserve a subtree's world pose when changing its parent. */
export function reparentTransformed(
  nodes: readonly CanvasFrame[],
  id: string,
  parentId?: string,
): CanvasFrame[] {
  const source = frameSource(nodes),
    frame = source.getFrame(id);

  if (!frame || frame.parentId === parentId) return [];
  const parent = parentId ? source.getFrame(parentId) : undefined;
  const matrix = worldTransform(source, frame);

  const relative = parent
    ? multiplyMatrix(inverseMatrix(worldTransform(source, parent)), matrix)
    : matrix;

  const center = transformPoint(relative, { x: frame.width / 2, y: frame.height / 2 });

  const x = center.x - frame.width / 2 + (parent?.x ?? 0),
    y = center.y - frame.height / 2 + (parent?.y ?? 0);

  const dx = x - frame.x,
    dy = y - frame.y;

  const included = new Set([id]);

  for (const node of nodes) {
    let p = node.parentId;

    while (p) {
      if (p === id) {
        included.add(node.id);
        break;
      }

      p = source.getFrame(p)?.parentId;
    }
  }

  return nodes
    .filter(
      (node) =>
        included.has(node.id) && (node.id === id || Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9),
    )
    .map((node) => {
      if (node.id !== id) return { ...node, x: node.x + dx, y: node.y + dy };
      const { parentId: _parent, ...rest } = node;
      const rotation = (Math.atan2(relative.b, relative.a) * 180) / Math.PI;

      return {
        ...rest,
        x,
        y,
        ...(parentId ? { parentId } : {}),
        ...(node.rotation !== undefined || Math.abs(rotation) > 1e-8 ? { rotation } : {}),
      };
    });
}

/** Detach selected roots for clipboard/export without losing inherited rotations. */
export function detachCanvasSelection(
  nodes: readonly CanvasFrame[],
  roots: readonly string[],
): CanvasFrame[] {
  let updated = [...nodes];

  for (const id of roots) {
    const patches = new Map(reparentTransformed(updated, id).map((n) => [n.id, n]));
    updated = updated.map((n) => patches.get(n.id) ?? n);
  }

  return updated;
}

/** Screen/world motion converted to each selected root's parent layout axes. */
export function moveSelectionWorld(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  delta: Point,
): CanvasFrame[] {
  const source = frameSource(nodes),
    roots = new Set(ids),
    deltas = new Map<string, Point>();

  for (const id of ids) {
    const node = source.getFrame(id);
    if (!node) continue;
    const parent = node.parentId ? source.getFrame(node.parentId) : undefined;
    deltas.set(
      id,
      parent ? transformVector(inverseMatrix(worldTransform(source, parent)), delta) : delta,
    );
  }

  return nodes.flatMap((node) => {
    let root: CanvasFrame | undefined = node;
    while (root && !roots.has(root.id))
      root = root.parentId ? source.getFrame(root.parentId) : undefined;
    const d = root ? deltas.get(root.id) : undefined;

    return d ? [{ ...node, x: node.x + d.x, y: node.y + d.y }] : [];
  });
}

/** Intersect a rotated rectangular selection with convex, rounded ancestor clips. */
export function visibleWorldPolygon(source: FrameSource, frame: CanvasFrame): Point[] {
  let polygon = worldCorners(source, frame),
    parent = frame.parentId ? source.getFrame(frame.parentId) : undefined;

  while (parent && polygon.length) {
    if (parent.hidden) return [];

    if ((!parent.kind || parent.kind === "frame") && parent.clipContent !== false) {
      const r = Math.min(parent.cornerRadius ?? 0, parent.width / 2, parent.height / 2),
        m = worldTransform(source, parent);

      const clip: Point[] = [];

      for (const [x, y, start] of [
        [parent.width - r, r, -90],
        [parent.width - r, parent.height - r, 0],
        [r, parent.height - r, 90],
        [r, r, 180],
      ]) {
        for (let i = 0; i <= 16; i++) {
          const a = ((start + (i * 90) / 16) * Math.PI) / 180;
          clip.push(transformPoint(m, { x: x + r * Math.cos(a), y: y + r * Math.sin(a) }));
        }
      }

      for (let i = 0; i < clip.length && polygon.length; i++) {
        const a = clip[i],
          b = clip[(i + 1) % clip.length];

        if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) continue;
        const side = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        const input = polygon;
        polygon = [];

        for (let j = 0; j < input.length; j++) {
          const p = input[j],
            q = input[(j + 1) % input.length],
            sp = side(p),
            sq = side(q);

          if (sp >= -1e-8) polygon.push(p);

          if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
            const t = sp / (sp - sq);
            polygon.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
          }
        }
      }
    }

    parent = parent.parentId ? source.getFrame(parent.parentId) : undefined;
  }

  return polygon;
}

/** Uniform world-space scaling preserves rotations without introducing unsupported shear. */
export function scaleSelectionWorld(
  nodes: readonly CanvasFrame[],
  ids: readonly string[],
  start: FrameRect,
  next: FrameRect,
): CanvasFrame[] {
  const source = frameSource(nodes),
    updates = new Map<string, CanvasFrame>();

  const scale = next.width / start.width;

  for (const id of ids) {
    const root = source.getFrame(id);
    if (!root) continue;

    const center = transformPoint(worldTransform(source, root), {
      x: root.width / 2,
      y: root.height / 2,
    });

    const moved = {
      x: next.x + (center.x - start.x) * scale,
      y: next.y + (center.y - start.y) * scale,
    };

    const parent = root.parentId ? source.getFrame(root.parentId) : undefined;

    const local = parent
      ? transformPoint(inverseMatrix(worldTransform(source, parent)), moved)
      : moved;

    const x = local.x + (parent?.x ?? 0) - (root.width * scale) / 2,
      y = local.y + (parent?.y ?? 0) - (root.height * scale) / 2;

    for (const node of nodes) {
      let ancestor: CanvasFrame | undefined = node;
      while (ancestor && ancestor.id !== id)
        ancestor = ancestor.parentId ? source.getFrame(ancestor.parentId) : undefined;
      if (!ancestor) continue;
      const minimum = !node.kind || node.kind === "frame" ? 40 : 1;
      updates.set(node.id, {
        ...node,
        x: x + (node.x - root.x) * scale,
        y: y + (node.y - root.y) * scale,
        width: Math.max(minimum, node.width * scale),
        height: Math.max(minimum, node.height * scale),
        ...(node.kind === "text" ? { fontSize: node.fontSize * scale } : {}),
      });
    }
  }

  return [...updates.values()];
}

/** Include the finite visible blur tail when exporting a standalone layer. */
export function exportBounds(source: FrameSource, frame: CanvasFrame): FrameRect {
  const pad = (frame.filters?.blur ?? 0) * 3;
  const matrix = worldTransform(source, frame);

  return pointBounds(
    [
      { x: -pad, y: -pad },
      { x: frame.width + pad, y: -pad },
      { x: frame.width + pad, y: frame.height + pad },
      { x: -pad, y: frame.height + pad },
    ].map((p) => transformPoint(matrix, p)),
  );
}
