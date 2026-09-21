import { localTransform, matrixCss, worldBounds, filterCss } from "@flies/canvas";
import { useCanvasFrame } from "@flies/canvas";
import type { CanvasCamera } from "@flies/canvas";
import type { CanvasDocument, CanvasFrame } from "@flies/canvas";
import { clippingRadius } from "@flies/canvas";
import { isCanvasRoot } from "@flies/canvas";
import type { CanvasScene } from "@flies/canvas";
import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

import { CanvasTextEditor } from "./canvas-node-content";
import "./canvas-webgl-chrome.css";

export type CanvasWebglChromeProps = {
  document: CanvasDocument;
  camera: CanvasCamera;
  scene: CanvasScene;
  selectedId?: string | null;
  selectedIds?: readonly string[];
  editingId?: string | null;
  onTextCommit?: (id: string, text: string, height: number) => void;
  onTextCancel?: (id: string) => void;
};

const RootLabel = memo(function RootLabel({
  document,
  camera,
  id,
  selected,
}: Pick<CanvasWebglChromeProps, "document" | "camera"> & { id: string; selected: boolean }) {
  const frame = useCanvasFrame(document, id);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!frame) return;

    const update = () => {
      if (!element.current) return;
      const { viewport } = camera.getSnapshot();
      const bounds = worldBounds(document, frame);
      element.current.style.transform = `translate3d(${viewport.x + bounds.x * viewport.zoom}px, ${viewport.y + bounds.y * viewport.zoom}px, 0)`;
      element.current.style.width = `${bounds.width * viewport.zoom}px`;
    };

    update();

    return camera.subscribe(update);
  }, [camera, document, frame]);

  if (
    !frame ||
    frame.hidden ||
    !isCanvasRoot(document, frame) ||
    (frame.kind !== undefined && frame.kind !== "frame" && frame.kind !== "group")
  )
    return null;

  return (
    <div
      ref={element}
      className="canvas-webgl-label-position"
      data-frame-id={id}
      data-node-locked={frame.locked || undefined}
      data-selected={selected || undefined}
      style={{ opacity: frame.opacity }}
    >
      <button
        type="button"
        className="canvas-frame-label"
        tabIndex={-1}
        aria-label={`Select ${frame.name}`}
        disabled={frame.locked}
      >
        {frame.name}
      </button>
    </div>
  );
});

/** Editing subscribes only to the active text and its ancestor chain. */
class EditorPathStore {
  private snapshot: readonly CanvasFrame[] = [];

  constructor(
    private readonly document: CanvasDocument,
    private readonly id: string,
  ) {}

  getSnapshot = () => {
    const path: CanvasFrame[] = [];
    let frame = this.document.getFrame(this.id);

    while (frame) {
      path.push(frame);
      frame = frame.parentId ? this.document.getFrame(frame.parentId) : undefined;
    }

    if (
      path.length !== this.snapshot.length ||
      path.some((node, index) => node !== this.snapshot[index])
    )
      this.snapshot = path;

    return this.snapshot;
  };

  subscribe = (listener: () => void) => {
    let subscriptions: (() => void)[] = [];

    const subscribePath = () => {
      subscriptions.forEach((unsubscribe) => unsubscribe());
      subscriptions = this.getSnapshot().map((frame) =>
        this.document.subscribeFrame(frame.id, listener),
      );
    };

    subscribePath();

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

const ActiveEditor = memo(function ActiveEditor({
  document,
  camera,
  id,
  onTextCommit,
  onTextCancel,
}: Omit<CanvasWebglChromeProps, "scene" | "editingId"> & { id: string }) {
  const store = useMemo(() => new EditorPathStore(document, id), [document, id]);
  const path = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const frame = path[0];
  const editable = frame?.kind === "text" && !path.some((node) => node.hidden || node.locked);
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!frame || !editable) return;

    const update = () => {
      if (!element.current) return;
      const { viewport } = camera.getSnapshot();
      element.current.style.transform = `translate3d(${viewport.x + frame.x * viewport.zoom}px, ${viewport.y + frame.y * viewport.zoom}px, 0) scale(${viewport.zoom})`;
      element.current.style.setProperty("--canvas-inverse-zoom", String(1 / viewport.zoom));
    };

    update();

    return camera.subscribe(update);
  }, [camera, frame, editable]);

  if (frame?.kind !== "text" || !editable) return null;
  if (path.some((node) => node.rotation))
    return (
      <RotatedTextEditor
        path={path}
        camera={camera}
        onTextCommit={onTextCommit}
        onTextCancel={onTextCancel}
      />
    );
  const opacity = path.reduce((value, node) => value * (node.opacity ?? 1), 1);

  let editor: ReactNode = (
    <CanvasTextEditor frame={frame} onCommit={onTextCommit} onCancel={onTextCancel} />
  );

  for (let depth = 1; depth < path.length; depth++) {
    const ancestor = path[depth];
    const clips = (!ancestor.kind || ancestor.kind === "frame") && ancestor.clipContent !== false;

    const style: CSSProperties = {
      clipPath: clips
        ? `inset(${ancestor.y - frame.y}px ${frame.x + frame.width - ancestor.x - ancestor.width}px ${frame.y + frame.height - ancestor.y - ancestor.height}px ${ancestor.x - frame.x}px round ${clippingRadius(ancestor)}px)`
        : undefined,
    };

    // Keep ancestor slots mounted when clipping toggles or a parent changes at the
    // same depth. Replacing a wrapper would also replace the textarea's live draft.
    editor = (
      <div key={`ancestor-${depth}`} className="canvas-webgl-editor-clip" style={style}>
        {editor}
      </div>
    );
  }

  return (
    <div
      ref={element}
      className="canvas-webgl-editor-position"
      data-frame-id={id}
      data-node-kind="text"
      data-editing="true"
      style={{ width: frame.width, height: frame.height, opacity }}
    >
      {editor}
    </div>
  );
});

/** GPU artwork keeps only root labels and the active input in the DOM. */
export const CanvasWebglChrome = memo(function CanvasWebglChrome({
  scene,
  editingId,
  selectedId,
  selectedIds,
  ...props
}: CanvasWebglChromeProps) {
  const getRoots = useCallback(() => scene.getVisibleChildren(), [scene]);
  const roots = useSyncExternalStore(scene.subscribe, getRoots, getRoots);

  const selected = useMemo(
    () => new Set(selectedIds ?? (selectedId ? [selectedId] : [])),
    [selectedId, selectedIds],
  );

  return (
    <div className="canvas-webgl-chrome">
      {roots.map((id) => (
        <RootLabel
          key={id}
          document={props.document}
          camera={props.camera}
          id={id}
          selected={selected.has(id)}
        />
      ))}
      {editingId && <ActiveEditor key={editingId} {...props} id={editingId} />}
    </div>
  );
});

function RotatedTextEditor({
  path,
  camera,
  onTextCommit,
  onTextCancel,
}: {
  path: readonly CanvasFrame[];
  camera: CanvasCamera;
  onTextCommit: CanvasWebglChromeProps["onTextCommit"];
  onTextCancel: CanvasWebglChromeProps["onTextCancel"];
}) {
  const { viewport } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );

  const frame = path[0];
  if (frame.kind !== "text") return null;

  let editor: ReactNode = (
    <CanvasTextEditor frame={frame} onCommit={onTextCommit} onCancel={onTextCancel} />
  );

  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    const clips = i > 0 && (!node.kind || node.kind === "frame") && node.clipContent !== false;
    editor = (
      <div
        key={node.id}
        data-frame-id={i === 0 ? node.id : undefined}
        data-editing={i === 0 ? "true" : undefined}
        data-node-kind={i === 0 ? "text" : undefined}
        style={{
          position: "absolute",
          width: node.width,
          height: node.height,
          transformOrigin: "0 0",
          transform: matrixCss(localTransform(node, path[i + 1])),
          opacity: node.opacity,
          filter: filterCss(node.filters),
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: clips ? "hidden" : "visible",
            borderRadius: clips ? clippingRadius(node) : undefined,
          }}
        >
          {editor}
        </div>
      </div>
    );
  }

  return (
    <div
      style={
        {
          position: "absolute",
          inset: 0,
          transformOrigin: "0 0",
          transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`,
          "--canvas-inverse-zoom": 1 / viewport.zoom,
        } as CSSProperties
      }
    >
      {editor}
    </div>
  );
}
