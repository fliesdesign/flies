import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import { useCanvasFrame } from "@/hooks/use-canvas-document";
import type { CanvasCamera } from "@/lib/canvas-camera";
import type { CanvasDocument, CanvasFrame } from "@/lib/canvas-document";
import type { FrameRect, ResizeHandle, Viewport } from "@/lib/canvas-geometry";
import {
  clippingRadius,
  getClipBounds,
  getClippingAncestors,
  getVisibleSelectionFrames,
  isRectVisibleInRoundedClips,
  roundedClipsContainPoint,
  type CanvasClipBounds,
} from "@/lib/canvas-outline";
import { CanvasScene } from "@/lib/canvas-scene";

import { CanvasNodeContent, CanvasTextEditor } from "./canvas-node-content";

const HANDLES: ResizeHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const HANDLE_NAMES: Record<ResizeHandle, string> = {
  nw: "top left",
  n: "top",
  ne: "top right",
  e: "right",
  se: "bottom right",
  s: "bottom",
  sw: "bottom left",
  w: "left",
};
const EMPTY_IDS: readonly string[] = [];

export type FrameContentComponent = ComponentType<{ frame: CanvasFrame }>;

type SceneProps = {
  document: CanvasDocument;
  camera: CanvasCamera;
  selectedId?: string | null;
  selectedIds?: readonly string[];
  editingId?: string | null;
  onTextCommit?: (id: string, text: string, height: number) => void;
  onTextCancel?: (id: string) => void;
  FrameContent?: FrameContentComponent;
};

/** A camera tick changes one transform; frame components don't receive the viewport. */
function CameraWorld({ camera, children }: { camera: CanvasCamera; children: ReactNode }) {
  const { viewport } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );
  const style = {
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`,
    "--canvas-inverse-zoom": 1 / viewport.zoom,
    "--canvas-zoom": viewport.zoom,
  } as CSSProperties;
  return (
    <div className="canvas-world" style={style}>
      {children}
    </div>
  );
}

function useChildren(document: CanvasDocument, parentId?: string) {
  const getSnapshot = useCallback(() => document.getChildren(parentId), [document, parentId]);
  return useSyncExternalStore(document.subscribe, getSnapshot, getSnapshot);
}

type FrameNodeProps = {
  document: CanvasDocument;
  id: string;
  visibleIds: ReadonlySet<string>;
  selectedIds: ReadonlySet<string>;
  editingId?: string | null;
  parentLocked?: boolean;
  onTextCommit?: SceneProps["onTextCommit"];
  onTextCancel?: SceneProps["onTextCancel"];
  FrameContent?: FrameContentComponent;
};

const FrameNode = memo(function FrameNode({
  document,
  id,
  visibleIds,
  selectedIds,
  editingId,
  parentLocked = false,
  onTextCommit,
  onTextCancel,
  FrameContent,
}: FrameNodeProps) {
  const frame = useCanvasFrame(document, id);
  const parent = useCanvasFrame(document, frame?.parentId ?? null);
  const children = useChildren(document, id);
  if (!frame || frame.hidden) return null;
  const isFrame = frame.kind === undefined || frame.kind === "frame";
  const isGroup = frame.kind === "group";
  const locked = parentLocked || Boolean(frame.locked);
  const selected = selectedIds.has(id);
  return (
    <div
      className="canvas-frame-position"
      data-frame-id={id}
      data-node-kind={frame.kind ?? "frame"}
      data-node-locked={locked || undefined}
      data-selected={selected || undefined}
      style={{
        transform: `translate3d(${frame.x - (parent?.x ?? 0)}px, ${frame.y - (parent?.y ?? 0)}px, 0)`,
        width: frame.width,
        height: frame.height,
        opacity: frame.opacity,
      }}
    >
      {editingId === id && frame.kind === "text" && !locked ? (
        <CanvasTextEditor frame={frame} onCommit={onTextCommit} onCancel={onTextCancel} />
      ) : (
        <button
          type="button"
          className={isFrame ? "canvas-frame" : "canvas-node-body"}
          aria-label={`${frame.name}, ${Math.round(frame.width)} by ${Math.round(frame.height)}`}
          aria-pressed={selected}
          disabled={locked}
          style={
            isFrame ? { backgroundColor: frame.fill, borderRadius: frame.cornerRadius } : undefined
          }
        >
          {!isFrame && !isGroup && <CanvasNodeContent frame={frame} />}
        </button>
      )}
      {isFrame && FrameContent && (
        <div className="canvas-frame-content" aria-hidden="true">
          <FrameContent frame={frame} />
        </div>
      )}
      {(isFrame || isGroup) && (
        <div
          className="canvas-node-children"
          data-clip-content={isFrame && frame.clipContent !== false ? true : undefined}
          style={isFrame ? { borderRadius: frame.cornerRadius } : undefined}
        >
          {children
            .filter((childId) => visibleIds.has(childId))
            .map((childId) => (
              <FrameNode
                key={childId}
                document={document}
                id={childId}
                visibleIds={visibleIds}
                selectedIds={selectedIds}
                editingId={editingId}
                parentLocked={locked}
                onTextCommit={onTextCommit}
                onTextCancel={onTextCancel}
                FrameContent={FrameContent}
              />
            ))}
        </div>
      )}
      {(isFrame || isGroup) && (
        <button
          type="button"
          className="canvas-frame-label"
          tabIndex={-1}
          aria-label={`Select ${frame.name}`}
          disabled={locked}
        >
          {frame.name}
        </button>
      )}
    </div>
  );
});

function VisibleFrames({ scene, ...props }: SceneProps & { scene: CanvasScene }) {
  const ids = useSyncExternalStore(scene.subscribe, scene.getSnapshot, scene.getSnapshot);
  const roots = useChildren(props.document);
  const visibleIds = useMemo(() => new Set(ids), [ids]);
  const selectedIds = useMemo(
    () => new Set(props.selectedIds ?? (props.selectedId ? [props.selectedId] : EMPTY_IDS)),
    [props.selectedId, props.selectedIds],
  );
  return (
    <div className="canvas-frames" data-visible-frames={ids.length}>
      {roots
        .filter((id) => visibleIds.has(id))
        .map((id) => (
          <FrameNode
            key={id}
            document={props.document}
            id={id}
            visibleIds={visibleIds}
            selectedIds={selectedIds}
            editingId={props.editingId}
            onTextCommit={props.onTextCommit}
            onTextCancel={props.onTextCancel}
            FrameContent={props.FrameContent}
          />
        ))}
    </div>
  );
}

export const CanvasFrames = memo(function CanvasFrames(props: SceneProps) {
  const [scene] = useState(() => new CanvasScene(props.document, props.camera));
  useLayoutEffect(() => scene.connect(), [scene]);
  useLayoutEffect(
    () => scene.setPinned(props.selectedIds ?? props.selectedId ?? null),
    [scene, props.selectedId, props.selectedIds],
  );
  return (
    <CameraWorld camera={props.camera}>
      <VisibleFrames {...props} scene={scene} />
    </CameraWorld>
  );
});

/** A small external store tracks only selected nodes and their ancestor geometry. */
class OutlineStore {
  private snapshot: readonly CanvasFrame[] = [];

  constructor(
    private readonly document: CanvasDocument,
    private readonly ids: readonly string[],
  ) {}

  getSnapshot = () => {
    const nodes = new Map<string, CanvasFrame>();
    for (const id of this.ids) {
      let node = this.document.getFrame(id);
      while (node && !nodes.has(node.id)) {
        nodes.set(node.id, node);
        node = node.parentId ? this.document.getFrame(node.parentId) : undefined;
      }
    }
    const next = [...nodes.values()];
    if (next.length !== this.snapshot.length || next.some((node, i) => node !== this.snapshot[i]))
      this.snapshot = next;
    return this.snapshot;
  };

  subscribe = (listener: () => void) => {
    let subscriptions: (() => void)[] = [];
    const subscribePath = () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      subscriptions = this.getSnapshot().map((node) =>
        this.document.subscribeFrame(node.id, listener),
      );
    };
    subscribePath();
    // Reparenting changes the subscribed ancestor path without changing the selection.
    const unsubscribeDocument = this.document.subscribe(() => {
      subscribePath();
      listener();
    });
    return () => {
      unsubscribeDocument();
      subscriptions.forEach((unsubscribe) => unsubscribe());
    };
  };
}

function useOutlineFrames(document: CanvasDocument, ids: readonly string[]) {
  const store = useMemo(() => new OutlineStore(document, ids), [document, ids]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

function screenStyle(bounds: FrameRect, viewport: Viewport) {
  return {
    transform: `translate3d(${viewport.x + bounds.x * viewport.zoom}px, ${viewport.y + bounds.y * viewport.zoom}px, 0)`,
    width: bounds.width * viewport.zoom,
    height: bounds.height * viewport.zoom,
  };
}

function clippedOutline(frame: FrameRect, clip: CanvasClipBounds, zoom: number) {
  // Negative one pixel preserves the outline on edges not constrained by clipping.
  const inset = (amount: number) => (amount > 0 ? amount * zoom : -1);
  return `inset(${inset(clip.top - frame.y)}px ${inset(frame.x + frame.width - clip.right)}px ${inset(frame.y + frame.height - clip.bottom)}px ${inset(clip.left - frame.x)}px)`;
}

/** Each nested paint wrapper intersects another rounded ancestor without scaling its stroke. */
function OutlinePaint({
  bounds,
  ancestors,
  zoom,
}: {
  bounds: FrameRect;
  ancestors: readonly CanvasFrame[];
  zoom: number;
}) {
  let paint = (
    <div
      className="canvas-selection-border"
      style={{ clipPath: clippedOutline(bounds, getClipBounds(ancestors), zoom) }}
    />
  );
  for (const ancestor of ancestors) {
    const radius = clippingRadius(ancestor);
    if (!radius) continue;
    const top = (ancestor.y - bounds.y) * zoom;
    const right = (bounds.x + bounds.width - ancestor.x - ancestor.width) * zoom;
    const bottom = (bounds.y + bounds.height - ancestor.y - ancestor.height) * zoom;
    const left = (ancestor.x - bounds.x) * zoom;
    paint = (
      <div
        style={{
          position: "absolute",
          inset: 0,
          clipPath: `inset(${top}px ${right}px ${bottom}px ${left}px round ${radius * zoom}px)`,
        }}
      >
        {paint}
      </div>
    );
  }
  return paint;
}

function handlePosition(bounds: FrameRect, handle: ResizeHandle) {
  return {
    x: bounds.x + bounds.width * (handle.includes("w") ? 0 : handle.includes("e") ? 1 : 0.5),
    y: bounds.y + bounds.height * (handle.includes("n") ? 0 : handle.includes("s") ? 1 : 0.5),
  };
}

function isLocked(document: CanvasDocument, frame: CanvasFrame) {
  let node: CanvasFrame | undefined = frame;
  const visited = new Set<string>();
  while (node && !visited.has(node.id)) {
    if (node.locked) return true;
    visited.add(node.id);
    node = node.parentId ? document.getFrame(node.parentId) : undefined;
  }
  return false;
}

export const CanvasSelectionOutline = memo(function CanvasSelectionOutline({
  document,
  camera,
  ids,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  ids: readonly string[];
}) {
  useOutlineFrames(document, ids);
  const { viewport } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );
  const frames = getVisibleSelectionFrames(document, ids);
  if (frames.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const frame of frames) {
    left = Math.min(left, frame.x);
    top = Math.min(top, frame.y);
    right = Math.max(right, frame.x + frame.width);
    bottom = Math.max(bottom, frame.y + frame.height);
  }
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  const locked = frames.some((frame) => isLocked(document, frame));
  const single = frames.length === 1 ? frames[0] : undefined;
  const name = single?.name ?? `${frames.length} objects`;
  const ancestorPaths = frames.map((frame) => getClippingAncestors(document, frame));
  const sharedClips = ancestorPaths[0].filter((ancestor) =>
    ancestorPaths.every((path) => path.some((item) => item.id === ancestor.id)),
  );
  const clip = getClipBounds(sharedClips);
  // The badge sits 12 screen pixels below the selection and is 20 pixels tall.
  const label = `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;
  const halfBadgeWidth = (label.length * 7 + 14) / (2 * viewport.zoom);
  const badgeCenter = bounds.x + bounds.width / 2;
  const showDimensions =
    badgeCenter - halfBadgeWidth >= clip.left &&
    badgeCenter + halfBadgeWidth <= clip.right &&
    bounds.y + bounds.height + 12 / viewport.zoom >= clip.top &&
    bounds.y + bounds.height + 32 / viewport.zoom <= clip.bottom &&
    [badgeCenter - halfBadgeWidth, badgeCenter + halfBadgeWidth].every((x) =>
      [12, 32].every((offset) =>
        roundedClipsContainPoint(sharedClips, {
          x,
          y: bounds.y + bounds.height + offset / viewport.zoom,
        }),
      ),
    );
  return (
    <div
      className="canvas-selection"
      style={screenStyle(bounds, viewport)}
      data-frame-id={single?.id}
    >
      <OutlinePaint bounds={bounds} ancestors={sharedClips} zoom={viewport.zoom} />
      {!locked &&
        HANDLES.filter((handle) =>
          roundedClipsContainPoint(sharedClips, handlePosition(bounds, handle)),
        ).map((handle) => (
          <button
            type="button"
            key={handle}
            className={`canvas-resize canvas-resize-${handle}`}
            data-handle={handle}
            aria-label={`Resize ${name} from ${HANDLE_NAMES[handle]}`}
            title={`Resize ${HANDLE_NAMES[handle]}`}
          />
        ))}
      {showDimensions && (
        <span className="canvas-dimensions">
          {Math.round(bounds.width)} <span>×</span> {Math.round(bounds.height)}
        </span>
      )}
    </div>
  );
});

export const CanvasOutline = memo(function CanvasOutline({
  document,
  camera,
  id,
  selection = false,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  id: string | null;
  selection?: boolean;
}) {
  const ids = useMemo(() => (id ? [id] : EMPTY_IDS), [id]);
  useOutlineFrames(document, ids);
  const { viewport } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );
  const frame = id ? document.getFrame(id) : undefined;
  if (!frame || document.isHidden(frame.id) || isLocked(document, frame)) return null;
  const ancestors = getClippingAncestors(document, frame);
  if (!isRectVisibleInRoundedClips(frame, ancestors)) return null;
  if (selection) return <CanvasSelectionOutline document={document} camera={camera} ids={ids} />;
  return (
    <div
      className="canvas-hover"
      style={{
        ...screenStyle(frame, viewport),
        outline: "none",
      }}
      aria-hidden="true"
    >
      <OutlinePaint bounds={frame} ancestors={ancestors} zoom={viewport.zoom} />
    </div>
  );
});
