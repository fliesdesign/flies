import type { CanvasTextRun } from "@flies/canvas";
import {
  themeCss,
  worldTransform,
  inverseMatrix,
  transformVector,
  worldBounds,
  frameSource,
  hasRotation,
  moveSelectionWorld,
  pointBounds,
  scaleSelectionWorld,
} from "@flies/canvas";
import { type CanvasTheme, EMPTY_THEME } from "@flies/canvas";
import { ensureCanvasFonts } from "@flies/canvas";
import { useCanvasDocument, useCanvasSnapshot, type CanvasFrame } from "@flies/canvas";
import { arrangeSelection, type CanvasArrangeAction } from "@flies/canvas";
import { CanvasAutoPan, pointerWorldDelta } from "@flies/canvas";
import { CanvasCamera, LatestValueFrameBatch } from "@flies/canvas";
import {
  readCanvasClipboard,
  usesNativeCanvasClipboard,
  type CanvasClipboard,
} from "@flies/canvas";
import type { CanvasDocument } from "@flies/canvas";
import {
  fitViewport,
  resizeFrame,
  resizeFrameProportionally,
  screenToWorld,
  zoomAtPoint,
  type Point,
  type FrameRect,
  type ResizeHandle,
  type Viewport,
} from "@flies/canvas";
import {
  AlignmentGuideTargets,
  CanvasGuides,
  type AlignmentGuideIndex,
  type AlignmentSnapState,
} from "@flies/canvas";
import { CanvasHitTester } from "@flies/canvas";
import { canvasPage, nextPageName, type CanvasPage } from "@flies/canvas";
import { readCanvasImage } from "@flies/canvas";
import {
  getCanvasInspection,
  getCanvasInspectionServerSnapshot,
  subscribeCanvasInspection,
} from "@flies/canvas";
import { finalizeCanvasMove } from "@flies/canvas";
import {
  CANVAS_CLIPBOARD_MIME,
  encodeCanvasClipboard,
  readCanvasClipboardMime,
  decodeCanvasClipboard,
  pasteCanvasClipboard,
  selectionBounds,
  moveSelection,
  marqueeSelection,
  resizeSelection,
  reparentSelection,
  adoptFrameContents,
  groupSelection,
  ungroupSelection,
} from "@flies/canvas";
import { getVisibleSelectionFrames } from "@flies/canvas";
import {
  changeCanvasProperty,
  type CanvasProperty,
  type CanvasPropertyOptions,
} from "@flies/canvas";
import { viewportBounds } from "@flies/canvas";
import { penFromPoints, rectFromPoints, type CanvasTool } from "@flies/canvas";
import { detectSourceFormat } from "@flies/html/source";
import { PanelLeftOpenIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ClipboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuCheckboxItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  CANVAS_CODE_FORMATS,
  exportCanvasCodeWithAssets,
  type CanvasCodeFormat,
} from "@/lib/canvas-code-export";
import { importPaperSnapshot, isPaperSnapshot } from "@/lib/paper-snapshot";
import { loadSnapshotImage } from "@/lib/paper-snapshot-assets";
import type { RealtimeFile } from "@/lib/realtime";

import { CanvasAgentActivity } from "./canvas-agent-activity";
import { CanvasFileMenu, type CanvasFileActions } from "./canvas-file-menu";
import { CanvasAlignmentGuides } from "./canvas-guides";
import { CanvasLayers } from "./canvas-layers";
import { CanvasLayoutOverlay, type LayoutHandle } from "./canvas-layout-overlay";
import { CanvasNodeContent, measureCanvasTextHeight } from "./canvas-node-content";
import { CanvasPresence } from "./canvas-presence";
import { CanvasProperties } from "./canvas-properties";
import {
  CanvasFrames,
  CanvasOutline,
  CanvasSelectionOutline,
  type FrameContentComponent,
} from "./canvas-scene";
import { CanvasToolbar } from "./canvas-toolbar";
import { CanvasVectorEditing } from "./canvas-vector-editing";
import "./design-canvas.css";

export type CanvasControls = {
  getSelection: () => readonly string[];
  document: CanvasDocument;
  camera: CanvasCamera;
  select: (id: string | null) => void;
  preview: (frame: CanvasFrame) => void;
  previewMany: (frames: readonly CanvasFrame[]) => void;
  setPanelsOpen: (open: boolean) => void;
  /** Switch the canvas being edited; agents and the sidebar share this one path. */
  showPage: (pageId: string) => void;
  addPage: (name?: string) => string;
  removePage: (pageId: string) => void;
  flushPreview: () => void;
  prepare: () => void;
  /** A live text draft must finish before a remote snapshot can replace its input. */
  hasTextDraft: () => boolean;
  surface: HTMLDivElement;
};

type DesignCanvasProps = {
  collaborators?: ReactNode;
  realtime?: RealtimeFile;
  fileActions?: CanvasFileActions;
  initialFrames?: CanvasFrame[];
  initialTheme?: CanvasTheme;
  persist?: boolean;
  FrameContent?: FrameContentComponent;
  onReady?: (controls: CanvasControls | null) => void;
};

type Interaction = {
  kind: "pan" | "move" | "resize" | "draw" | "marquee" | "spacing";
  pointerId: number;
  start: Point;
  viewport: Viewport;
  frame?: CanvasFrame;
  frames?: CanvasFrame[];
  geometryFrames?: readonly CanvasFrame[];
  geometrySource?: ReturnType<typeof frameSource>;
  transformed?: boolean;
  axisLock?: "x" | "y";
  snapState?: AlignmentSnapState;
  spacing?: {
    property: LayoutHandle["property"];
    axis: "x" | "y";
    sign: number;
    value: number;
    inverse: ReturnType<typeof worldTransform>;
  };
  roots?: string[];
  bounds?: FrameRect;
  initialSelection?: string[];
  candidates?: CanvasFrame[];
  collapseTo?: string;
  handle?: ResizeHandle;
  worldStart?: Point;
  draft?: CanvasFrame;
  points?: Point[];
  moved?: boolean;
  guides?: AlignmentGuideIndex;
  guideTargets?: AlignmentGuideTargets;
  guideViewport?: Viewport;
  modifiers?: { shiftKey: boolean; altKey: boolean };
  requestedMove?: CanvasFrame[];
};

function isEditingTarget(target: EventTarget | null) {
  return (
    target instanceof Element && !!target.closest("textarea, input, select, [contenteditable=true]")
  );
}

function isNodeLocked(document: CanvasDocument, id: string): boolean {
  let node = document.getFrame(id);

  while (node) {
    if (node.locked) return true;
    node = node.parentId ? document.getFrame(node.parentId) : undefined;
  }

  return false;
}

function DrawingPreview({ frame, camera }: { frame: CanvasFrame; camera: CanvasCamera }) {
  const { viewport } = useSyncExternalStore(camera.subscribe, camera.getSnapshot);

  return (
    <div
      className="canvas-draft"
      data-kind={frame.kind ?? "frame"}
      aria-hidden="true"
      style={{
        transform: `translate3d(${viewport.x + frame.x * viewport.zoom}px, ${viewport.y + frame.y * viewport.zoom}px, 0) scale(${viewport.zoom})`,
        width: frame.width,
        height: frame.height,
      }}
    >
      <CanvasNodeContent frame={frame} />
    </div>
  );
}

export function DesignCanvas({
  collaborators,
  initialFrames,
  initialTheme,
  fileActions,
  realtime,
  persist = false,
  FrameContent,
  onReady,
}: DesignCanvasProps = {}) {
  const [notice, setNotice] = useState("");

  const saveFailed = useCallback(
    () => setNotice("Could not save this canvas. Browser storage may be full."),
    [],
  );

  const document = useCanvasDocument({
    initialFrames,
    initialTheme,
    persist,
    onSaveError: saveFailed,
  });

  const snapshot = useCanvasSnapshot(document);
  const { ids, canUndo, canRedo } = snapshot;
  const scene = document.getSceneIds();
  const sceneIds = useMemo(() => new Set(scene), [scene]);
  // Recomputed per snapshot, which a page add, rename, delete or switch always bumps.
  const pages = document.getPageIds().map((id) => document.getFrame(id) as CanvasPage);
  const activePageId = document.getActivePageId();
  const { undo, redo } = document;
  const [camera] = useState(() => new CanvasCamera());
  const [rendererBackend, setRendererBackend] = useState<"dom" | "webgl2">("dom");

  const inspectHtml = useSyncExternalStore(
    subscribeCanvasInspection,
    getCanvasInspection,
    getCanvasInspectionServerSnapshot,
  );

  const hitTester = useMemo(() => new CanvasHitTester(document), [document]);
  useEffect(() => hitTester.connect(), [hitTester]);
  const [guides] = useState(() => new CanvasGuides());
  const [autoPan] = useState(() => new CanvasAutoPan());
  const surfaceRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const pendingImportsRef = useRef(0);

  const [layersOpen, setLayersOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 760,
  );

  // The inspector stays open in the editor. Headless render harnesses can hide chrome.
  const [propertiesOpen, setPropertiesOpen] = useState(true);

  const setPanelsOpen = useCallback((open: boolean) => {
    setLayersOpen(open);
    setPropertiesOpen(open);
  }, []);

  const propertyPreviewRef = useRef<{ frames: CanvasFrame[]; ids: readonly string[] } | null>(null);
  const layerAnchorRef = useRef<string | null>(null);
  const reopenLayersRef = useRef<HTMLButtonElement>(null);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [editingId, setEditingId] = useState<string | null>(null);
  const textDraftRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    textDraftRef.current = editingId;
  }, [editingId]);
  const [importing, setImporting] = useState(false);
  const [draft, setDraft] = useState<CanvasFrame | null>(null);
  const [draftBatch] = useState(() => new LatestValueFrameBatch<CanvasFrame>(setDraft));
  const interactionRef = useRef<Interaction | null>(null);

  const [previewBatch] = useState(
    () => new LatestValueFrameBatch<readonly CanvasFrame[]>(document.previewMany),
  );

  const previewFrame = useCallback(
    (frame: CanvasFrame) => previewBatch.schedule([frame]),
    [previewBatch],
  );

  const menuPointRef = useRef<Point>({ x: 0, y: 0 });
  const spaceRef = useRef(false);
  const [selection, setSelection] = useState<string[]>([]);
  const [vectorEditingId, setVectorEditingId] = useState<string | null>(null);
  const selectOne = useCallback((id: string | null) => setSelection(id ? [id] : []), []);

  const propertyIds = useMemo(
    () =>
      snapshot.ids.length ? document.getRootIds(selection.filter((id) => sceneIds.has(id))) : [],
    [document, selection, snapshot, sceneIds],
  );

  const selectedIds = useMemo(
    () =>
      snapshot.ids.length
        ? document.getRootIds(
            selection.filter((id) => sceneIds.has(id) && !isNodeLocked(document, id)),
          )
        : [],
    [document, selection, snapshot, sceneIds],
  );

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null;
  const [storedGroupScope, setGroupScope] = useState<string | null>(null);

  const groupScope =
    storedGroupScope &&
    sceneIds.has(storedGroupScope) &&
    document.getFrame(storedGroupScope)?.kind === "group"
      ? storedGroupScope
      : null;

  const [marquee, setMarquee] = useState<FrameRect | null>(null);

  const [marqueeBatch] = useState(
    () =>
      new LatestValueFrameBatch<{ rect: FrameRect; ids: string[] }>((value) => {
        setMarquee(value.rect);
        setSelection(value.ids);
      }),
  );

  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const clipboardRef = useRef<string | null>(null);
  const pasteRef = useRef({ payload: "", count: 0 });
  const readingClipboardRef = useRef(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [activeSpacing, setActiveSpacing] = useState<string | null>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const selected = selectedId ? document.getFrame(selectedId) : undefined;
  const changeViewport = camera.setViewport;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);

    return () => clearTimeout(timer);
  }, [notice]);

  // Camera motion changes the hit target even when the pointer stays still.
  useEffect(() => camera.subscribe(() => setHoveredId(null)), [camera]);

  useEffect(
    () => () => {
      previewBatch.cancel();
      draftBatch.cancel();
      marqueeBatch.cancel();
      autoPan.stop();
      camera.cancel();
      guides.clear();
      document.endGesture(true);
    },
    [document, camera, previewBatch, draftBatch, guides, marqueeBatch, autoPan],
  );

  const localPoint = useCallback((clientX: number, clientY: number): Point => {
    const bounds = surfaceRef.current?.getBoundingClientRect();

    return { x: clientX - (bounds?.left ?? 0), y: clientY - (bounds?.top ?? 0) };
  }, []);

  const addNode = useCallback(
    (node: CanvasFrame) => {
      const pageId = document.getActivePageId();

      const rooted =
        node.parentId === undefined && pageId !== undefined ? { ...node, parentId: pageId } : node;

      let all = [...document.getFrames(), rooted];

      const placed =
        reparentSelection(all, [node.id], {
          requireContainment: !node.kind || node.kind === "frame",
        }).find((item) => item.id === node.id) ?? rooted;

      all = all.map((item) => (item.id === node.id ? placed : item));
      const children = !node.kind || node.kind === "frame" ? adoptFrameContents(all, node.id) : [];
      document.transact({ add: [placed], update: children });
    },
    [document],
  );

  const finishInteraction = useCallback(
    (cancel = false) => {
      const active = interactionRef.current;
      if (!active) return;
      setActiveSpacing(null);
      autoPan.stop();
      guides.clear();
      interactionRef.current = null;

      if (cancel) {
        previewBatch.cancel();
        changeViewport(active.viewport);
      } else {
        previewBatch.flush();
      }

      if (active.kind === "draw") {
        draftBatch.cancel();
        setDraft(null);

        if (!cancel && active.draft) {
          let next = active.draft;
          if (!active.moved && (next.kind === "frame" || next.kind === "rectangle"))
            next = {
              ...next,
              width: next.kind === "frame" ? 400 : 160,
              height: next.kind === "frame" ? 300 : 120,
            };
          addNode(next);
          selectOne(next.id);
          if (next.kind !== "pen") setTool("select");
        }
      } else if (active.kind === "marquee") {
        if (cancel) {
          marqueeBatch.cancel();
          setSelection(active.initialSelection ?? []);
        } else marqueeBatch.flush();
        setMarquee(null);
      } else if (active.kind !== "pan") {
        const parents =
          !cancel && active.kind === "move" && active.moved
            ? finalizeCanvasMove(
                document.getFrames(),
                active.roots ?? [],
                active.requestedMove ?? [],
              )
            : undefined;

        document.endGesture(cancel, parents);
        if (!cancel && !active.moved && active.collapseTo) selectOne(active.collapseTo);
      }

      camera.flush();
      const surface = surfaceRef.current;
      if (surface?.hasPointerCapture(active.pointerId))
        surface.releasePointerCapture(active.pointerId);
      setIsPanning(false);
    },
    [
      changeViewport,
      document,
      camera,
      previewBatch,
      draftBatch,
      guides,
      marqueeBatch,
      addNode,
      selectOne,
      autoPan,
    ],
  );

  const selectLayer = useCallback(
    (
      id: string,
      modifiers: { additive: boolean; range: boolean; visibleIds: readonly string[] },
    ) => {
      if (!document.getFrame(id)) return;
      finishInteraction(true);
      setEditingId(null);
      setTool("select");
      setHoveredId(null);
      const node = document.getFrame(id)!;
      setGroupScope(node.parentId ?? null);
      setSelection((current) => {
        const anchor =
          layerAnchorRef.current && current.includes(layerAnchorRef.current)
            ? layerAnchorRef.current
            : current[current.length - 1];

        const start = anchor ? modifiers.visibleIds.indexOf(anchor) : -1;
        const end = modifiers.visibleIds.indexOf(id);

        if (modifiers.range && start !== -1 && end !== -1) {
          const range = modifiers.visibleIds.slice(Math.min(start, end), Math.max(start, end) + 1);

          return modifiers.additive ? [...new Set([...current, ...range])] : range;
        }

        return modifiers.additive
          ? current.includes(id)
            ? current.filter((item) => item !== id)
            : [...current, id]
          : [id];
      });
      if (!modifiers.range) layerAnchorRef.current = id;
    },
    [document, finishInteraction],
  );

  const renameLayer = useCallback(
    (id: string, name: string) => {
      const node = document.getFrame(id);
      if (node && name.trim()) document.update({ ...node, name: name.trim() });
    },
    [document],
  );

  const toggleLayerLock = useCallback(
    (id: string) => {
      const node = document.getFrame(id);
      if (!node) return;
      finishInteraction(true);
      document.update({ ...node, locked: !node.locked });
      setHoveredId(null);
    },
    [document, finishInteraction],
  );

  const toggleLayerHidden = useCallback(
    (id: string) => {
      const node = document.getFrame(id);
      if (!node) return;
      finishInteraction(true);
      setEditingId(null);
      document.update({ ...node, hidden: !node.hidden });
      setHoveredId(null);
    },
    [document, finishInteraction],
  );

  const moveLayers = useCallback(
    (
      layerIds: readonly string[],
      targetId: string | null,
      placement: "before" | "after" | "inside",
    ) => {
      finishInteraction(true);
      setEditingId(null);
      if (document.moveLayers(layerIds, targetId, placement)) setSelection([...layerIds]);
      setHoveredId(null);
    },
    [document, finishInteraction],
  );

  /** Switching canvases ends any gesture, drops the old selection and frames the new page. */
  const showPage = useCallback(
    (pageId: string) => {
      finishInteraction(true);
      setEditingId(null);
      if (!document.setActivePage(pageId)) return;
      setSelection([]);
      setHoveredId(null);
      const content = document.getSceneFrames().filter((node) => !document.isHidden(node.id));
      const { size } = camera.getCurrent();
      changeViewport(content.length ? fitViewport(content, size) : { x: 0, y: 0, zoom: 1 });
    },
    [camera, changeViewport, document, finishInteraction, setSelection],
  );

  /** Layers keep their world position; the page they leave is no longer showing them. */
  const moveLayersToPage = useCallback(
    (layerIds: readonly string[], pageId: string) => {
      finishInteraction(true);
      setEditingId(null);
      if (!document.moveLayers(layerIds, pageId, "inside")) return;
      setSelection([]);
      setHoveredId(null);
    },
    [document, finishInteraction, setSelection],
  );

  const addPage = useCallback(
    (name?: string) => {
      const page = canvasPage(name?.trim() || nextPageName(document.getFrames()));
      if (!document.add(page)) throw new Error("This page could not be created.");
      showPage(page.id);

      return page.id;
    },
    [document, showPage],
  );

  const renamePage = useCallback(
    (id: string, name: string) => {
      const page = document.getFrame(id);
      if (page?.kind === "page" && name.trim()) document.update({ ...page, name: name.trim() });
    },
    [document],
  );

  const removePage = useCallback(
    (id: string) => {
      const ordered = document.getPageIds();
      // A document always keeps one canvas; the last page can only be emptied, not deleted.
      if (ordered.length < 2 || !ordered.includes(id)) return;
      const fallback = ordered[ordered.indexOf(id) + 1] ?? ordered[ordered.indexOf(id) - 1];
      finishInteraction(true);
      setEditingId(null);
      setSelection([]);
      setHoveredId(null);
      document.removeMany([id]);
      showPage(fallback);
    },
    [document, finishInteraction, setSelection, showPage],
  );

  const collapseLayers = useCallback(() => {
    setLayersOpen(false);
    setHoveredId(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let lastKey = "";

    const load = () => {
      const texts = document.getSceneFrames().filter((node) => node.kind === "text");

      const key = texts
        .map(
          (node) =>
            `${node.fontFamily}:${node.fontWeight}:${node.fontStyle}:${node.text}:${JSON.stringify(node.textRuns)}`,
        )
        .join("|");

      if (key === lastKey) return;
      lastKey = key;
      void ensureCanvasFonts(texts).catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
      });
    };

    load();
    const unsubscribe = document.subscribeChanges(load);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [document]);

  const changeProperty = useCallback(
    async (
      property: CanvasProperty,
      value: string | number | boolean,
      options?: CanvasPropertyOptions,
    ) => {
      finishInteraction(true);

      if (["fontFamily", "fontWeight", "fontStyle"].includes(property)) {
        const before = propertyIds.map((id) => document.getFrame(id));

        const updates = changeCanvasProperty(
          document.getFrames(),
          propertyIds,
          property,
          value,
          (node) => node.height,
          options,
        );

        try {
          await ensureCanvasFonts(updates.filter((node) => node.kind === "text"));
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));

          return;
        }

        if (before.some((node, index) => document.getFrame(propertyIds[index]) !== node)) return;
      }

      document.updateMany(
        changeCanvasProperty(
          document.getFrames(),
          propertyIds,
          property,
          value,
          measureCanvasTextHeight,
          options,
        ),
      );
      setHoveredId(null);
    },
    [document, finishInteraction, propertyIds],
  );

  const endPropertyPreview = useCallback(
    (cancel: boolean) => {
      if (!propertyPreviewRef.current) return;
      if (cancel) previewBatch.cancel();
      else previewBatch.flush();
      propertyPreviewRef.current = null;
      document.endGesture(cancel);
    },
    [document, previewBatch],
  );

  const startPropertyPreview = useCallback(() => {
    finishInteraction(true);
    endPropertyPreview(true);
    const subtree = document.getDescendantIds(propertyIds);
    const related = new Set(subtree);

    for (const id of propertyIds) {
      let parent = document.getFrame(id)?.parentId;

      while (parent && !related.has(parent)) {
        related.add(parent);
        parent = document.getFrame(parent)?.parentId;
      }
    }

    propertyPreviewRef.current = {
      frames: [...related].map((id) => document.getFrame(id)!),
      ids: propertyIds,
    };
    document.beginGesture(subtree);
    setHoveredId(null);
  }, [document, propertyIds, finishInteraction, endPropertyPreview]);

  const previewProperty = useCallback(
    (
      property: CanvasProperty,
      value: string | number | boolean,
      options?: CanvasPropertyOptions,
    ) => {
      if (!propertyPreviewRef.current) startPropertyPreview();
      const active = propertyPreviewRef.current;
      if (!active) return;
      previewBatch.schedule(
        changeCanvasProperty(
          active.frames,
          active.ids,
          property,
          value,
          measureCanvasTextHeight,
          options,
        ),
      );
    },
    [previewBatch, startPropertyPreview],
  );

  const prepareFileAction = useCallback(() => {
    const active = window.document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    finishInteraction(true);
    endPropertyPreview(false);
  }, [finishInteraction, endPropertyPreview]);

  const mcpSelection = useRef(selectedIds);
  useEffect(() => {
    mcpSelection.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    if (surfaceRef.current)
      onReady?.({
        getSelection: () => mcpSelection.current,
        prepare: prepareFileAction,
        hasTextDraft: () => textDraftRef.current !== null,
        document,
        camera,
        select: selectOne,
        preview: previewFrame,
        previewMany: previewBatch.schedule,
        setPanelsOpen,
        showPage,
        addPage,
        removePage,
        flushPreview: previewBatch.flush,
        surface: surfaceRef.current,
      });

    return () => onReady?.(null);
  }, [
    prepareFileAction,
    addPage,
    document,
    camera,
    onReady,
    removePage,
    showPage,
    previewFrame,
    previewBatch,
    selectOne,
    setPanelsOpen,
  ]);

  const openProject = useCallback(
    (nodes: CanvasFrame[], theme: CanvasTheme = EMPTY_THEME) => {
      finishInteraction(true);
      endPropertyPreview(true);
      setEditingId(null);
      document.replaceAll(nodes, theme);
      setSelection([]);
      setGroupScope(null);
      setHoveredId(null);
      setTool("select");
      camera.setViewport(
        fitViewport(
          nodes.filter((node) => !document.isHidden(node.id)),
          camera.getCurrent().size,
        ),
      );
      camera.flush();
      surfaceRef.current?.focus({ preventScroll: true });
    },
    [camera, document, finishInteraction, endPropertyPreview],
  );

  const arrangeFromProperties = useCallback(
    (action: CanvasArrangeAction) => {
      finishInteraction(true);
      if (propertyIds.some((id) => isNodeLocked(document, id))) return;
      document.updateMany(arrangeSelection(document.getFrames(), propertyIds, action));
    },
    [document, finishInteraction, propertyIds],
  );

  const fitTextHeight = useCallback(() => {
    finishInteraction(true);
    if (propertyIds.some((id) => isNodeLocked(document, id))) return;
    document.updateMany(
      propertyIds.flatMap((id) => {
        const node = document.getFrame(id);

        return node?.kind === "text"
          ? [
              {
                ...node,
                height: measureCanvasTextHeight(node),
                ...(node.heightSizing && { heightSizing: "fixed" as const }),
              },
            ]
          : [];
      }),
    );
  }, [document, finishInteraction, propertyIds]);

  useEffect(() => {
    if (!layersOpen) reopenLayersRef.current?.focus({ preventScroll: true });
  }, [layersOpen]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    let initialized = false;

    const observer = new ResizeObserver(([entry]) => {
      const nextSize = { x: entry.contentRect.width, y: entry.contentRect.height };
      camera.setSize(nextSize);

      if (!initialized) {
        initialized = true;
        if (document.getSceneIds().length)
          changeViewport(
            fitViewport(
              document.getSceneFrames().filter((node) => !document.isHidden(node.id)),
              nextSize,
            ),
          );
      }
    });

    observer.observe(surface);
    surface.focus({ preventScroll: true });

    return () => observer.disconnect();
  }, [changeViewport, document, camera]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    function wheel(event: WheelEvent) {
      if (isEditingTarget(event.target)) return;
      event.preventDefault();
      if (interactionRef.current || menuOpen) return;
      const view = camera.getCurrent().viewport;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface!.clientHeight : 1;

      if (event.ctrlKey || event.metaKey) {
        changeViewport(
          zoomAtPoint(
            view,
            localPoint(event.clientX, event.clientY),
            view.zoom * Math.exp(-event.deltaY * unit * 0.01),
          ),
        );
      } else {
        changeViewport({
          ...view,
          x: view.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit,
          y: view.y - (event.shiftKey ? 0 : event.deltaY) * unit,
        });
      }
    }

    surface.addEventListener("wheel", wheel, { passive: false });

    return () => surface.removeEventListener("wheel", wheel);
  }, [changeViewport, localPoint, menuOpen, camera]);

  useEffect(() => {
    function releaseSpace(event: globalThis.KeyboardEvent) {
      const active = interactionRef.current;

      if (active) {
        active.modifiers = { shiftKey: event.shiftKey, altKey: event.altKey };
        if (!event.shiftKey) active.axisLock = undefined;
        if (event.altKey) active.snapState = {};
      }

      if (event.code === "Space") {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    }

    function blur() {
      spaceRef.current = false;
      setSpaceHeld(false);
      setHoveredId(null);
      finishInteraction();
    }

    window.addEventListener("keyup", releaseSpace);
    window.addEventListener("blur", blur);

    return () => {
      window.removeEventListener("keyup", releaseSpace);
      window.removeEventListener("blur", blur);
    };
  }, [finishInteraction]);

  function nextName(prefix: string) {
    let number = 0;

    for (const frame of document.getSceneFrames()) {
      if (frame.name.startsWith(`${prefix} `)) {
        const suffix = Number(frame.name.slice(prefix.length + 1));
        if (Number.isFinite(suffix)) number = Math.max(number, suffix);
      }
    }

    return `${prefix} ${number + 1}`;
  }

  function createFrame(point: Point) {
    const frame: CanvasFrame = {
      id: crypto.randomUUID(),
      name: nextName("Frame"),
      kind: "frame",
      x: Math.round(point.x),
      y: Math.round(point.y),
      width: 400,
      height: 300,
    };

    addNode(frame);
    selectOne(frame.id);
    setTool("select");
  }

  function createText(point: Point, text = "Text", edit = true) {
    let height = 40;
    const page = surfaceRef.current?.ownerDocument;

    if (!edit && page) {
      const measure = page.createElement("span");
      measure.className = "canvas-text-content";
      measure.style.cssText =
        "position:absolute;visibility:hidden;width:240px;height:auto;font-size:24px;left:-10000px;";
      measure.textContent = text;
      page.body.append(measure);
      height = Math.max(40, Math.ceil(measure.getBoundingClientRect().height));
      measure.remove();
    }

    const onFrame = document
      .getSceneFrames()
      .filter((node) => !document.isHidden(node.id))
      .some(
        (frame) =>
          (!frame.kind ||
            frame.kind === "frame" ||
            frame.kind === "rectangle" ||
            frame.kind === "image" ||
            frame.kind === "svg") &&
          point.x >= frame.x &&
          point.x <= frame.x + frame.width &&
          point.y >= frame.y &&
          point.y <= frame.y + frame.height,
      );

    const frame: CanvasFrame = {
      id: crypto.randomUUID(),
      name: nextName("Text"),
      kind: "text",
      text,
      fontSize: 24,
      color: onFrame ? "#212121" : "#EDEDED",
      x: Math.round(point.x),
      y: Math.round(point.y),
      width: 240,
      height,
    };

    addNode(frame);
    selectOne(frame.id);
    if (edit) setEditingId(frame.id);
    setTool("select");
  }

  const commitText = useCallback(
    (id: string, text: string, height: number, textRuns?: readonly CanvasTextRun[]) => {
      const frame = document.getFrame(id);

      if (frame?.kind === "text") {
        if (!text.trim()) document.remove(id);
        else
          document.update({
            ...frame,
            text,
            textRuns: textRuns?.length ? textRuns : undefined,
            height: Math.max(1, Math.ceil(height)),
          });
      }

      setEditingId(null);
    },
    [document],
  );

  const cancelText = useCallback(() => setEditingId(null), []);

  async function importImages(files: File[], point?: Point) {
    if (!files.length) return;
    pendingImportsRef.current++;
    setImporting(true);
    setNotice("");

    try {
      const results = await Promise.allSettled(files.map(readCanvasImage));
      if (!mountedRef.current) return;
      finishInteraction(true);
      const { viewport, size } = camera.getCurrent();
      const center = screenToWorld({ x: size.x / 2, y: size.y / 2 }, viewport);
      let error = "";
      const additions: CanvasFrame[] = [];

      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
          error =
            result.reason instanceof Error ? result.reason.message : "Could not open this image.";
          continue;
        }

        const image = result.value;
        const scale = Math.min(1, 640 / image.width, 640 / image.height);
        const width = Math.max(1, Math.round(image.width * scale));
        const height = Math.max(1, Math.round(image.height * scale));

        const frame: CanvasFrame = {
          id: crypto.randomUUID(),
          name: image.name,
          kind: image.kind,
          src: image.src,
          x: Math.round((point?.x ?? center.x - width / 2) + index * 24),
          y: Math.round((point?.y ?? center.y - height / 2) + index * 24),
          width,
          height,
        };

        additions.push(frame);
      }

      if (additions.length) {
        const importedIds = additions.map((node) => node.id);

        const placed = new Map(
          reparentSelection([...document.getSceneFrames(), ...additions], importedIds).map(
            (node) => [node.id, node],
          ),
        );

        document.addMany(additions.map((node) => placed.get(node.id) ?? node));
        setSelection(importedIds);
      }

      if (error) setNotice(error);
      setHoveredId(null);
      setTool("select");
      surfaceRef.current?.focus({ preventScroll: true });
    } finally {
      pendingImportsRef.current--;
      if (mountedRef.current) setImporting(pendingImportsRef.current > 0);
    }
  }

  function chooseTool(next: CanvasTool) {
    finishInteraction(true);
    setHoveredId(null);

    if (next === "image") {
      fileInputRef.current?.click();

      return;
    }

    setTool(next);
    if (next !== "select" && next !== "pan") selectOne(null);
    surfaceRef.current?.focus({ preventScroll: true });
  }

  function focusCanvas() {
    surfaceRef.current?.focus({ preventScroll: true });
  }

  function deleteFrame() {
    if (!selectedIds.length) return;
    focusCanvas();
    document.removeMany(selectedIds);
    setSelection([]);
  }

  function duplicateFrame() {
    const payload = encodeCanvasClipboard(document.getFrames(), selectedIds);
    const decoded = payload && decodeCanvasClipboard(payload);
    if (!decoded) return;
    const copy = pasteCanvasClipboard(decoded, { x: 24, y: 24 }, undefined, document.getFrames());

    const parents = new Map(
      copy.selection.map((id, index) => [id, document.getFrame(selectedIds[index])?.parentId]),
    );

    document.addMany(
      copy.nodes.map((node) =>
        parents.has(node.id) ? { ...node, parentId: parents.get(node.id) } : node,
      ),
    );
    setSelection(copy.selection);
    focusCanvas();
  }

  function copySelection(event: ClipboardEvent<HTMLElement>, cut = false) {
    if (isEditingTarget(event.target) || interactionRef.current) return;
    const payload = encodeCanvasClipboard(document.getFrames(), selectedIds);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData(CANVAS_CLIPBOARD_MIME, payload);
    event.clipboardData.setData("text/plain", payload);
    clipboardRef.current = payload;
    pasteRef.current = { payload, count: 0 };
    if (cut) deleteFrame();
  }

  async function copyFromMenu(cut = false) {
    const payload = encodeCanvasClipboard(document.getFrames(), selectedIds);
    if (!payload) return;

    try {
      await navigator.clipboard.writeText(payload);
      clipboardRef.current = payload;
      pasteRef.current = { payload, count: 0 };
      if (cut) deleteFrame();
    } catch {
      setNotice("Use Ctrl/Cmd + C or X to copy or cut from this browser.");
    }

    focusCanvas();
  }

  async function copyAs(format: CanvasCodeFormat) {
    try {
      const code = await exportCanvasCodeWithAssets(document.getFrames(), selectedIds, format);
      await navigator.clipboard.writeText(code);
      setNotice(`Copied as ${format}.`);
    } catch (error) {
      setNotice(`Could not copy code. ${error instanceof Error ? error.message : String(error)}`);
    }

    focusCanvas();
  }

  function pasteObjects(payload: string, point?: Point, inPlace = false) {
    finishInteraction(true);
    const decoded = decodeCanvasClipboard(payload);
    if (!decoded) return false;

    const bounds = selectionBounds(
      decoded,
      decoded.map((node) => node.id),
    );

    if (!bounds) return false;
    const count = pasteRef.current.payload === payload ? pasteRef.current.count + 1 : 1;
    pasteRef.current = { payload, count };

    const targetFrame =
      !point &&
      selected &&
      (!selected.kind || selected.kind === "frame") &&
      !decoded.some((node) => !node.parentId && (!node.kind || node.kind === "frame"))
        ? selected
        : undefined;

    const offset = inPlace
      ? { x: 0, y: 0 }
      : point
        ? { x: point.x - bounds.x, y: point.y - bounds.y }
        : targetFrame
          ? { x: targetFrame.x + 24 - bounds.x, y: targetFrame.y + 24 - bounds.y }
          : { x: count * 24, y: count * 24 };

    const copy = pasteCanvasClipboard(decoded, offset, undefined, document.getFrames());
    let nodes = copy.nodes;

    if (inPlace) {
      const sources = decoded.filter((node) => !node.parentId);

      const parents = new Map(
        copy.selection.map((id, index) => [
          id,
          sceneIds.has(sources[index].id)
            ? document.getFrame(sources[index].id)?.parentId
            : document.getActivePageId(),
        ]),
      );

      nodes = nodes.map((node) =>
        parents.has(node.id) ? { ...node, parentId: parents.get(node.id) } : node,
      );
    } else if (targetFrame) {
      const roots = new Set(copy.selection);
      nodes = nodes.map((node) =>
        roots.has(node.id) ? { ...node, parentId: targetFrame.id } : node,
      );
    } else {
      const placed = new Map(
        reparentSelection([...document.getSceneFrames(), ...nodes], copy.selection, {
          requireContainment: true,
        }).map((node) => [node.id, node]),
      );

      nodes = nodes.map((node) => placed.get(node.id) ?? node);
    }

    document.addMany(nodes);
    setSelection(copy.selection);
    setTool("select");
    focusCanvas();

    return true;
  }

  function pasteText(text: string, point?: Point) {
    if (!text.trim()) return;
    const { viewport, size } = camera.getCurrent();
    createText(point ?? screenToWorld({ x: size.x / 2, y: size.y / 2 }, viewport), text, false);
  }

  async function pasteMarkup(source: string, point?: Point, isSnapshot = false) {
    finishInteraction(true);
    const { viewport, size } = camera.getCurrent();
    const center = screenToWorld({ x: size.x / 2, y: size.y / 2 }, viewport);
    pendingImportsRef.current++;
    setImporting(true);
    setNotice("");

    try {
      const { nodes, warnings } = isSnapshot
        ? await importPaperSnapshot(source)
        : await (
            await import("@flies/html")
          ).importSource(source, {
            x: 0,
            y: 0,
            width: 800,
            loadImage: loadSnapshotImage,
            css: document.getTheme().tokens.length ? themeCss(document.getTheme()) : undefined,
          });

      if (!mountedRef.current) return;
      const roots = nodes.filter((node) => !node.parentId).map((node) => node.id);
      const geometry = frameSource(nodes);

      const bounds = selectionBounds(
        nodes.map((node) => ({ ...node, ...worldBounds(geometry, node) })),
        roots,
      );

      if (!bounds) throw new Error("This content has no visible layers.");

      const offset = {
        x: (point?.x ?? center.x - bounds.width / 2) - bounds.x,
        y: (point?.y ?? center.y - bounds.height / 2) - bounds.y,
      };

      finishInteraction(true);
      document.addMany(
        nodes.map((node) => Object.assign(node, { x: node.x + offset.x, y: node.y + offset.y })),
      );
      setSelection(roots);
      setHoveredId(null);
      setTool("select");
      setNotice(warnings.length ? `Pasted. ${warnings.join(" ")}` : "");
      focusCanvas();
    } catch (error) {
      if (mountedRef.current)
        setNotice(
          error instanceof Error ? error.message : "Could not paste this HTML or React snippet.",
        );
    } finally {
      pendingImportsRef.current--;
      if (mountedRef.current) setImporting(pendingImportsRef.current > 0);
    }
  }

  async function pasteClipboard(data: CanvasClipboard, point?: Point, inPlace = false) {
    const payload = data.internal || data.text;
    if (payload && pasteObjects(payload, inPlace ? undefined : point, inPlace)) return;

    if (isPaperSnapshot(data.html)) {
      await pasteMarkup(data.html, point, true);

      return;
    }

    const svgText = [data.text, data.html].find((value) =>
      /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(value),
    );

    if (svgText) {
      await importImages([new File([svgText], "Pasted SVG.svg", { type: "image/svg+xml" })], point);

      return;
    }

    // Code editors often supply a highlighted HTML wrapper alongside the actual source.
    if (detectSourceFormat(data.text)) {
      await pasteMarkup(data.text, point);

      return;
    }

    if (data.images.length) {
      await importImages(data.images, point);

      return;
    }

    if (data.html.trim()) {
      await pasteMarkup(data.html, point);

      return;
    }

    if (data.text.trim()) pasteText(data.text, point);
    else setNotice("Copy HTML, React/JSX, text, an image or canvas layers, then paste.");
  }

  async function pasteFromClipboard(point?: Point, inPlace = false) {
    if (readingClipboardRef.current) return;
    readingClipboardRef.current = true;
    setNotice("");

    try {
      const data = await readCanvasClipboard();
      if (mountedRef.current) await pasteClipboard(data, point, inPlace);
    } catch (error) {
      if (!mountedRef.current) return;
      if (usesNativeCanvasClipboard())
        setNotice(
          `Could not read the clipboard. ${error instanceof Error ? error.message : String(error)}`,
        );
      else if (clipboardRef.current)
        pasteObjects(clipboardRef.current, inPlace ? undefined : point, inPlace);
      else setNotice("Use Ctrl/Cmd + V to paste from the clipboard.");
    } finally {
      readingClipboardRef.current = false;
    }
  }

  function pasteFromMenu(inPlace = false) {
    return pasteFromClipboard({ ...menuPointRef.current }, inPlace);
  }

  function groupObjects(asFrame = false) {
    const plan = groupSelection(document.getFrames(), selectedIds, {
      id: crypto.randomUUID(),
      name: nextName(asFrame ? "Frame" : "Group"),
    });

    if (!plan) return;

    const upsert = asFrame
      ? plan.upsert.map((node) =>
          node.id === plan.selection[0]
            ? {
                ...node,
                kind: "frame" as const,
                width: Math.max(40, node.width),
                height: Math.max(40, node.height),
                clipContent: true,
              }
            : node,
        )
      : plan.upsert;

    document.transact({
      add: upsert.filter((node) => !document.getFrame(node.id)),
      update: upsert.filter((node) => document.getFrame(node.id)),
      remove: plan.remove,
    });
    setSelection(plan.selection);
    focusCanvas();
  }

  function ungroupObjects() {
    const plan = ungroupSelection(document.getFrames(), selectedIds);
    if (!plan) return;
    document.transact({ update: plan.upsert, remove: plan.remove });
    setSelection(plan.selection);
    setGroupScope(null);
    focusCanvas();
  }

  function arrangeObjects(action: CanvasArrangeAction) {
    document.updateMany(arrangeSelection(document.getFrames(), selectedIds, action));
    focusCanvas();
  }

  function lockSelection() {
    document.updateMany(selectedIds.map((id) => ({ ...document.getFrame(id)!, locked: true })));
    setSelection([]);
    focusCanvas();
  }

  function unlockAll() {
    const updates: CanvasFrame[] = [];
    for (const node of document.getSceneFrames())
      if (node.locked) updates.push({ ...node, locked: false });
    document.updateMany(updates);
    focusCanvas();
  }

  function resolveHit(target: Element | null, deep = false, point?: Point): string | undefined {
    const id =
      target?.closest<HTMLElement>("[data-frame-id]")?.dataset.frameId ??
      (rendererBackend === "webgl2" && point
        ? hitTester.hit(screenToWorld(point, camera.getCurrent().viewport))
        : undefined);

    if (!id || isNodeLocked(document, id)) return;
    let result = id;
    let node = document.getFrame(id);

    if (!deep)
      while (node?.parentId) {
        const parent = document.getFrame(node.parentId);
        if (parent?.id === groupScope) break;
        if (parent?.kind === "group") result = parent.id;
        node = parent;
      }

    return result;
  }

  function startSpacingInteraction(event: PointerEvent<HTMLButtonElement>, handle: LayoutHandle) {
    // Hand navigation keeps working when it starts over a spacing handle.
    if (event.button === 1 || spaceRef.current || tool === "pan") return;
    event.stopPropagation();
    if (event.button !== 0 || event.ctrlKey || menuOpen || !selectedId) return;
    event.preventDefault();
    finishInteraction(true);
    endPropertyPreview(true);
    const frame = document.getFrame(selectedId);
    if (
      !frame ||
      (frame.kind && frame.kind !== "frame") ||
      !frame.layout ||
      isNodeLocked(document, frame.id)
    )
      return;
    const descendants = document.getDescendantIds([frame.id]);
    const related = new Set(descendants);
    let parent = frame.parentId;

    while (parent && !related.has(parent)) {
      related.add(parent);
      parent = document.getFrame(parent)?.parentId;
    }

    const start = localPoint(event.clientX, event.clientY);
    const viewport = camera.getCurrent().viewport;
    interactionRef.current = {
      kind: "spacing",
      pointerId: event.pointerId,
      start,
      viewport,
      worldStart: screenToWorld(start, viewport),
      frame,
      frames: [...related].map((id) => document.getFrame(id)!),
      roots: [frame.id],
      spacing: {
        property: handle.property,
        axis: handle.axis,
        sign: handle.sign,
        value: handle.value,
        inverse: inverseMatrix(worldTransform(document, frame)),
      },
    };
    document.beginGesture(descendants);
    setActiveSpacing(handle.key);
    setHoveredId(null);
    surfaceRef.current?.focus({ preventScroll: true });
    surfaceRef.current?.setPointerCapture(event.pointerId);
  }

  function startInteraction(event: PointerEvent<HTMLDivElement>) {
    if (
      menuOpen ||
      interactionRef.current ||
      (event.button !== 0 && event.button !== 1) ||
      (event.button === 0 && event.ctrlKey)
    )
      return;
    const target = event.target as HTMLElement;
    const start = localPoint(event.clientX, event.clientY);
    const frameId = resolveHit(target, event.metaKey, start);
    const frame = frameId ? document.getFrame(frameId) : undefined;

    const handle = target.closest<HTMLElement>("[data-handle]")?.dataset.handle as
      | ResizeHandle
      | undefined;

    const view = camera.getCurrent().viewport;
    const worldStart = screenToWorld(start, view);
    const hand = event.button === 1 || spaceRef.current || tool === "pan";
    setHoveredId(null);
    if (event.pointerType !== "touch") event.preventDefault();
    surfaceRef.current?.focus({ preventScroll: true });

    if (!hand && tool === "text") {
      createText(worldStart);

      return;
    }

    if (!hand && (tool === "frame" || tool === "rectangle" || tool === "pen")) {
      const base = {
        id: crypto.randomUUID(),
        name: nextName(tool === "frame" ? "Frame" : tool === "pen" ? "Pen" : "Rectangle"),
        x: Math.round(worldStart.x),
        y: Math.round(worldStart.y),
        width: 1,
        height: 1,
      };

      let drawing: CanvasFrame;

      if (tool === "pen") {
        drawing = {
          ...base,
          kind: "pen",
          ...penFromPoints([worldStart])!,
          stroke: "#5AA7FF",
          strokeWidth: 3,
        };
      } else if (tool === "rectangle") {
        drawing = { ...base, kind: "rectangle", fill: "#D9D9D9" };
      } else {
        drawing = { ...base, kind: "frame", width: 40, height: 40 };
      }

      selectOne(null);
      interactionRef.current = {
        kind: "draw",
        pointerId: event.pointerId,
        start,
        viewport: view,
        worldStart,
        draft: drawing,
        points: tool === "pen" ? [worldStart] : undefined,
      };
      setDraft(drawing);
      event.currentTarget.setPointerCapture(event.pointerId);

      return;
    }

    if (!hand && !handle && event.shiftKey && frame) {
      setSelection(
        selectedIds.includes(frame.id)
          ? selectedIds.filter((id) => id !== frame.id)
          : [...selectedIds, frame.id],
      );

      return;
    }

    const roots = (
      handle
        ? getVisibleSelectionFrames(document, selectedIds).map((node) => node.id)
        : frame
          ? selectedIds.includes(frame.id)
            ? selectedIds
            : [frame.id]
          : []
    ).filter((id) => !document.isHidden(id));

    const all = document.getFrames();
    const frames = document.getDescendantIds(roots).map((id) => document.getFrame(id)!);
    const geometrySource = frameSource(all);
    const transformed = roots.some((id) => hasRotation(geometrySource, document.getFrame(id)!));

    const bounds =
      transformed && roots.length
        ? pointBounds(
            roots.flatMap((id) => {
              const b = worldBounds(geometrySource, document.getFrame(id)!);

              return [
                { x: b.x, y: b.y },
                { x: b.x + b.width, y: b.y + b.height },
              ];
            }),
          )
        : (selectionBounds(frames, roots) ?? undefined);

    const kind = hand ? "pan" : handle && roots.length ? "resize" : frame ? "move" : "marquee";

    const guideTargets =
      bounds && (kind === "move" || kind === "resize")
        ? new AlignmentGuideTargets(document, new Set(frames.map((node) => node.id)))
        : undefined;

    if (kind === "marquee") {
      if (!event.shiftKey) setSelection([]);
      setGroupScope(null);
    } else if (!hand) setSelection([...roots]);
    interactionRef.current = {
      kind,
      pointerId: event.pointerId,
      start,
      worldStart,
      viewport: view,
      frame,
      handle,
      frames,
      geometryFrames: all,
      geometrySource,
      transformed,
      snapState: {},
      roots: [...roots],
      bounds,
      initialSelection: [...selectedIds],
      candidates:
        kind === "marquee"
          ? document
              .getSceneFrames()
              .filter((node) => !isNodeLocked(document, node.id) && !document.isHidden(node.id))
          : undefined,
      collapseTo: kind === "move" && roots.length > 1 ? frame?.id : undefined,
      guideTargets,
      guideViewport: view,
      guides: guideTargets?.inViewport(viewportBounds(view, camera.getCurrent().size, 0)),
    };
    if (kind === "move" || kind === "resize") document.beginGesture(frames.map((node) => node.id));
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(hand);
  }

  function moveInteraction(event: PointerEvent<HTMLDivElement>) {
    const active = interactionRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const point = localPoint(event.clientX, event.clientY);
    const modifiers = { shiftKey: event.shiftKey, altKey: event.altKey };
    active.modifiers = modifiers;

    const samples =
      active.kind === "draw" && active.draft?.kind === "pen"
        ? (event.nativeEvent.getCoalescedEvents?.() ?? []).map((sample) =>
            localPoint(sample.clientX, sample.clientY),
          )
        : [];

    updateInteraction(active, point, modifiers, samples);

    if (
      active.moved &&
      (active.kind === "move" || active.kind === "resize" || active.kind === "marquee")
    ) {
      autoPan.update(point, camera.getCurrent().size, (delta) => {
        if (interactionRef.current !== active) {
          autoPan.stop();

          return;
        }

        const view = camera.getCurrent().viewport;
        changeViewport({ ...view, x: view.x + delta.x, y: view.y + delta.y });
        updateInteraction(active, point, active.modifiers ?? modifiers);
        // The camera, objects and guides must publish in the same animation frame.
        previewBatch.flush();
        marqueeBatch.flush();
        guides.flush();
        camera.flush();
      });
    }
  }

  function updateInteraction(
    active: Interaction,
    point: Point,
    modifiers: { shiftKey: boolean; altKey: boolean },
    samples: readonly Point[] = [],
  ) {
    const view = camera.getCurrent().viewport;
    const delta = { x: point.x - active.start.x, y: point.y - active.start.y };

    if (active.kind === "draw" && active.draft && active.worldStart) {
      const world = screenToWorld(point, active.viewport);
      active.moved ||= Math.hypot(delta.x, delta.y) >= 3;

      if (active.draft.kind === "pen" && active.points) {
        for (const sample of samples) {
          const next = screenToWorld(sample, active.viewport);
          const last = active.points[active.points.length - 1];
          if (Math.hypot(next.x - last.x, next.y - last.y) >= 0.5 / active.viewport.zoom)
            active.points.push(next);
        }

        const last = active.points[active.points.length - 1];
        if (world.x !== last.x || world.y !== last.y) active.points.push(world);
        active.draft = { ...active.draft, ...penFromPoints(active.points)! };
      } else {
        const end = modifiers.shiftKey
          ? {
              x:
                active.worldStart.x +
                Math.sign(delta.x || 1) *
                  Math.max(
                    Math.abs(world.x - active.worldStart.x),
                    Math.abs(world.y - active.worldStart.y),
                  ),
              y:
                active.worldStart.y +
                Math.sign(delta.y || 1) *
                  Math.max(
                    Math.abs(world.x - active.worldStart.x),
                    Math.abs(world.y - active.worldStart.y),
                  ),
            }
          : world;

        const bounds = rectFromPoints(
          active.worldStart,
          end,
          active.draft.kind === "frame" ? 40 : 1,
        );

        active.draft = {
          ...active.draft,
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          width: Math.round(bounds.width),
          height: Math.round(bounds.height),
        };
      }

      draftBatch.schedule(active.draft);
    } else if (active.kind === "marquee") {
      const worldRect = rectFromPoints(active.worldStart!, screenToWorld(point, view), 0);

      const rect = {
        x: worldRect.x * view.zoom + view.x,
        y: worldRect.y * view.zoom + view.y,
        width: worldRect.width * view.zoom,
        height: worldRect.height * view.zoom,
      };

      active.moved ||= Math.hypot(delta.x, delta.y) >= 3;
      const matches = active.moved ? marqueeSelection(active.candidates ?? [], worldRect) : [];
      marqueeBatch.schedule({
        rect,
        ids: document.getRootIds(
          modifiers.shiftKey ? [...(active.initialSelection ?? []), ...matches] : matches,
        ),
      });
    } else if (active.kind === "pan") {
      changeViewport({
        ...active.viewport,
        x: active.viewport.x + delta.x,
        y: active.viewport.y + delta.y,
      });
    } else if (active.kind === "spacing" && active.spacing && active.frames && active.roots) {
      active.moved ||= Math.hypot(delta.x, delta.y) >= 3;
      if (!active.moved) return;

      const localDelta = transformVector(
        active.spacing.inverse,
        pointerWorldDelta(active.worldStart!, point, view),
      );

      const step = modifiers.shiftKey ? 10 : 1;

      const value = Math.max(
        0,
        Math.round(
          (active.spacing.value + localDelta[active.spacing.axis] * active.spacing.sign) / step,
        ) * step,
      );

      previewBatch.schedule(
        changeCanvasProperty(
          active.frames,
          active.roots,
          active.spacing.property,
          value,
          measureCanvasTextHeight,
        ),
      );
      guides.clear();
    } else if (active.bounds && active.frames && active.roots) {
      active.moved ||= Math.hypot(delta.x, delta.y) >= 3;
      if (!active.moved) return;
      const worldDelta = pointerWorldDelta(active.worldStart!, point, view);

      if (modifiers.shiftKey && active.kind === "move") {
        active.axisLock ??= Math.abs(worldDelta.x) >= Math.abs(worldDelta.y) ? "x" : "y";
        if (active.axisLock === "x") worldDelta.y = 0;
        else worldDelta.x = 0;
      } else active.axisLock = undefined;

      const onlyFrame =
        active.roots.length === 1
          ? active.frames.find((node) => node.id === active.roots![0])
          : undefined;

      const geometry = active.geometryFrames ?? active.frames;
      const source = active.geometrySource ?? frameSource(geometry);

      if (active.transformed) {
        let updates: CanvasFrame[];
        if (active.kind === "move")
          updates = moveSelectionWorld(geometry, active.roots, worldDelta);
        else if (onlyFrame && active.handle) {
          const matrix = worldTransform(source, onlyFrame);
          const localDelta = transformVector(inverseMatrix(matrix), worldDelta);
          const minimum = !onlyFrame.kind || onlyFrame.kind === "frame" ? 40 : 1;

          const rect = (
            modifiers.shiftKey || onlyFrame.kind === "group"
              ? resizeFrameProportionally
              : resizeFrame
          )(onlyFrame, active.handle, localDelta, minimum, false);

          const centerDelta = {
            x: rect.x - onlyFrame.x + (rect.width - onlyFrame.width) / 2,
            y: rect.y - onlyFrame.y + (rect.height - onlyFrame.height) / 2,
          };

          const angle = ((onlyFrame.rotation ?? 0) * Math.PI) / 180;
          const dx = Math.cos(angle) * centerDelta.x - Math.sin(angle) * centerDelta.y;
          const dy = Math.sin(angle) * centerDelta.x + Math.cos(angle) * centerDelta.y;

          const next = {
            ...rect,
            x: onlyFrame.x + onlyFrame.width / 2 + dx - rect.width / 2,
            y: onlyFrame.y + onlyFrame.height / 2 + dy - rect.height / 2,
          };

          updates = resizeSelection(active.frames, active.roots, onlyFrame, next);
        } else if (active.handle) {
          const next = resizeFrameProportionally(active.bounds, active.handle, worldDelta, 1);
          updates = scaleSelectionWorld(geometry, active.roots, active.bounds, next);
        } else return;
        if (active.kind === "move") active.requestedMove = updates;
        previewBatch.schedule(updates);
        guides.set([]);

        return;
      }

      const minimum = onlyFrame && (!onlyFrame.kind || onlyFrame.kind === "frame") ? 40 : 1;

      const next =
        active.kind === "resize" && active.handle
          ? (modifiers.shiftKey ? resizeFrameProportionally : resizeFrame)(
              active.bounds,
              active.handle,
              worldDelta,
              minimum,
              false,
            )
          : {
              ...active.bounds,
              x: active.bounds.x + worldDelta.x,
              y: active.bounds.y + worldDelta.y,
            };

      if (active.guideTargets && active.guideViewport !== view) {
        active.guideViewport = view;
        active.guides = active.guideTargets.inViewport(
          viewportBounds(view, camera.getCurrent().size, 0),
        );
      }

      if (modifiers.altKey || (modifiers.shiftKey && active.kind === "resize"))
        active.snapState = {};

      const snapped =
        modifiers.altKey || (modifiers.shiftKey && active.kind === "resize")
          ? { rect: next, guides: [] }
          : active.guides!.snap(next, view.zoom, active.handle, minimum, active.snapState);

      if (modifiers.shiftKey && active.kind === "move") {
        if (active.axisLock === "x") {
          snapped.rect.y = active.bounds.y;
          if (active.snapState) active.snapState.y = undefined;
          snapped.guides = snapped.guides.filter((guide) => guide.axis === "x");
        } else {
          snapped.rect.x = active.bounds.x;
          if (active.snapState) active.snapState.x = undefined;
          snapped.guides = snapped.guides.filter((guide) => guide.axis === "y");
        }
      }

      const updates =
        active.kind === "resize"
          ? resizeSelection(active.frames, active.roots, active.bounds, snapped.rect)
          : moveSelection(active.frames, active.roots, {
              x: snapped.rect.x - active.bounds.x,
              y: snapped.rect.y - active.bounds.y,
            });

      if (active.kind === "move") active.requestedMove = updates;
      previewBatch.schedule(updates);
      guides.set(snapped.guides);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const { size } = camera.getCurrent();
    const active = interactionRef.current;
    if (active) active.modifiers = { shiftKey: event.shiftKey, altKey: event.altKey };
    if (menuOpen || event.nativeEvent.isComposing || isEditingTarget(event.target)) return;
    if (
      (event.key === "Enter" || event.code === "Space") &&
      (event.target as HTMLElement).closest("button") &&
      !(event.target as HTMLElement).closest(".design-canvas")
    )
      return;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (
      (event.target as HTMLElement).closest(".canvas-properties") &&
      !(command && (key === "z" || key === "y"))
    )
      return;

    if (key === "escape") {
      if (interactionRef.current) finishInteraction(true);
      else {
        selectOne(null);
        setGroupScope(null);
        setTool("select");
      }
    } else if (event.code === "Space" && !command) {
      spaceRef.current = true;
      setSpaceHeld(true);
    } else if (interactionRef.current) {
      return;
    } else if (command && key === "z") {
      surfaceRef.current?.focus({ preventScroll: true });
      if (event.shiftKey) redo();
      else undo();
    } else if (command && key === "y") {
      surfaceRef.current?.focus({ preventScroll: true });
      redo();
    } else if (command && key === "d") {
      duplicateFrame();
    } else if (command && key === "a") {
      setSelection(
        document
          .getChildren(groupScope ?? undefined)
          .filter((id) => !isNodeLocked(document, id) && !document.isHidden(id)),
      );
    } else if (command && key === "g") {
      if (event.shiftKey) ungroupObjects();
      else groupObjects(event.altKey);
    } else if (command && event.shiftKey && key === "h") {
      const hidden = selectedIds.some((id) => !document.getFrame(id)?.hidden);
      document.updateMany(selectedIds.map((id) => ({ ...document.getFrame(id)!, hidden })));
      setHoveredId(null);
    } else if (command && event.shiftKey && key === "l") {
      if (selectedIds.length) lockSelection();
      else unlockAll();
    } else if (command && (event.code === "BracketRight" || event.code === "BracketLeft")) {
      document.reorder(
        selectedIds,
        event.code === "BracketRight"
          ? event.shiftKey
            ? "front"
            : "forward"
          : event.shiftKey
            ? "back"
            : "backward",
      );
    } else if (key === "f2" && selected) {
      setRename({ id: selected.id, name: selected.name });
    } else if (command && key === "v" && (usesNativeCanvasClipboard() || event.shiftKey)) {
      if (!event.repeat) void pasteFromClipboard(undefined, event.shiftKey);
    } else if (key === "delete" || key === "backspace") {
      deleteFrame();
    } else if (
      !command &&
      !event.altKey &&
      !event.repeat &&
      ["v", "f", "r", "t", "i", "p", "h"].includes(key)
    ) {
      const shortcuts: Record<string, CanvasTool> = {
        v: "select",
        f: "frame",
        r: "rectangle",
        t: "text",
        i: "image",
        p: "pen",
        h: "pan",
      };

      chooseTool(shortcuts[key]);
    } else if (key === "enter" && selected?.kind === "text") {
      setEditingId(selected.id);
    } else if (key === "enter" && selected?.kind === "group") {
      setGroupScope(selected.id);
      selectOne(
        document.getChildren(selected.id).find((id) => !isNodeLocked(document, id)) ?? null,
      );
    } else if (event.shiftKey && event.code === "Digit2" && selectedIds.length) {
      changeViewport(
        fitViewport(
          selectedIds.map((id) => worldBounds(document, document.getFrame(id)!)),
          size,
        ),
      );
    } else if (event.shiftKey && event.code === "Digit1") {
      changeViewport(
        fitViewport(
          document.getSceneFrames().filter((node) => !document.isHidden(node.id)),
          size,
        ),
      );
    } else if (key === "0" && !event.altKey) {
      changeViewport(
        zoomAtPoint(camera.getCurrent().viewport, { x: size.x / 2, y: size.y / 2 }, 1),
      );
    } else if (key === "+" || key === "=" || key === "-") {
      changeViewport(
        zoomAtPoint(
          camera.getCurrent().viewport,
          { x: size.x / 2, y: size.y / 2 },
          camera.getCurrent().viewport.zoom * (key === "-" ? 0.8 : 1.25),
        ),
      );
    } else if (key.startsWith("arrow") && selectedIds.length) {
      const step = event.shiftKey ? 10 : 1;

      const delta = {
        x: key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
        y: key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
      };

      const handle = (event.target as HTMLElement).dataset.handle as ResizeHandle | undefined;

      const activeIds = handle
        ? getVisibleSelectionFrames(document, selectedIds).map((node) => node.id)
        : selectedIds;

      const all = document.getDescendantIds(activeIds).map((id) => document.getFrame(id)!);
      const bounds = selectionBounds(all, activeIds);
      if (!bounds) return;

      const updated = handle
        ? resizeSelection(
            all,
            activeIds,
            bounds,
            resizeFrame(
              bounds,
              handle,
              delta,
              selected && (!selected.kind || selected.kind === "frame") ? 40 : 1,
            ),
          )
        : moveSelectionWorld(all, activeIds, delta);

      document.updateMany(updated);
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      const bounds = surfaceRef.current?.getBoundingClientRect();
      surfaceRef.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: (bounds?.left ?? 0) + size.x / 2,
          clientY: (bounds?.top ?? 0) + size.y / 2,
        }),
      );
    } else {
      return;
    }

    event.preventDefault();
  }

  function trackHover(event: PointerEvent<HTMLDivElement>) {
    if (
      interactionRef.current ||
      menuOpen ||
      spaceRef.current ||
      tool !== "select" ||
      editingId ||
      event.pointerType !== "mouse"
    )
      return;

    const id =
      resolveHit(
        event.target as HTMLElement,
        event.metaKey,
        localPoint(event.clientX, event.clientY),
      ) ?? null;

    setHoveredId(id);
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Delegate shortcuts from the canvas and accessible layer tree; inputs and tree navigation handle their own keys.
    <main
      className="canvas-editor"
      aria-label="Canvas editor"
      data-layers-open={layersOpen || undefined}
      data-properties-open={propertiesOpen || undefined}
      onKeyDown={keyDown}
      onCopy={(event) => copySelection(event)}
      onCut={(event) => copySelection(event, true)}
      onPaste={(event) => {
        if (isEditingTarget(event.target)) return;

        if (usesNativeCanvasClipboard()) {
          // macOS Edit > Paste may deliver an empty/filtered WebKit event instead of keydown.
          event.preventDefault();
          void pasteFromClipboard();

          return;
        }

        const data: CanvasClipboard = {
          internal: readCanvasClipboardMime((type) => event.clipboardData.getData(type)),
          html: event.clipboardData.getData("text/html"),
          text: event.clipboardData.getData("text/plain"),
          images: Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith("image/"),
          ),
        };

        if (data.internal || data.text || data.images.length || data.html) {
          event.preventDefault();
          void pasteClipboard(data);
        }
      }}
    >
      {layersOpen ? (
        <CanvasLayers
          document={document}
          selectedIds={propertyIds}
          onSelect={selectLayer}
          onRename={renameLayer}
          onToggleLock={toggleLayerLock}
          onToggleHidden={toggleLayerHidden}
          onMove={moveLayers}
          onHover={setHoveredId}
          onCollapse={collapseLayers}
          pages={pages}
          activePageId={activePageId}
          onSelectPage={showPage}
          onMoveToPage={moveLayersToPage}
          onAddPage={() => addPage()}
          onRenamePage={renamePage}
          onRemovePage={removePage}
        />
      ) : (
        <button
          ref={reopenLayersRef}
          type="button"
          className="canvas-layers-reopen"
          aria-label="Show layers"
          title="Show layers"
          onClick={() => {
            setLayersOpen(true);
          }}
        >
          <PanelLeftOpenIcon size={16} strokeWidth={1.65} aria-hidden="true" />
        </button>
      )}
      {propertiesOpen && (
        <CanvasProperties
          collaborators={collaborators}
          document={document}
          selectedIds={propertyIds}
          onChange={changeProperty}
          onPreviewStart={startPropertyPreview}
          onPreview={previewProperty}
          onPreviewEnd={endPropertyPreview}
          onArrange={arrangeFromProperties}
          onFitText={fitTextHeight}
          onSelect={selectOne}
          vectorEditingId={vectorEditingId}
          onEditVector={(id) => {
            finishInteraction(true);
            setEditingId(null);
            selectOne(id);
            setVectorEditingId(id);
          }}
          onPlan={(plan) => {
            finishInteraction(true);
            endPropertyPreview(false);
            if (
              document.transact({
                add: plan.upsert.filter((node) => !document.getFrame(node.id)),
                update: plan.upsert.filter((node) => document.getFrame(node.id)),
                remove: plan.remove,
              })
            )
              setSelection(plan.selection);
          }}
        />
      )}
      <ContextMenu
        open={menuOpen}
        onOpenChange={(open, details) => {
          if (open) {
            setHoveredId(null);
            finishInteraction(true);
            const event = details.event;
            const { size } = camera.getCurrent();
            let point = { x: size.x / 2, y: size.y / 2 };

            if ("clientX" in event)
              point = localPoint(Number(event.clientX), Number(event.clientY));
            else if ("touches" in event) {
              const touch = (event as TouchEvent).touches[0];
              if (touch) point = localPoint(touch.clientX, touch.clientY);
            }

            menuPointRef.current = screenToWorld(point, camera.getCurrent().viewport);

            const target =
              "clientX" in event && "clientY" in event
                ? surfaceRef.current?.ownerDocument.elementFromPoint(
                    Number(event.clientX),
                    Number(event.clientY),
                  )
                : event.target instanceof Element
                  ? event.target
                  : null;

            const id = resolveHit(target ?? null, false, point);
            if (id && !selectedIds.includes(id)) selectOne(id);
          }

          setMenuOpen(open);
        }}
      >
        <ContextMenuTrigger
          ref={surfaceRef}
          className="design-canvas"
          role="application"
          aria-label="Design canvas"
          aria-describedby="canvas-instructions"
          tabIndex={0}
          data-panning={isPanning || undefined}
          data-hand={spaceHeld || tool === "pan" || undefined}
          data-tool={tool}
          data-renderer={rendererBackend}
          onDoubleClick={(event) => {
            if (tool !== "select" || isEditingTarget(event.target)) return;

            // Pointer capture can retarget the double-click to the canvas surface.
            const hit = event.currentTarget.ownerDocument.elementFromPoint(
              event.clientX,
              event.clientY,
            );

            const id = resolveHit(hit, true, localPoint(event.clientX, event.clientY));
            if (!id || isNodeLocked(document, id)) return;
            const node = document.getFrame(id);

            if (node?.kind === "text") {
              selectOne(id);
              setEditingId(id);
            } else if (node?.kind === "svg" && node.vector) {
              selectOne(id);
              setVectorEditingId(id);
            } else if (node?.kind === "group") {
              setGroupScope(id);
              selectOne(
                document.getChildren(id).find((childId) => !isNodeLocked(document, childId)) ?? id,
              );
            } else if (node?.parentId && document.getFrame(node.parentId)?.kind === "group") {
              setGroupScope(node.parentId);
              selectOne(id);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            void importImages(
              Array.from(event.dataTransfer.files),
              screenToWorld(localPoint(event.clientX, event.clientY), camera.getCurrent().viewport),
            );
          }}
          onPointerDown={startInteraction}
          onPointerMove={(event) => {
            moveInteraction(event);
            trackHover(event);
          }}
          onPointerOver={trackHover}
          onFocus={(event) => {
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-frame-id]")
              ?.dataset.frameId;

            if (
              id &&
              !interactionRef.current &&
              !selectedIds.includes(id) &&
              !isNodeLocked(document, id)
            )
              selectOne(id);
          }}
          onClick={(event) => {
            if (event.detail !== 0) return;

            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-frame-id]")
              ?.dataset.frameId;

            if (id && !isNodeLocked(document, id)) selectOne(id);
          }}
          onPointerLeave={() => setHoveredId(null)}
          onPointerUp={(event) => {
            if (event.pointerId === interactionRef.current?.pointerId) {
              moveInteraction(event);
              finishInteraction();
            }
          }}
          onPointerCancel={(event) => {
            if (event.pointerId === interactionRef.current?.pointerId) finishInteraction(true);
          }}
          onLostPointerCapture={(event) => {
            if (event.pointerId === interactionRef.current?.pointerId) finishInteraction();
          }}
        >
          <canvas className="canvas-surface" width={1} height={1} aria-hidden="true" />
          <p id="canvas-instructions" className="sr-only">
            V select, F frame, R rectangle, T text, I image, P pen, H hand. Drag blank space to
            select multiple objects; Shift-click adds or removes one. Hold Space to pan. Ctrl/Cmd C,
            X, V copy, cut, paste. Ctrl/Cmd G groups; Shift ungroups. Enter opens a group; Cmd-click
            selects inside one. Double-click text to edit. Arrow keys nudge; Shift uses ten-pixel
            steps. Alt bypasses alignment snapping. Escape cancels. Right-click for more actions.
          </p>
          {ids.length === 0 && (
            <div className="canvas-empty" aria-hidden="true">
              <p>Choose a tool and start creating</p>
              <span>or drop an image onto the canvas</span>
            </div>
          )}
          <CanvasFrames
            document={document}
            camera={camera}
            selectedIds={selectedIds}
            FrameContent={FrameContent}
            editingId={editingId}
            onTextCommit={commitText}
            onTextCancel={cancelText}
            onRendererChange={setRendererBackend}
            inspectHtml={inspectHtml}
          />
          {vectorEditingId && selectedIds.includes(vectorEditingId) && (
            <CanvasVectorEditing
              document={document}
              camera={camera}
              id={vectorEditingId}
              onClose={() => setVectorEditingId(null)}
            />
          )}
          {draft && <DrawingPreview frame={draft} camera={camera} />}
          <CanvasOutline
            document={document}
            camera={camera}
            id={
              tool === "select" &&
              !editingId &&
              !isPanning &&
              !spaceHeld &&
              !menuOpen &&
              !selectedIds.includes(hoveredId ?? "")
                ? hoveredId
                : null
            }
          />
          <CanvasSelectionOutline
            document={document}
            camera={camera}
            ids={editingId || draft || tool !== "select" ? [] : selectedIds}
          />
          <CanvasLayoutOverlay
            document={document}
            camera={camera}
            id={
              editingId || draft || tool !== "select" || isPanning || spaceHeld || menuOpen
                ? null
                : selectedId
            }
            activeHandle={activeSpacing}
            onStart={startSpacingInteraction}
            onChange={(property, value) => void changeProperty(property, value)}
          />
          {marquee && (
            <div
              className="canvas-marquee"
              aria-hidden="true"
              style={{
                left: marquee.x,
                top: marquee.y,
                width: marquee.width,
                height: marquee.height,
              }}
            />
          )}
          <CanvasAlignmentGuides guides={guides} camera={camera} />
          <CanvasAgentActivity document={document} camera={camera} />
          {realtime && (
            <CanvasPresence
              realtime={realtime}
              camera={camera}
              document={document}
              selection={selectedIds}
            />
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="canvas-menu" finalFocus={surfaceRef}>
          <ContextMenuItem onClick={() => createFrame(menuPointRef.current)}>
            New frame<ContextMenuShortcut>F</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!selectedIds.length} onClick={() => void copyFromMenu()}>
            Copy<ContextMenuShortcut>⌘ C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSub>
            <ContextMenuSubTrigger disabled={!selectedIds.length}>Copy as</ContextMenuSubTrigger>
            <ContextMenuSubContent className="canvas-menu">
              {CANVAS_CODE_FORMATS.map((format) => (
                <ContextMenuItem key={format} onClick={() => void copyAs(format)}>
                  {format}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem disabled={!selectedIds.length} onClick={() => void copyFromMenu(true)}>
            Cut<ContextMenuShortcut>⌘ X</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void pasteFromMenu()}>
            Paste<ContextMenuShortcut>⌘ V</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => void pasteFromMenu(true)}>
            Paste in place<ContextMenuShortcut>⇧ ⌘ V</ContextMenuShortcut>
          </ContextMenuItem>
          {selectedIds.length > 0 && (
            <>
              <ContextMenuItem onClick={duplicateFrame}>
                Duplicate<ContextMenuShortcut>⌘ D</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={deleteFrame}>
                Delete<ContextMenuShortcut>⌫</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          )}
          {selectedIds.length > 0 && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => groupObjects()}>
                Group selection<ContextMenuShortcut>⌘ G</ContextMenuShortcut>
              </ContextMenuItem>
              {selectedIds.some((id) => document.getFrame(id)?.kind === "group") && (
                <ContextMenuItem onClick={ungroupObjects}>
                  Ungroup<ContextMenuShortcut>⇧ ⌘ G</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={() => groupObjects(true)}>
                Frame selection<ContextMenuShortcut>⌥ ⌘ G</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuSub>
                <ContextMenuSubTrigger>Arrange</ContextMenuSubTrigger>
                <ContextMenuSubContent className="canvas-menu">
                  {selectedIds.length > 1 && (
                    <>
                      {(
                        [
                          ["left", "Align left"],
                          ["center", "Align horizontal centers"],
                          ["right", "Align right"],
                          ["top", "Align top"],
                          ["middle", "Align vertical centers"],
                          ["bottom", "Align bottom"],
                          ["horizontal", "Distribute horizontally"],
                          ["vertical", "Distribute vertically"],
                        ] as const
                      ).map(([action, label]) => (
                        <ContextMenuItem
                          key={action}
                          disabled={
                            (action === "horizontal" || action === "vertical") &&
                            selectedIds.length < 3
                          }
                          onClick={() => arrangeObjects(action)}
                        >
                          {label}
                        </ContextMenuItem>
                      ))}
                      <ContextMenuSeparator />
                    </>
                  )}
                  <ContextMenuItem onClick={() => document.reorder(selectedIds, "front")}>
                    Bring to front<ContextMenuShortcut>⇧ ⌘ ]</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => document.reorder(selectedIds, "forward")}>
                    Bring forward<ContextMenuShortcut>⌘ ]</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => document.reorder(selectedIds, "backward")}>
                    Send backward<ContextMenuShortcut>⌘ [</ContextMenuShortcut>
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => document.reorder(selectedIds, "back")}>
                    Send to back<ContextMenuShortcut>⇧ ⌘ [</ContextMenuShortcut>
                  </ContextMenuItem>
                </ContextMenuSubContent>
              </ContextMenuSub>
              {selected && (
                <ContextMenuItem
                  onClick={() => setRename({ id: selected.id, name: selected.name })}
                >
                  Rename<ContextMenuShortcut>F2</ContextMenuShortcut>
                </ContextMenuItem>
              )}
              <ContextMenuItem onClick={lockSelection}>
                Lock selection<ContextMenuShortcut>⇧ ⌘ L</ContextMenuShortcut>
              </ContextMenuItem>
              {selected && (!selected.kind || selected.kind === "frame") && (
                <ContextMenuCheckboxItem
                  checked={selected.clipContent !== false}
                  onCheckedChange={(checked) =>
                    document.update({ ...selected, clipContent: checked })
                  }
                >
                  Clip contents
                </ContextMenuCheckboxItem>
              )}
            </>
          )}
          {ids.some((id) => document.getFrame(id)?.locked) && (
            <ContextMenuItem onClick={unlockAll}>Unlock all</ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!canUndo} onClick={undo}>
            Undo<ContextMenuShortcut>⌘ Z</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled={!canRedo} onClick={redo}>
            Redo<ContextMenuShortcut>⇧ ⌘ Z</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!ids.length}
            onClick={() =>
              changeViewport(
                fitViewport(
                  document.getSceneFrames().filter((node) => !document.isHidden(node.id)),
                  camera.getCurrent().size,
                ),
              )
            }
          >
            Zoom to fit<ContextMenuShortcut>⇧ 1</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => {
              const { viewport, size } = camera.getCurrent();
              changeViewport(zoomAtPoint(viewport, { x: size.x / 2, y: size.y / 2 }, 1));
            }}
          >
            Zoom to 100%<ContextMenuShortcut>0</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <CanvasToolbar
        tool={tool}
        onToolChange={chooseTool}
        disabled={importing}
        actions={
          <CanvasFileMenu
            fileActions={fileActions}
            document={document}
            selectedIds={propertyIds}
            onPrepare={prepareFileAction}
            onOpen={openProject}
            onNotice={setNotice}
          />
        }
      />
      <Dialog
        open={rename !== null}
        onOpenChange={(open) => {
          if (!open) setRename(null);
        }}
      >
        <DialogContent finalFocus={surfaceRef}>
          <DialogTitle>Rename object</DialogTitle>
          <DialogDescription>Choose a name for this object.</DialogDescription>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const node = rename && document.getFrame(rename.id);
              if (node && rename?.name.trim())
                document.update({ ...node, name: rename.name.trim() });
              setRename(null);
            }}
          >
            <Input
              aria-label="Object name"
              value={rename?.name ?? ""}
              onChange={(event) =>
                setRename((value) => (value ? { ...value, name: event.target.value } : null))
              }
              onFocus={(event) => event.target.select()}
            />
            <Button type="submit" disabled={!rename?.name.trim()}>
              Rename
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        aria-label="Choose images"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void importImages(files);
        }}
      />
      {(notice || importing) && <output className="canvas-notice">{notice || "Importing…"}</output>}
    </main>
  );
}
