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

function clippedOutline(document: CanvasDocument, frame: CanvasFrame, zoom: number) {
  let left = frame.x;
  let top = frame.y;
  let right = frame.x + frame.width;
  let bottom = frame.y + frame.height;
  let parent = frame.parentId ? document.getFrame(frame.parentId) : undefined;
  const visited = new Set([frame.id]);
  while (parent && !visited.has(parent.id)) {
    visited.add(parent.id);
    if ((parent.kind === undefined || parent.kind === "frame") && parent.clipContent !== false) {
      left = Math.max(left, parent.x);
      top = Math.max(top, parent.y);
      right = Math.min(right, parent.x + parent.width);
      bottom = Math.min(bottom, parent.y + parent.height);
    }
    parent = parent.parentId ? document.getFrame(parent.parentId) : undefined;
  }
  // Negative one pixel preserves an outline on edges not constrained by clipping.
  return `inset(${top === frame.y ? -1 : (top - frame.y) * zoom}px ${right === frame.x + frame.width ? -1 : (frame.x + frame.width - right) * zoom}px ${bottom === frame.y + frame.height ? -1 : (frame.y + frame.height - bottom) * zoom}px ${left === frame.x ? -1 : (left - frame.x) * zoom}px)`;
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
  const frames = document
    .getRootIds(ids)
    .filter((id) => !document.isHidden(id))
    .map((id) => document.getFrame(id))
    .filter((frame): frame is CanvasFrame => Boolean(frame));
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
  return (
    <div
      className="canvas-selection"
      style={screenStyle(bounds, viewport)}
      data-frame-id={single?.id}
    >
      <div
        className="canvas-selection-border"
        style={single ? { clipPath: clippedOutline(document, single, viewport.zoom) } : undefined}
      />
      {!locked &&
        HANDLES.map((handle) => (
          <button
            type="button"
            key={handle}
            className={`canvas-resize canvas-resize-${handle}`}
            data-handle={handle}
            aria-label={`Resize ${name} from ${HANDLE_NAMES[handle]}`}
            title={`Resize ${HANDLE_NAMES[handle]}`}
          />
        ))}
      <span className="canvas-dimensions">
        {Math.round(bounds.width)} <span>×</span> {Math.round(bounds.height)}
      </span>
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
  if (selection) return <CanvasSelectionOutline document={document} camera={camera} ids={ids} />;
  return (
    <div
      className="canvas-hover"
      style={{
        ...screenStyle(frame, viewport),
        clipPath: clippedOutline(document, frame, viewport.zoom),
      }}
      aria-hidden="true"
    />
  );
});
