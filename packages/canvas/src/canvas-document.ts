import { isFontFamily } from "./canvas-fonts";
import type { FrameRect, Point } from "./canvas-geometry";
import { canvasLayoutPositions, isCanvasLayout, type CanvasLayout } from "./canvas-layout";
import { CanvasSpatialIndex } from "./canvas-spatial-index";
/* oxlint-disable unicorn/no-array-sort, unicorn/no-array-reverse -- Sort/reverse only owned arrays; the app targets ES2020. */
import { SVG_DATA_URL } from "./canvas-svg";
import {
  EMPTY_THEME,
  normalizeTheme,
  isTokenBindings,
  applyTokenBindings,
  detachChangedTokens,
  type CanvasTheme,
  type TokenBindings,
} from "./canvas-theme";

export type CanvasShadow = Readonly<{
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: string;
  inset?: boolean;
}>;

type CanvasNodeBase = Readonly<
  FrameRect & {
    id: string;
    name: string;
    parentId?: string;
    locked?: boolean;
    hidden?: boolean;
    opacity?: number;
    cornerRadius?: number;
    borderWidth?: number;
    borderColor?: string;
    shadows?: readonly CanvasShadow[];
    tokenBindings?: TokenBindings;
  }
>;
export type CanvasFrameNode = CanvasNodeBase & {
  readonly kind?: "frame";
  readonly clipContent?: boolean;
  readonly fill?: string;
  readonly layout?: CanvasLayout;
  readonly htmlStyles?: string;
};
export type CanvasGroup = CanvasNodeBase & { readonly kind: "group" };
export type CanvasRectangle = CanvasNodeBase & {
  readonly kind: "rectangle";
  readonly fill: string;
};
export type CanvasText = CanvasNodeBase & {
  readonly kind: "text";
  readonly text: string;
  readonly fontSize: number;
  readonly color: string;
  readonly fontFamily?: string;
  readonly fontWeight?: number;
  readonly lineHeight?: number;
  readonly letterSpacing?: number;
  readonly textAlign?: "left" | "center" | "right";
  readonly fontStyle?: "normal" | "italic";
  readonly textDecoration?: "none" | "underline" | "line-through";
};
export type CanvasImage = CanvasNodeBase & {
  readonly kind: "image";
  readonly src: string;
};
export type CanvasSvg = CanvasNodeBase & { readonly kind: "svg"; readonly src: string };
export type CanvasPen = CanvasNodeBase & {
  readonly kind: "pen";
  readonly points: readonly Readonly<Point>[];
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly pathWidth: number;
  readonly pathHeight: number;
};
export type CanvasFrame =
  | CanvasFrameNode
  | CanvasGroup
  | CanvasRectangle
  | CanvasText
  | CanvasImage
  | CanvasSvg
  | CanvasPen;

export type CanvasTransaction = Readonly<{
  add?: readonly CanvasFrame[];
  update?: readonly CanvasFrame[];
  /** Explicit removals, allowing children to be reparented in the same transaction. */
  remove?: readonly string[];
}>;

export type CanvasDocumentSnapshot = Readonly<{
  ids: readonly string[];
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
}>;

type Listener = () => void;
type ChangeListener = (ids: readonly string[]) => void;
type FramePatch = {
  id: string;
  before: CanvasFrame | undefined;
  after: CanvasFrame | undefined;
};
type DocumentOperation = {
  beforeTheme?: CanvasTheme;
  afterTheme?: CanvasTheme;
  patches: readonly FramePatch[];
  beforeIds?: readonly string[];
  afterIds?: readonly string[];
};
type Hierarchy = {
  ids: readonly string[];
  children: ReadonlyMap<string | undefined, readonly string[]>;
};
const EMPTY_IDS: readonly string[] = Object.freeze([]);

export const CANVAS_STORAGE_KEY = "flies.canvas.v1";
export const LEGACY_CANVAS_STORAGE_KEY = "lra-dsgn.canvas.v1";
const HISTORY_LIMIT = 100;

// Only arrays copied and deeply frozen here are trusted by the gesture fast path.
const immutablePointArrays = new WeakSet<readonly Readonly<Point>[]>();
const immutableShadowArrays = new WeakSet<readonly CanvasShadow[]>();
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i;
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z\d+/]+={0,2}$/i;

function pointsEqual(first: readonly Readonly<Point>[], second: readonly Readonly<Point>[]) {
  return (
    first === second ||
    (first.length === second.length &&
      first.every((point, i) => point.x === second[i].x && point.y === second[i].y))
  );
}

function shadowsEqual(first?: readonly CanvasShadow[], second?: readonly CanvasShadow[]) {
  return (
    first === second ||
    (first !== undefined &&
      second !== undefined &&
      first.length === second.length &&
      first.every(
        (shadow, i) =>
          shadow.offsetX === second[i].offsetX &&
          shadow.offsetY === second[i].offsetY &&
          shadow.blur === second[i].blur &&
          shadow.spread === second[i].spread &&
          shadow.color === second[i].color &&
          shadow.inset === second[i].inset,
      ))
  );
}

function framesEqual(first: CanvasFrame, second: CanvasFrame) {
  if (
    first.id !== second.id ||
    first.name !== second.name ||
    first.parentId !== second.parentId ||
    first.locked !== second.locked ||
    first.hidden !== second.hidden ||
    first.opacity !== second.opacity ||
    first.cornerRadius !== second.cornerRadius ||
    first.borderWidth !== second.borderWidth ||
    first.borderColor !== second.borderColor ||
    !shadowsEqual(first.shadows, second.shadows) ||
    JSON.stringify(first.tokenBindings) !== JSON.stringify(second.tokenBindings) ||
    first.x !== second.x ||
    first.y !== second.y ||
    first.width !== second.width ||
    first.height !== second.height ||
    (first.kind ?? "frame") !== (second.kind ?? "frame")
  )
    return false;

  switch (first.kind) {
    case "rectangle":
      return second.kind === "rectangle" && first.fill === second.fill;
    case "text":
      return (
        second.kind === "text" &&
        first.text === second.text &&
        first.fontSize === second.fontSize &&
        first.color === second.color &&
        first.fontFamily === second.fontFamily &&
        first.fontWeight === second.fontWeight &&
        first.lineHeight === second.lineHeight &&
        first.letterSpacing === second.letterSpacing &&
        first.textAlign === second.textAlign &&
        first.fontStyle === second.fontStyle &&
        first.textDecoration === second.textDecoration
      );
    case "svg":
    case "image":
      return second.kind === first.kind && first.src === second.src;
    case "pen":
      return (
        second.kind === "pen" &&
        first.stroke === second.stroke &&
        first.strokeWidth === second.strokeWidth &&
        first.pathWidth === second.pathWidth &&
        first.pathHeight === second.pathHeight &&
        pointsEqual(first.points, second.points)
      );
    case "group":
      return true;
    default:
      return (
        (second.kind === undefined || second.kind === "frame") &&
        first.clipContent === second.clipContent &&
        first.fill === second.fill &&
        first.htmlStyles === second.htmlStyles &&
        first.layout?.direction === second.layout?.direction &&
        first.layout?.gap === second.layout?.gap &&
        first.layout?.padding === second.layout?.padding &&
        first.layout?.align === second.layout?.align &&
        first.layout?.justify === second.layout?.justify
      );
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return isFiniteNumber(value) && value >= min && value <= max;
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

function isPoints(value: unknown): value is readonly Readonly<Point>[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (immutablePointArrays.has(value)) return true;

  return value.every(
    (point: unknown) =>
      typeof point === "object" &&
      point !== null &&
      "x" in point &&
      "y" in point &&
      isFiniteNumber(point.x) &&
      isFiniteNumber(point.y),
  );
}

function isShadows(value: unknown): value is readonly CanvasShadow[] {
  if (!Array.isArray(value) || value.length > 8) return false;
  if (immutableShadowArrays.has(value)) return true;

  return value.every((item: unknown) => {
    if (typeof item !== "object" || item === null) return false;
    const shadow = item as Record<string, unknown>;

    return (
      isFiniteNumber(shadow.offsetX) &&
      isFiniteNumber(shadow.offsetY) &&
      isFiniteNumber(shadow.blur) &&
      shadow.blur >= 0 &&
      isFiniteNumber(shadow.spread) &&
      isColor(shadow.color) &&
      (shadow.inset === undefined || typeof shadow.inset === "boolean")
    );
  });
}

function isFrame(value: unknown, previous?: CanvasFrame): value is CanvasFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Record<string, unknown>;
  const minimumSize = frame.kind === undefined || frame.kind === "frame" ? 40 : 1;
  if (
    typeof frame.id !== "string" ||
    typeof frame.name !== "string" ||
    (frame.parentId !== undefined && typeof frame.parentId !== "string") ||
    (frame.locked !== undefined && typeof frame.locked !== "boolean") ||
    (frame.hidden !== undefined && typeof frame.hidden !== "boolean") ||
    (frame.opacity !== undefined && !isNumberInRange(frame.opacity, 0, 1)) ||
    (frame.cornerRadius !== undefined &&
      (!isFiniteNumber(frame.cornerRadius) || frame.cornerRadius < 0)) ||
    (frame.borderWidth !== undefined &&
      (!isFiniteNumber(frame.borderWidth) || frame.borderWidth < 0)) ||
    (frame.borderColor !== undefined && !isColor(frame.borderColor)) ||
    (frame.shadows !== undefined && !isShadows(frame.shadows)) ||
    (frame.tokenBindings !== undefined && !isTokenBindings(frame.tokenBindings)) ||
    (frame.layout !== undefined && frame.kind !== undefined && frame.kind !== "frame") ||
    !isFiniteNumber(frame.x) ||
    !isFiniteNumber(frame.y) ||
    !isFiniteNumber(frame.width) ||
    frame.width < minimumSize ||
    !isFiniteNumber(frame.height) ||
    frame.height < minimumSize
  )
    return false;

  switch (frame.kind) {
    case undefined:
    case "frame":
      return (
        (frame.clipContent === undefined || typeof frame.clipContent === "boolean") &&
        (frame.fill === undefined || isColor(frame.fill)) &&
        (frame.htmlStyles === undefined ||
          (typeof frame.htmlStyles === "string" && frame.htmlStyles.length <= 50_000)) &&
        (frame.layout === undefined || isCanvasLayout(frame.layout))
      );
    case "group":
      return true;
    case "rectangle":
      return isColor(frame.fill);
    case "text":
      return (
        typeof frame.text === "string" &&
        isPositiveNumber(frame.fontSize) &&
        isColor(frame.color) &&
        (frame.fontFamily === undefined || isFontFamily(frame.fontFamily)) &&
        (frame.fontWeight === undefined ||
          (Number.isInteger(frame.fontWeight) && isNumberInRange(frame.fontWeight, 1, 1000))) &&
        (frame.lineHeight === undefined || isNumberInRange(frame.lineHeight, 0.5, 4)) &&
        (frame.letterSpacing === undefined || isNumberInRange(frame.letterSpacing, -10, 100)) &&
        (frame.textAlign === undefined ||
          frame.textAlign === "left" ||
          frame.textAlign === "center" ||
          frame.textAlign === "right") &&
        (frame.fontStyle === undefined ||
          frame.fontStyle === "normal" ||
          frame.fontStyle === "italic") &&
        (frame.textDecoration === undefined ||
          frame.textDecoration === "none" ||
          frame.textDecoration === "underline" ||
          frame.textDecoration === "line-through")
      );
    case "svg":
      return (
        (previous?.kind === "svg" && frame.src === previous.src) ||
        (typeof frame.src === "string" &&
          frame.src.length <= 3_000_000 &&
          SVG_DATA_URL.test(frame.src))
      );
    case "image":
      return (
        (previous?.kind === "image" && frame.src === previous.src) ||
        (typeof frame.src === "string" && RASTER_DATA_URL.test(frame.src))
      );
    case "pen":
      return (
        isPoints(frame.points) &&
        isColor(frame.stroke) &&
        isPositiveNumber(frame.strokeWidth) &&
        isPositiveNumber(frame.pathWidth) &&
        isPositiveNumber(frame.pathHeight)
      );
    default:
      return false;
  }
}

function immutablePoints(points: readonly Readonly<Point>[]): readonly Readonly<Point>[] {
  if (immutablePointArrays.has(points)) return points;
  const frozen = Object.freeze(points.map((point) => Object.freeze({ x: point.x, y: point.y })));
  immutablePointArrays.add(frozen);

  return frozen;
}

function immutableShadows(shadows: readonly CanvasShadow[]): readonly CanvasShadow[] {
  if (immutableShadowArrays.has(shadows)) return shadows;

  const frozen = Object.freeze(
    shadows.map((shadow) =>
      Object.freeze({
        offsetX: shadow.offsetX,
        offsetY: shadow.offsetY,
        blur: shadow.blur,
        spread: shadow.spread,
        color: shadow.color,
        ...(shadow.inset !== undefined && { inset: shadow.inset }),
      }),
    ),
  );

  immutableShadowArrays.add(frozen);

  return frozen;
}

function immutableFrame(frame: CanvasFrame): CanvasFrame {
  const base = {
    id: frame.id,
    name: frame.name,
    ...(frame.parentId !== undefined && { parentId: frame.parentId }),
    ...(frame.locked !== undefined && { locked: frame.locked }),
    ...(frame.hidden !== undefined && { hidden: frame.hidden }),
    ...(frame.opacity !== undefined && { opacity: frame.opacity }),
    ...(frame.cornerRadius !== undefined && { cornerRadius: frame.cornerRadius }),
    ...(frame.borderWidth !== undefined && { borderWidth: frame.borderWidth }),
    ...(frame.borderColor !== undefined && { borderColor: frame.borderColor }),
    ...(frame.shadows !== undefined && { shadows: immutableShadows(frame.shadows) }),
    ...(frame.tokenBindings !== undefined && {
      tokenBindings: Object.freeze({ ...frame.tokenBindings }),
    }),
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
  };

  switch (frame.kind) {
    case "rectangle":
      return Object.freeze({ ...base, kind: frame.kind, fill: frame.fill });
    case "text":
      return Object.freeze({
        ...base,
        kind: frame.kind,
        text: frame.text,
        fontSize: frame.fontSize,
        color: frame.color,
        ...(frame.fontFamily !== undefined && { fontFamily: frame.fontFamily }),
        ...(frame.fontWeight !== undefined && { fontWeight: frame.fontWeight }),
        ...(frame.lineHeight !== undefined && { lineHeight: frame.lineHeight }),
        ...(frame.letterSpacing !== undefined && { letterSpacing: frame.letterSpacing }),
        ...(frame.textAlign !== undefined && { textAlign: frame.textAlign }),
        ...(frame.fontStyle !== undefined && { fontStyle: frame.fontStyle }),
        ...(frame.textDecoration !== undefined && { textDecoration: frame.textDecoration }),
      });
    case "svg":
    case "image":
      return Object.freeze({ ...base, kind: frame.kind, src: frame.src });
    case "pen":
      return Object.freeze({
        ...base,
        kind: frame.kind,
        points: immutablePoints(frame.points),
        stroke: frame.stroke,
        strokeWidth: frame.strokeWidth,
        pathWidth: frame.pathWidth,
        pathHeight: frame.pathHeight,
      });
    case "group":
      return Object.freeze({ ...base, kind: frame.kind });
    default:
      return Object.freeze({
        ...base,
        ...(frame.kind === "frame" && { kind: frame.kind }),
        ...(frame.clipContent !== undefined && { clipContent: frame.clipContent }),
        ...(frame.fill !== undefined && { fill: frame.fill }),
        ...(frame.htmlStyles !== undefined && { htmlStyles: frame.htmlStyles }),
        ...(frame.layout !== undefined && {
          layout: Object.freeze({
            direction: frame.layout.direction,
            gap: frame.layout.gap,
            padding: frame.layout.padding,
            align: frame.layout.align,
            justify: frame.layout.justify,
          }),
        }),
      });
  }
}

/** Validate parents and derive stable, contiguous parent-before-child stacking order. */
function hierarchyFor(
  frames: ReadonlyMap<string, CanvasFrame>,
  order: readonly string[],
): Hierarchy | undefined {
  const children = new Map<string | undefined, string[]>();

  for (const id of order) {
    const frame = frames.get(id);
    if (!frame) return undefined;

    if (frame.parentId !== undefined) {
      const parent = frames.get(frame.parentId);

      if (
        !parent ||
        parent.id === id ||
        (parent.kind && parent.kind !== "frame" && parent.kind !== "group")
      ) {
        return undefined;
      }
    }

    const siblings = children.get(frame.parentId);
    if (siblings) siblings.push(id);
    else children.set(frame.parentId, [id]);
  }

  const ids: string[] = [];
  const stack = [...(children.get(undefined) ?? [])].reverse();

  while (stack.length > 0) {
    const id = stack.pop()!;
    ids.push(id);
    const descendants = children.get(id);

    if (descendants) {
      for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }
  }

  // A cycle cannot be reached from a root; orphaned/cyclic input has fewer visited nodes.
  if (ids.length !== frames.size) return undefined;

  return {
    ids: Object.freeze(ids),
    children: new Map([...children].map(([parent, siblings]) => [parent, Object.freeze(siblings)])),
  };
}

function sameIds(first: readonly string[], second: readonly string[]) {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

/** Indexed document with per-node subscriptions and bounded atomic operation history. */
export class CanvasDocument {
  private frames = new Map<string, CanvasFrame>();
  private theme: CanvasTheme;
  private ids: readonly string[];
  private children: Hierarchy["children"];
  private order: Map<string, number>;
  private snapshot: CanvasDocumentSnapshot;
  private listeners = new Set<Listener>();
  private frameListeners = new Map<string, Set<Listener>>();
  private changeListeners = new Set<ChangeListener>();
  private past: DocumentOperation[] = [];
  private future: DocumentOperation[] = [];
  private gesture: Map<string, CanvasFrame> | undefined;

  constructor(initial: readonly CanvasFrame[] = [], theme: CanvasTheme = EMPTY_THEME) {
    this.theme = normalizeTheme(theme);

    for (const original of initial) {
      const frame = this.theme.tokens.length ? applyTokenBindings(original, this.theme) : original;

      if (!isFrame(frame) || this.frames.has(frame.id)) {
        throw new Error("Canvas frames must have valid bounds and unique ids.");
      }

      this.frames.set(frame.id, immutableFrame(frame));
    }

    const hierarchy = hierarchyFor(this.frames, [...this.frames.keys()]);
    if (!hierarchy) throw new Error("Canvas parents must form a valid frame/group hierarchy.");
    this.ids = hierarchy.ids;
    this.children = hierarchy.children;
    this.order = new Map(this.ids.map((id, index) => [id, index]));
    this.snapshot = Object.freeze({ ids: this.ids, revision: 0, canUndo: false, canRedo: false });

    const layouts = [...this.frames.values()].filter(
      (node) => (!node.kind || node.kind === "frame") && node.layout,
    );

    if (layouts.length) {
      const operation = this.prepare(
        layouts.map((node) => ({
          id: node.id,
          before: this.frames.get(node.id),
          after: this.frames.get(node.id),
        })),
      );

      if (!operation) throw new Error("Canvas layout must produce finite, valid bounds.");
      this.apply(operation, false);
    }
  }

  getTheme = () => this.theme;
  setTheme = (value: CanvasTheme, measureText?: (node: CanvasText) => number): boolean => {
    const theme = normalizeTheme(value);
    if (JSON.stringify(theme) === JSON.stringify(this.theme)) return false;
    this.endGesture();

    const updated = this.getFrames().map((node) => {
      const result = applyTokenBindings(node, theme);

      return result.kind === "text" &&
        node.kind === "text" &&
        measureText &&
        (result.fontFamily !== node.fontFamily ||
          result.fontSize !== node.fontSize ||
          result.letterSpacing !== node.letterSpacing)
        ? Object.assign({}, result, { height: measureText(result) })
        : result;
    });

    // Validate every resolved value before changing the document or its history.
    const validated = new CanvasDocument(updated, theme);

    const patches = validated.getFrames().flatMap((node) => {
      const before = this.frames.get(node.id)!;

      return framesEqual(before, node)
        ? []
        : [{ id: node.id, before, after: immutableFrame(node) }];
    });

    const operation = patches.length ? this.prepare(patches) : { patches };
    if (!operation) throw new Error("Theme changes would produce invalid layout.");
    operation.beforeTheme = this.theme;
    operation.afterTheme = theme;
    this.apply(operation, false);
    this.record(operation);

    return true;
  };

  getFrame = (id: string) => this.frames.get(id);
  isHidden = (id: string): boolean => {
    let node = this.frames.get(id);

    while (node) {
      if (node.hidden) return true;
      node = node.parentId ? this.frames.get(node.parentId) : undefined;
    }

    return false;
  };

  getIds = () => this.ids;
  getSnapshot = () => this.snapshot;
  getChildren = (parentId?: string): readonly string[] => this.children.get(parentId) ?? EMPTY_IDS;
  /** Includes derived layout changes so viewport culling can use their live preview bounds. */
  getPreviewIds = (): Iterable<string> => this.gesture?.keys() ?? EMPTY_IDS;

  /** Selected descendants are represented by their selected ancestor exactly once. */
  getRootIds = (ids: readonly string[]): string[] => {
    const selected = new Set(ids.filter((id) => this.frames.has(id)));

    return [...selected]
      .filter((id) => {
        let parentId = this.frames.get(id)?.parentId;

        while (parentId !== undefined) {
          if (selected.has(parentId)) return false;
          parentId = this.frames.get(parentId)?.parentId;
        }

        return true;
      })
      .sort((first, second) => this.order.get(first)! - this.order.get(second)!);
  };

  /** Includes roots, ordered as rendered; overlapping selected subtrees are deduplicated. */
  getDescendantIds = (ids: readonly string[]): string[] => {
    const result: string[] = [];
    const stack = this.getRootIds(ids).reverse();

    while (stack.length > 0) {
      const id = stack.pop()!;
      result.push(id);
      const children = this.getChildren(id);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }

    return result;
  };

  /** Diagnostics count history references, not JavaScript heap bytes. */
  getHistoryStats = () => ({
    undoEntries: this.past.length,
    redoEntries: this.future.length,
    retainedFrameReferences: [...this.past, ...this.future].reduce(
      (count, operation) =>
        count +
        operation.patches.reduce(
          (references, patch) =>
            references + Number(patch.before !== undefined) + Number(patch.after !== undefined),
          0,
        ),
      0,
    ),
  });

  /** Reserve full materialization for initialization, fitting, and persistence. */
  getFrames = (): CanvasFrame[] => this.ids.map((id) => this.frames.get(id)!);

  /** Never persist an uncommitted drag if a pending save or pagehide occurs mid-gesture. */
  getCommittedFrames = (): CanvasFrame[] =>
    this.ids.map((id) => this.gesture?.get(id) ?? this.frames.get(id)!);

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeFrame = (id: string, listener: Listener) => {
    let listeners = this.frameListeners.get(id);

    if (!listeners) {
      listeners = new Set();
      this.frameListeners.set(id, listeners);
    }

    listeners.add(listener);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.frameListeners.delete(id);
    };
  };

  /** Committed ids only; selected nodes remain mounted during a preview. */
  subscribeChanges = (listener: ChangeListener) => {
    this.changeListeners.add(listener);

    return () => {
      this.changeListeners.delete(listener);
    };
  };

  add = (frame: CanvasFrame) => this.addMany([frame]);
  addMany = (frames: readonly CanvasFrame[]) => this.transact({ add: frames });
  update = (frame: CanvasFrame) => this.updateMany([frame]);
  updateMany = (frames: readonly CanvasFrame[]) => this.transact({ update: frames });
  remove = (id: string) => this.removeMany([id]);
  removeMany = (ids: readonly string[]) => this.transact({ remove: this.getDescendantIds(ids) });

  /** Open a complete project atomically, retaining one undo back to the previous document. */
  replaceAll = (frames: readonly CanvasFrame[], theme: CanvasTheme = EMPTY_THEME): boolean => {
    let replacement: CanvasDocument;

    try {
      replacement = new CanvasDocument(frames, theme);
    } catch {
      return false;
    }

    this.endGesture();
    const patches: FramePatch[] = [];

    for (const id of new Set([...this.ids, ...replacement.getIds()])) {
      const before = this.frames.get(id);
      const after = replacement.getFrame(id);
      if (before && after ? !framesEqual(before, after) : before !== after)
        patches.push({ id, before, after });
    }

    if (
      !patches.length &&
      sameIds(this.ids, replacement.getIds()) &&
      JSON.stringify(this.theme) === JSON.stringify(replacement.getTheme())
    )
      return false;

    const operation: DocumentOperation = {
      patches,
      beforeIds: this.ids,
      afterIds: replacement.getIds(),
      beforeTheme: this.theme,
      afterTheme: replacement.getTheme(),
    };

    this.apply(operation, false);
    this.record(operation);

    return true;
  };

  /** All input is validated before any node changes; mixed operations form one undo entry. */
  transact = ({ add = [], update = [], remove = [] }: CanvasTransaction): boolean => {
    const seen = new Set<string>();
    const patches: FramePatch[] = [];

    for (const frame of add) {
      if (seen.has(frame.id) || this.frames.has(frame.id) || !isFrame(frame)) return false;
      seen.add(frame.id);
      patches.push({ id: frame.id, before: undefined, after: immutableFrame(frame) });
    }

    for (const raw of update) {
      const existing = this.frames.get(raw.id);
      const frame = existing ? detachChangedTokens(existing, raw) : raw;
      const before = this.frames.get(frame.id);
      if (seen.has(frame.id) || !before || !isFrame(frame, before)) return false;
      seen.add(frame.id);
      if (!framesEqual(before, frame))
        patches.push({ id: frame.id, before, after: immutableFrame(frame) });
    }

    for (const id of remove) {
      if (seen.has(id)) return false;
      seen.add(id);
      const before = this.frames.get(id);
      if (before) patches.push({ id, before, after: undefined });
    }

    if (patches.length === 0) return false;
    const operation = this.prepare(patches);
    if (!operation || operation.patches.length === 0) return false;

    if (this.gesture) {
      this.endGesture();

      // Committing a gesture can update ancestor group bounds; use that committed baseline.
      return this.transact({ add, update, remove });
    }

    this.apply(operation, false);
    this.record(operation);

    return true;
  };

  beginGesture = (id: string | readonly string[]) => {
    const ids = typeof id === "string" ? [id] : [...new Set(id)];
    if (
      this.gesture &&
      ids.length === this.gesture.size &&
      ids.every((key) => this.gesture!.has(key))
    )
      return;
    this.endGesture();

    const frames = ids.flatMap((key) => {
      const frame = this.frames.get(key);

      return frame ? [[key, frame] as const] : [];
    });

    this.gesture = frames.length > 0 ? new Map(frames) : undefined;
  };

  preview = (frame: CanvasFrame) => this.previewMany([frame]);

  /** Reflow only affected containers; preview never changes history, ids, or the spatial index. */
  previewMany = (frames: readonly CanvasFrame[]): boolean => {
    if (!this.gesture) return false;
    const seen = new Set<string>();
    const updates: CanvasFrame[] = [];

    for (const raw of frames) {
      const existing = this.frames.get(raw.id);
      const frame = existing ? detachChangedTokens(existing, raw) : raw;
      const before = this.frames.get(frame.id);
      if (!this.gesture.has(frame.id) || seen.has(frame.id) || !before || !isFrame(frame, before))
        return false;
      // Parent changes are applied atomically at commit, keeping rendering/persistence stable mid-drag.
      if (
        frame.parentId !== before.parentId ||
        (frame.kind ?? "frame") !== (before.kind ?? "frame")
      )
        return false;
      seen.add(frame.id);
      if (!framesEqual(before, frame)) updates.push(immutableFrame(frame));
    }

    const patches = updates.map((frame) => ({
      id: frame.id,
      before: this.frames.get(frame.id),
      after: frame,
    }));

    const hasLayout = patches.some((patch) => {
      for (const initial of [patch.before, patch.after]) {
        let node = initial;

        while (node) {
          if ((!node.kind || node.kind === "frame") && node.layout) return true;
          node = node.parentId ? this.frames.get(node.parentId) : undefined;
        }
      }

      return false;
    });

    const operation = hasLayout ? this.prepare(patches) : { patches };
    if (!operation) return false;

    for (const patch of operation.patches) {
      if (!patch.after) continue;
      if (!this.gesture.has(patch.id) && patch.before) this.gesture.set(patch.id, patch.before);
      this.frames.set(patch.id, patch.after);
    }

    for (const patch of operation.patches) this.notifyFrame(patch.id);

    return operation.patches.length > 0;
  };

  /** Optional final updates include reparenting in the same undo entry as the drag. */
  endGesture = (cancel = false, updates: readonly CanvasFrame[] = []): boolean => {
    const before = this.gesture;
    if (!before) return false;

    if (cancel) {
      this.gesture = undefined;
      const changed: string[] = [];

      for (const [id, frame] of before) {
        if (!framesEqual(frame, this.frames.get(id)!)) {
          this.frames.set(id, frame);
          changed.push(id);
        }
      }

      for (const id of changed) this.notifyFrame(id);

      return changed.length > 0;
    }

    const final = new Map<string, CanvasFrame>();

    for (const frame of updates) {
      const current = this.frames.get(frame.id);
      if (final.has(frame.id) || !current || !isFrame(frame, current)) return false;
      final.set(frame.id, immutableFrame(frame));
    }

    const originals = new Map(before);
    for (const id of final.keys()) if (!originals.has(id)) originals.set(id, this.frames.get(id)!);
    const patches: FramePatch[] = [];

    for (const [id, original] of originals) {
      const after = final.get(id) ?? this.frames.get(id)!;
      if (!framesEqual(original, after)) patches.push({ id, before: original, after });
    }

    const operation = this.prepare(patches);
    if (!operation) return false;
    this.gesture = undefined;
    // Derived group bounds may return to their original value after a preview. Restore
    // those nodes even when the resulting operation has no history patch for them.
    const changedIds = new Set(operation.patches.map((patch) => patch.id));
    const restored: string[] = [];

    for (const [id, original] of before) {
      if (!changedIds.has(id) && !framesEqual(original, this.frames.get(id)!)) {
        this.frames.set(id, original);
        restored.push(id);
      }
    }

    // Only final commit updates need node notifications; previews already notified their subscribers.
    this.apply(
      operation,
      false,
      new Set(
        operation.patches
          .filter((patch) => {
            const current = this.frames.get(patch.id);

            return !current || !patch.after || !framesEqual(current, patch.after);
          })
          .map((patch) => patch.id),
      ),
    );
    for (const id of restored) this.notifyFrame(id);
    if (operation.patches.length === 0) return false;
    this.record(operation);

    return true;
  };

  reorder = (
    ids: readonly string[],
    direction: "front" | "back" | "forward" | "backward",
  ): boolean => {
    this.endGesture();
    const selected = new Set(this.getRootIds(ids));
    if (selected.size === 0) return false;
    const childLists = new Map(this.children);
    let changed = false;

    for (const [parent, children] of this.children) {
      if (!children.some((id) => selected.has(id))) continue;
      let next = [...children];

      if (direction === "front" || direction === "back") {
        const moving = next.filter((id) => selected.has(id));
        const stationary = next.filter((id) => !selected.has(id));
        next = direction === "front" ? [...stationary, ...moving] : [...moving, ...stationary];
      } else if (direction === "forward") {
        for (let index = next.length - 2; index >= 0; index--) {
          if (selected.has(next[index]) && !selected.has(next[index + 1])) {
            [next[index], next[index + 1]] = [next[index + 1], next[index]];
          }
        }
      } else {
        for (let index = 1; index < next.length; index++) {
          if (selected.has(next[index]) && !selected.has(next[index - 1])) {
            [next[index], next[index - 1]] = [next[index - 1], next[index]];
          }
        }
      }

      if (!sameIds(children, next)) {
        changed = true;
        childLists.set(parent, next);
      }
    }

    if (!changed) return false;
    const order: string[] = [];
    const stack = [...(childLists.get(undefined) ?? [])].reverse();

    while (stack.length > 0) {
      const id = stack.pop()!;
      order.push(id);
      const children = childLists.get(id) ?? [];
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
    }

    const operation = this.prepare([], order, selected);
    if (!operation) return false;
    this.apply(operation, false);
    this.record(operation);

    return true;
  };

  /** Layer-list order is front-to-back; geometry stays in world coordinates. */
  moveLayers = (
    ids: readonly string[],
    targetId: string | null,
    placement: "before" | "after" | "inside",
  ): boolean => {
    this.endGesture();
    const roots = this.getRootIds(ids);
    const target = targetId ? this.frames.get(targetId) : undefined;
    if (!roots.length || (targetId && !target)) return false;
    const subtree = new Set(this.getDescendantIds(roots));
    if (targetId && subtree.has(targetId)) return false;
    if (
      placement === "inside" &&
      (!target || (target.kind && target.kind !== "frame" && target.kind !== "group"))
    )
      return false;
    const parentId = placement === "inside" ? targetId! : target?.parentId;

    const isLocked = (id: string | undefined) => {
      let node = id ? this.frames.get(id) : undefined;

      while (node) {
        if (node.locked) return true;
        node = node.parentId ? this.frames.get(node.parentId) : undefined;
      }

      return false;
    };

    if (roots.some(isLocked) || isLocked(parentId)) return false;

    const patches = roots.map((id) => {
      const before = this.frames.get(id)!;

      return { id, before, after: immutableFrame({ ...before, parentId }) };
    });

    const prepared = this.prepare(patches);
    if (!prepared) return false;
    const next = new Map(this.frames);

    for (const patch of prepared.patches) {
      if (patch.after) next.set(patch.id, patch.after);
      else next.delete(patch.id);
    }

    const hierarchy = hierarchyFor(next, prepared.afterIds ?? this.ids);
    if (!hierarchy) return false;
    const moving = new Set(roots);
    const siblings = this.getChildren(parentId).filter((id) => !moving.has(id));
    // Keep a disappearing empty group as an insertion anchor until after the splice.
    const anchor = targetId ? siblings.indexOf(targetId) : -1;

    const index =
      placement === "inside"
        ? siblings.length
        : targetId
          ? anchor + Number(placement === "before")
          : 0;

    if (targetId && placement !== "inside" && anchor < 0) return false;
    siblings.splice(index, 0, ...roots);
    const children = new Map(hierarchy.children);
    children.set(
      parentId,
      siblings.filter((id) => next.has(id)),
    );
    const order: string[] = [];
    const stack = [...(children.get(undefined) ?? [])].reverse();

    while (stack.length) {
      const id = stack.pop()!;
      order.push(id);
      const descendants = children.get(id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--) stack.push(descendants[i]);
    }

    if (!prepared.patches.length && sameIds(order, this.ids)) return false;
    const operation = this.prepare(prepared.patches, order, roots);
    if (!operation) return false;
    this.apply(operation, false);
    this.record(operation);

    return true;
  };

  undo = () => {
    this.endGesture();
    const operation = this.past.pop();
    if (!operation) return;
    this.apply(operation, true);
    this.future.push(operation);
    this.notifyCommit(operation);
  };

  redo = () => {
    this.endGesture();
    const operation = this.future.pop();
    if (!operation) return;
    this.apply(operation, false);
    this.past.push(operation);
    this.notifyCommit(operation);
  };

  private prepare(
    input: readonly FramePatch[],
    requestedOrder?: readonly string[],
    dirtyIds: Iterable<string> = [],
  ): DocumentOperation | undefined {
    const patches = new Map(input.map((patch) => [patch.id, patch]));

    let structural =
      requestedOrder !== undefined ||
      input.some(
        (patch) =>
          !patch.before ||
          !patch.after ||
          patch.before.parentId !== patch.after.parentId ||
          patch.before.kind !== patch.after.kind,
      );

    const read = (id: string) => (patches.has(id) ? patches.get(id)!.after : this.frames.get(id));

    const createHierarchy = () => {
      const next = new Map(this.frames);

      for (const patch of patches.values()) {
        if (patch.after) next.set(patch.id, patch.after);
        else next.delete(patch.id);
      }

      const order = [
        ...(requestedOrder ?? this.ids).filter((id) => next.has(id)),
        ...[...patches.values()]
          .filter((patch) => !patch.before && patch.after && !requestedOrder?.includes(patch.id))
          .map((patch) => patch.id),
      ];

      // A newly created wrapper occupies its highest wrapped sibling's old position.
      // Grouping/frame-selection must not silently bring the objects above other layers.
      const wrapped = new Map<string, CanvasFrame[]>();

      for (const member of patches.values()) {
        if (!member.before || member.after?.parentId === undefined) continue;
        const members = wrapped.get(member.after.parentId);
        if (members) members.push(member.before);
        else wrapped.set(member.after.parentId, [member.before]);
      }

      for (const addition of patches.values()) {
        if (requestedOrder) break;
        const container = addition.after;
        if (
          addition.before ||
          !container ||
          (container.kind && container.kind !== "group" && container.kind !== "frame")
        )
          continue;
        let anchor = -1;

        for (const member of wrapped.get(container.id) ?? []) {
          let previous: CanvasFrame | undefined = member;

          while (previous && previous.parentId !== container.parentId) {
            previous =
              previous.parentId === undefined ? undefined : this.frames.get(previous.parentId);
          }

          if (previous) anchor = Math.max(anchor, this.order.get(previous.id)!);
        }

        if (anchor < 0) continue;
        order.splice(order.indexOf(container.id), 1);
        const position = order.findIndex((id) => (this.order.get(id) ?? -1) > anchor);
        order.splice(position === -1 ? order.length : position, 0, container.id);
      }

      return hierarchyFor(next, order);
    };

    let hierarchy = structural ? createHierarchy() : undefined;
    if (structural && !hierarchy) return undefined;
    const children = hierarchy?.children ?? this.children;

    // Derive containers bottom-up: groups measure their contents before a parent layout
    // positions them. Moving a layout child translates its whole subtree exactly once.
    const containers = new Set<string>();

    const collectContainers = (
      node: CanvasFrame | undefined,
      lookup: (id: string) => CanvasFrame | undefined,
    ) => {
      while (node) {
        if (node.kind === "group" || ((!node.kind || node.kind === "frame") && node.layout))
          containers.add(node.id);
        node = node.parentId === undefined ? undefined : lookup(node.parentId);
      }
    };

    for (const patch of input) {
      collectContainers(patch.before, (id) => this.frames.get(id));
      collectContainers(patch.after, read);
    }

    for (const id of dirtyIds) collectContainers(read(id), read);

    const depth = (id: string) => {
      let result = 0;
      let node = read(id);

      while (node?.parentId !== undefined) {
        result++;
        node = read(node.parentId);
      }

      return result;
    };

    let removedGroup = false;

    for (const id of [...containers].sort((first, second) => depth(second) - depth(first))) {
      const group = read(id);
      if (!group) continue;

      const members = (children.get(id) ?? []).flatMap((child) => {
        const node = read(child);

        return node ? [node] : [];
      });

      const before = patches.has(id) ? patches.get(id)!.before : this.frames.get(id);

      if (!group.kind || group.kind === "frame") {
        for (const [childId, position] of canvasLayoutPositions(group, members)) {
          const child = read(childId)!;
          const dx = position.x - child.x;
          const dy = position.y - child.y;
          if (dx === 0 && dy === 0) continue;
          const stack = [childId];

          while (stack.length) {
            const memberId = stack.pop()!;
            const member = read(memberId);
            if (!member) continue;

            const original = patches.has(memberId)
              ? patches.get(memberId)!.before
              : this.frames.get(memberId);

            patches.set(memberId, {
              id: memberId,
              before: original,
              after: immutableFrame({ ...member, x: member.x + dx, y: member.y + dy }),
            });
            for (const descendant of children.get(memberId) ?? []) stack.push(descendant);
          }
        }

        continue;
      }

      if (group.kind !== "group") continue;

      if (members.length === 0) {
        if (this.getChildren(id).length > 0) {
          patches.set(id, { id, before, after: undefined });
          removedGroup = true;
        }

        continue;
      }

      let x = Infinity;
      let y = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;

      for (const node of members) {
        x = Math.min(x, node.x);
        y = Math.min(y, node.y);
        right = Math.max(right, node.x + node.width);
        bottom = Math.max(bottom, node.y + node.height);
      }

      const width = right - x;
      const height = bottom - y;
      const after = immutableFrame({ ...group, x, y, width, height });
      if (!framesEqual(group, after)) patches.set(id, { id, before, after });
    }

    if (removedGroup) {
      structural = true;
      hierarchy = createHierarchy();
      if (!hierarchy) return undefined;
    }

    // Finite inputs can overflow during layout arithmetic. Validate derived geometry
    // before a preview, import or commit can publish it or serialize Infinity as null.
    for (const patch of patches.values()) {
      if (patch.after && !isFrame(patch.after, patch.before)) return undefined;
    }

    const effective = [...patches.values()].filter((patch) =>
      patch.before && patch.after
        ? !framesEqual(patch.before, patch.after)
        : patch.before !== patch.after,
    );

    return structural
      ? {
          patches: effective,
          beforeIds: this.ids,
          afterIds: sameIds(this.ids, hierarchy!.ids) ? this.ids : hierarchy!.ids,
        }
      : { patches: effective };
  }

  private apply(operation: DocumentOperation, reverse: boolean, notifyIds?: ReadonlySet<string>) {
    const theme = reverse ? operation.beforeTheme : operation.afterTheme;
    if (theme) this.theme = theme;

    for (const patch of operation.patches) {
      const next = reverse ? patch.before : patch.after;
      if (next) this.frames.set(patch.id, next);
      else this.frames.delete(patch.id);
    }

    const ids = reverse ? operation.beforeIds : operation.afterIds;

    if (ids) {
      this.ids = ids;
      const hierarchy = hierarchyFor(this.frames, ids)!;
      this.children = hierarchy.children;
      this.order = new Map(ids.map((id, index) => [id, index]));
    }

    for (const patch of operation.patches)
      if (!notifyIds || notifyIds.has(patch.id)) this.notifyFrame(patch.id);
  }

  private record(operation: DocumentOperation) {
    this.past.push(operation);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
    this.notifyCommit(operation);
  }

  private notifyFrame(id: string) {
    this.frameListeners.get(id)?.forEach((listener) => listener());
  }

  private notifyCommit(operation: DocumentOperation) {
    this.snapshot = Object.freeze({
      ids: this.ids,
      revision: this.snapshot.revision + 1,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    });
    const changedIds = Object.freeze(operation.patches.map((patch) => patch.id));
    this.changeListeners.forEach((listener) => listener(changedIds));
    this.listeners.forEach((listener) => listener());
  }
}

/** Infer ownership once for old flat canvases; subsequent saves explicitly preserve parents. */
function migrateLegacyParents(nodes: readonly CanvasFrame[]): CanvasFrame[] {
  if (nodes.some((node) => node.parentId !== undefined || node.kind === "group")) return [...nodes];
  const frames = nodes.filter((node) => node.kind === undefined || node.kind === "frame");
  const byId = new Map(frames.map((node) => [node.id, node]));
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const index = new CanvasSpatialIndex(frames);

  return nodes.map((node) => {
    const center = { x: node.x + node.width / 2, y: node.y + node.height / 2, width: 0, height: 0 };
    const isContainer = node.kind === undefined || node.kind === "frame";
    let parent: CanvasFrame | undefined;

    for (const id of index.query(center)) {
      if (id === node.id) continue;
      const candidate = byId.get(id)!;
      if (isContainer) {
        const contains =
          candidate.x <= node.x &&
          candidate.y <= node.y &&
          candidate.x + candidate.width >= node.x + node.width &&
          candidate.y + candidate.height >= node.y + node.height;

        const strictlyLarger =
          candidate.x < node.x ||
          candidate.y < node.y ||
          candidate.x + candidate.width > node.x + node.width ||
          candidate.y + candidate.height > node.y + node.height;

        if (!contains || !strictlyLarger) continue;
        const area = candidate.width * candidate.height;
        const previousArea = parent ? parent.width * parent.height : Infinity;
        if (
          !parent ||
          area < previousArea ||
          (area === previousArea && order.get(id)! > order.get(parent.id)!)
        )
          parent = candidate;
      } else if (!parent || order.get(id)! > order.get(parent.id)!) parent = candidate;
    }

    return parent ? immutableFrame({ ...node, parentId: parent.id }) : node;
  });
}

function readStoredCanvas(storage: Pick<Storage, "getItem">): string | null {
  return storage.getItem(CANVAS_STORAGE_KEY) ?? storage.getItem(LEGACY_CANVAS_STORAGE_KEY);
}

/** Clipboard validation opts out of migration; the document hook explicitly opts in. */
export function loadCanvasFrames(
  storage?: Pick<Storage, "getItem">,
  { migrateLegacy = false }: { migrateLegacy?: boolean } = {},
): CanvasFrame[] {
  try {
    const saved = readStoredCanvas(storage ?? window.localStorage);
    if (!saved) return [];
    const value: unknown = JSON.parse(saved);
    const legacy = Array.isArray(value);

    const nodes: unknown = legacy
      ? value
      : value !== null &&
          typeof value === "object" &&
          "version" in value &&
          value.version === 2 &&
          "nodes" in value
        ? value.nodes
        : undefined;

    if (!Array.isArray(nodes)) return [];
    const ids = new Set<string>();
    const frames: CanvasFrame[] = [];

    for (const item of nodes) {
      if (!isFrame(item) || ids.has(item.id)) return [];
      ids.add(item.id);
      frames.push(immutableFrame(item));
    }

    return new CanvasDocument(
      legacy && migrateLegacy ? migrateLegacyParents(frames) : frames,
    ).getFrames();
  } catch {
    return [];
  }
}

export function saveCanvasFrames(
  frames: readonly CanvasFrame[],
  storage?: Pick<Storage, "setItem">,
  theme: CanvasTheme = EMPTY_THEME,
): boolean {
  try {
    (storage ?? window.localStorage).setItem(
      CANVAS_STORAGE_KEY,
      JSON.stringify({ version: 2, nodes: frames, theme }),
    );

    return true;
  } catch {
    // Storage can be unavailable or full without making the canvas unusable.
    return false;
  }
}

export function loadCanvasTheme(storage?: Pick<Storage, "getItem">): CanvasTheme {
  try {
    const value = JSON.parse(readStoredCanvas(storage ?? window.localStorage) ?? "null");

    return value?.theme ? normalizeTheme(value.theme) : EMPTY_THEME;
  } catch {
    return EMPTY_THEME;
  }
}
