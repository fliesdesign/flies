import { hasRotation, canvasSizingLabel } from "@flies/canvas";
import { gradientCss, filterCss } from "@flies/canvas";
import { useCanvasFrame } from "@flies/canvas";
import type { CanvasCamera } from "@flies/canvas";
import type { CanvasDocument, CanvasFrame } from "@flies/canvas";
import type { FrameRect, ResizeHandle, Viewport } from "@flies/canvas";
import {
  clippingRadius,
  getClipBounds,
  getClippingAncestors,
  getVisibleSelectionFrames,
  isRectVisibleInRoundedClips,
  roundedClipsContainPoint,
  type CanvasClipBounds,
} from "@flies/canvas";
import { isCanvasRoot } from "@flies/canvas";
import { CanvasRenderNodeStore } from "@flies/canvas";
import { CanvasScene } from "@flies/canvas";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
} from "react";

import { CanvasGpuArtwork } from "./canvas-gpu-artwork";
import { CanvasGpuChrome } from "./canvas-gpu-chrome";
import { CanvasNodeAppearance, CanvasNodeContent, CanvasTextEditor } from "./canvas-node-content";
import { CanvasTransformedOutline } from "./canvas-transformed-outline";

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
  inspectHtml?: boolean;
  onRendererChange?: (renderer: "dom" | "webgpu") => void;
};

/** A camera tick changes one transform; frame components don't receive the viewport. */
function CameraWorld({ camera, children }: { camera: CanvasCamera; children: ReactNode }) {
  const world = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = world.current!;

    const update = () => {
      const { viewport } = camera.getSnapshot();
      element.style.transform = `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`;
    };

    update();

    return camera.subscribe(update);
  }, [camera]);

  return (
    <div ref={world} className="canvas-world">
      {children}
    </div>
  );
}

/** Zoom-dependent styles belong to editor chrome, never the entire artwork subtree. */
function ZoomChrome({ camera, children }: { camera: CanvasCamera; children: ReactNode }) {
  const getZoom = useCallback(() => camera.getSnapshot().viewport.zoom, [camera]);
  const zoom = useSyncExternalStore(camera.subscribe, getZoom, getZoom);

  return (
    <div
      className="canvas-zoom-chrome"
      style={{ "--canvas-inverse-zoom": 1 / zoom, "--canvas-zoom": zoom } as CSSProperties}
    >
      {children}
    </div>
  );
}

function useVisibleChildren(scene: CanvasScene, parentId?: string) {
  const getSnapshot = useCallback(() => scene.getVisibleChildren(parentId), [scene, parentId]);

  return useSyncExternalStore(scene.subscribe, getSnapshot, getSnapshot);
}

// Extensions keep receiving world coordinates; ordinary artwork renders in parent-local space.
const CustomFrameContent = memo(function CustomFrameContent({
  document,
  id,
  FrameContent,
}: {
  document: CanvasDocument;
  id: string;
  FrameContent: FrameContentComponent;
}) {
  const frame = useCanvasFrame(document, id);

  return frame ? (
    <div className="canvas-frame-content" aria-hidden="true">
      <FrameContent frame={frame} />
    </div>
  ) : null;
});

type FrameNodeProps = {
  document: CanvasDocument;
  camera: CanvasCamera;
  scene: CanvasScene;
  id: string;
  selectedIds: ReadonlySet<string>;
  editingId?: string | null;
  parentLocked?: boolean;
  onTextCommit?: SceneProps["onTextCommit"];
  onTextCancel?: SceneProps["onTextCancel"];
  FrameContent?: FrameContentComponent;
};

const FrameNode = memo(function FrameNode({
  document,
  camera,
  scene,
  id,
  selectedIds,
  editingId,
  parentLocked = false,
  onTextCommit,
  onTextCancel,
  FrameContent,
}: FrameNodeProps) {
  const renderNode = useMemo(() => new CanvasRenderNodeStore(document, id), [document, id]);

  const frame = useSyncExternalStore(
    renderNode.subscribe,
    renderNode.getSnapshot,
    renderNode.getSnapshot,
  );

  const children = useVisibleChildren(scene, id);
  if (!frame || frame.hidden) return null;
  const isFrame = frame.kind === undefined || frame.kind === "frame";
  const isGroup = frame.kind === "group";
  const isRootContainer = (isFrame || isGroup) && isCanvasRoot(document, frame);
  const locked = parentLocked || Boolean(frame.locked);
  const selected = selectedIds.has(id);

  return (
    <div
      className="canvas-frame-position"
      data-frame-id={id}
      data-node-kind={frame.kind ?? "frame"}
      data-root-container={isRootContainer || undefined}
      data-authored-shadow={frame.shadows !== undefined || undefined}
      data-node-locked={locked || undefined}
      data-selected={selected || undefined}
      data-editing={editingId === id || undefined}
      style={{
        transform: `translate(${frame.x}px, ${frame.y}px) rotate(${frame.rotation ?? 0}deg)`,
        transformOrigin: `${frame.width / 2}px ${frame.height / 2}px`,
        mixBlendMode: frame.blendMode,
        filter: filterCss(frame.filters),
        width: frame.width,
        height: frame.height,
        opacity: frame.opacity,
      }}
    >
      {editingId === id && frame.kind === "text" && !locked ? (
        <ZoomChrome camera={camera}>
          <CanvasTextEditor frame={frame} onCommit={onTextCommit} onCancel={onTextCancel} />
        </ZoomChrome>
      ) : (
        <button
          type="button"
          className={isFrame ? "canvas-frame" : "canvas-node-body"}
          aria-label={`${frame.name}, ${Math.round(frame.width)} by ${Math.round(frame.height)}`}
          aria-pressed={selected}
          disabled={locked}
          style={
            isFrame
              ? {
                  background: frame.gradient ? gradientCss(frame.gradient) : frame.fill,
                  borderRadius: frame.cornerRadius,
                }
              : undefined
          }
        >
          {!isFrame && !isGroup && <CanvasNodeContent frame={frame} />}
        </button>
      )}
      {isFrame && FrameContent && (
        <CustomFrameContent document={document} id={id} FrameContent={FrameContent} />
      )}
      {(isFrame || isGroup) && (
        <div
          className="canvas-node-children"
          data-clip-content={isFrame && frame.clipContent !== false ? true : undefined}
          style={isFrame ? { borderRadius: frame.cornerRadius } : undefined}
        >
          {children.map((childId) => (
            <FrameNode
              key={childId}
              document={document}
              camera={camera}
              scene={scene}
              id={childId}
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
      <CanvasNodeAppearance frame={frame} />
      {(isRootContainer || (selected && editingId !== id)) && (
        <ZoomChrome camera={camera}>
          {selected && editingId !== id && <span className="canvas-node-selection-border" />}
          {isRootContainer && (
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
        </ZoomChrome>
      )}
    </div>
  );
});

function VisibleFrames({ scene, ...props }: SceneProps & { scene: CanvasScene }) {
  const ids = useSyncExternalStore(scene.subscribe, scene.getSnapshot, scene.getSnapshot);
  const roots = useVisibleChildren(scene);

  const selectedIds = useMemo(
    () => new Set(props.selectedIds ?? (props.selectedId ? [props.selectedId] : EMPTY_IDS)),
    [props.selectedId, props.selectedIds],
  );

  return (
    <div className="canvas-frames" data-visible-frames={ids.length}>
      {roots.map((id) => (
        <FrameNode
          key={id}
          document={props.document}
          camera={props.camera}
          scene={scene}
          id={id}
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
  const [gpuReady, setGpuReady] = useState(false);
  const [gpuActive, setGpuActive] = useState(false);
  // A preference changed in another window must also wait for the active draft to finish.
  const allowGpu = !props.FrameContent && (!props.inspectHtml || (gpuActive && !!props.editingId));
  if (gpuReady && !allowGpu) setGpuReady(false);
  // Adjust before committing children so an asynchronous handoff cannot discard a text draft.
  if (gpuActive && (!gpuReady || !allowGpu)) setGpuActive(false);
  else if (!gpuActive && gpuReady && allowGpu && !props.editingId) setGpuActive(true);
  const useGpu = gpuReady && gpuActive && allowGpu;
  const onRendererChange = props.onRendererChange;
  useLayoutEffect(() => onRendererChange?.(useGpu ? "webgpu" : "dom"), [useGpu, onRendererChange]);
  useLayoutEffect(() => scene.connect(), [scene]);
  useLayoutEffect(
    () => scene.setPinned(props.selectedIds ?? props.selectedId ?? null),
    [scene, props.selectedId, props.selectedIds],
  );

  return (
    <>
      {allowGpu && (
        <CanvasGpuArtwork
          document={props.document}
          camera={props.camera}
          editingId={props.editingId}
          onReady={setGpuReady}
        />
      )}
      {useGpu ? (
        <>
          <CanvasGpuChrome {...props} scene={scene} />
          {!props.editingId &&
            (props.selectedIds?.length ?? 0) > 1 &&
            props.selectedIds?.map((id) => (
              <CanvasOutline key={id} document={props.document} camera={props.camera} id={id} />
            ))}
        </>
      ) : (
        <CameraWorld camera={props.camera}>
          <VisibleFrames {...props} scene={scene} />
        </CameraWorld>
      )}
    </>
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
  if (frames.some((frame) => hasRotation(document, frame)))
    return <CanvasTransformedOutline document={document} frames={frames} viewport={viewport} />;
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
  const label = single
    ? canvasSizingLabel(single)
    : `${Math.round(bounds.width)} × ${Math.round(bounds.height)}`;

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
      {showDimensions && <span className="canvas-dimensions">{label}</span>}
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
  if (hasRotation(document, frame))
    return (
      <CanvasTransformedOutline
        document={document}
        frames={[frame]}
        viewport={viewport}
        selection={selection}
      />
    );
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
