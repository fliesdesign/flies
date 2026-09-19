import {
  ChevronRightIcon,
  FrameIcon,
  EyeIcon,
  EyeOffIcon,
  GroupIcon,
  ImageIcon,
  LockKeyholeIcon,
  PanelLeftCloseIcon,
  PenLineIcon,
  SquareIcon,
  TypeIcon,
  UnlockKeyholeIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type { CanvasDocument, CanvasFrame } from "@/lib/canvas-document";
import { LayerHoverExpansion } from "@/lib/canvas-layer-hover";

import "./canvas-layers.css";

type CanvasLayersProps = {
  document: CanvasDocument;
  selectedIds: readonly string[];
  onSelect: (
    id: string,
    modifiers: { additive: boolean; range: boolean; visibleIds: readonly string[] },
  ) => void;
  onRename: (id: string, name: string) => void;
  onToggleLock: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onMove: (
    ids: readonly string[],
    targetId: string | null,
    placement: "before" | "after" | "inside",
  ) => void;
  onHover: (id: string | null) => void;
  onCollapse: () => void;
};

type LayerRow = {
  node: CanvasFrame;
  depth: number;
  index: number;
  siblingCount: number;
  hasChildren: boolean;
  inheritedLock: boolean;
  inheritedHidden: boolean;
};

type LayerDrop = {
  id: string | null;
  placement: "before" | "after" | "inside";
  top: number;
  depth: number;
};
type LayerDrag = {
  excluded: ReadonlySet<string>;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  ids: readonly string[];
  moving: boolean;
};

const ROW_HEIGHT = 30;
const TREE_PADDING = 8;
const OVERSCAN = 8;

const NODE_ICONS = {
  frame: FrameIcon,
  group: GroupIcon,
  rectangle: SquareIcon,
  text: TypeIcon,
  image: ImageIcon,
  pen: PenLineIcon,
};

function layerRows(document: CanvasDocument, collapsed: ReadonlySet<string>): LayerRow[] {
  const rows: LayerRow[] = [];
  const stack: LayerRow[] = [];
  function addChildren(
    parentId: string | undefined,
    depth: number,
    inheritedLock: boolean,
    inheritedHidden: boolean,
  ) {
    const children = document.getChildren(parentId);
    for (let i = 0; i < children.length; i++) {
      const node = document.getFrame(children[i]);
      if (!node) continue;
      stack.push({
        node,
        depth,
        index: children.length - i,
        siblingCount: children.length,
        hasChildren: document.getChildren(node.id).length > 0,
        inheritedLock,
        inheritedHidden,
      });
    }
  }
  addChildren(undefined, 0, false, false);
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    if (!collapsed.has(row.node.id))
      addChildren(
        row.node.id,
        row.depth + 1,
        row.inheritedLock || Boolean(row.node.locked),
        row.inheritedHidden || Boolean(row.node.hidden),
      );
  }
  return rows;
}

function LayerNameEditor({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  const [value, setValue] = useState(name);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const finish = (cancel: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (cancel || !value.trim()) onCancel();
    else onSave(value.trim());
  };
  return (
    <input
      ref={inputRef}
      className="canvas-layer-name-input"
      aria-label="Layer name"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onBlur={() => finish(false)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish(event.key === "Escape");
        }
      }}
    />
  );
}

/** The layer list follows committed changes; dragging geometry does not rebuild it. */
export const CanvasLayers = memo(function CanvasLayers({
  document,
  selectedIds,
  onSelect,
  onRename,
  onToggleLock,
  onToggleHidden,
  onMove,
  onHover,
  onCollapse,
}: CanvasLayersProps) {
  const snapshot = useSyncExternalStore(
    document.subscribe,
    document.getSnapshot,
    document.getSnapshot,
  );
  const selectionKey = JSON.stringify(selectedIds);
  const [expansion, setExpansion] = useState({
    selectionKey,
    collapsed: new Set<string>(),
  });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const rowElements = useRef(new Map<string, HTMLDivElement>());
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const dragRef = useRef<LayerDrag | null>(null);
  const [hoverExpansion] = useState(() => new LayerHoverExpansion());
  const suppressClick = useRef(false);
  const [draggingIds, setDraggingIds] = useState<readonly string[]>([]);
  const [drop, setDrop] = useState<LayerDrop | null>(null);
  const revealedSelection = useRef<string | null>(null);
  const [scrollWindow, setScrollWindow] = useState({ top: 0, height: 600 });
  const collapseButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const active = window.document.activeElement;
    if (active === window.document.body || active?.matches(".canvas-layers-reopen"))
      collapseButton.current?.focus();
  }, []);

  // Reveal a canvas selection without undoing a user's subsequent manual collapse.
  if (expansion.selectionKey !== selectionKey) {
    const collapsed = new Set(expansion.collapsed);
    for (const id of selectedIds) {
      let parentId = document.getFrame(id)?.parentId;
      while (parentId) {
        collapsed.delete(parentId);
        parentId = document.getFrame(parentId)?.parentId;
      }
    }
    setExpansion({ selectionKey, collapsed });
  }

  const rows = useMemo(
    () => (snapshot.ids.length > 0 ? layerRows(document, expansion.collapsed) : []),
    [document, snapshot, expansion.collapsed],
  );
  const visibleIds = useMemo(() => rows.map(({ node }) => node.id), [rows]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const tabStop =
    (focusId && visibleIds.includes(focusId) ? focusId : undefined) ??
    visibleIds.find((id) => selected.has(id)) ??
    visibleIds[0];

  const hasRows = rows.length > 0;
  const updateScrollWindow = useCallback(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const next = { top: tree.scrollTop, height: tree.clientHeight };
    setScrollWindow((current) =>
      current.top === next.top && current.height === next.height ? current : next,
    );
  }, []);
  useEffect(() => {
    const tree = treeRef.current;
    if (!hasRows || !tree) return;
    const observer = new ResizeObserver(updateScrollWindow);
    observer.observe(tree);
    updateScrollWindow();
    return () => observer.disconnect();
  }, [hasRows, updateScrollWindow]);

  const revealRow = useCallback(
    (id: string | undefined) => {
      const tree = treeRef.current;
      const index = id ? visibleIds.indexOf(id) : -1;
      if (!tree || index < 0) return;
      const top = TREE_PADDING + index * ROW_HEIGHT;
      if (top < tree.scrollTop + TREE_PADDING) tree.scrollTop = top - TREE_PADDING;
      else if (top + ROW_HEIGHT > tree.scrollTop + tree.clientHeight - TREE_PADDING)
        tree.scrollTop = top + ROW_HEIGHT - tree.clientHeight + TREE_PADDING;
      updateScrollWindow();
    },
    [visibleIds, updateScrollWindow],
  );
  const selectionToReveal = selectedIds[selectedIds.length - 1];
  useEffect(() => {
    if (revealedSelection.current === selectionKey) return;
    revealRow(selectionToReveal);
    revealedSelection.current = selectionKey;
  }, [selectionKey, selectionToReveal, revealRow]);
  useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = rowElements.current.get(pendingFocus.current);
    if (row) {
      row.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });

  const findDrop = useCallback(
    (x: number, y: number): LayerDrop | null => {
      const tree = treeRef.current;
      const drag = dragRef.current;
      if (!tree || !drag?.moving) return null;
      const bounds = tree.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
      const position = y - bounds.top + tree.scrollTop - TREE_PADDING;
      const index = Math.max(0, Math.floor(position / ROW_HEIGHT));
      if (index >= rows.length)
        return { id: null, placement: "after", top: rows.length * ROW_HEIGHT, depth: 0 };
      let row = rows[index];
      let rowIndex = index;
      const offset = position - index * ROW_HEIGHT;
      const container = !row.node.kind || row.node.kind === "frame" || row.node.kind === "group";
      let placement: LayerDrop["placement"] =
        container && offset >= 7 && offset <= 23 ? "inside" : offset < 15 ? "before" : "after";
      // Moving left of a nested row promotes the drop to its ancestor's sibling level.
      while (row.node.parentId && x - bounds.left < 24 + row.depth * 16) {
        const parentIndex = rows.findIndex((item) => item.node.id === row.node.parentId);
        if (parentIndex < 0) break;
        row = rows[parentIndex];
        rowIndex = parentIndex;
        placement = "after";
      }
      if (
        drag.excluded.has(row.node.id) ||
        row.inheritedLock ||
        (placement === "inside" && row.node.locked)
      )
        return null;
      let boundary = rowIndex;
      if (placement === "after") {
        boundary++;
        while (boundary < rows.length && rows[boundary].depth > row.depth) boundary++;
      }
      return { id: row.node.id, placement, top: boundary * ROW_HEIGHT, depth: row.depth };
    },
    [rows],
  );

  const stopDrag = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    hoverExpansion.cancel();
    const tree = treeRef.current;
    if (drag && tree?.hasPointerCapture(drag.pointerId)) tree.releasePointerCapture(drag.pointerId);
    setDraggingIds([]);
    setDrop(null);
  }, [hoverExpansion]);

  const expandTarget =
    draggingIds.length &&
    drop?.placement === "inside" &&
    drop.id &&
    expansion.collapsed.has(drop.id)
      ? drop.id
      : null;
  useEffect(() => {
    hoverExpansion.update(expandTarget, (id) => {
      setExpansion((previous) => {
        const collapsed = new Set(previous.collapsed);
        collapsed.delete(id);
        return { ...previous, collapsed };
      });
    });
  }, [expandTarget, hoverExpansion]);
  useEffect(() => () => hoverExpansion.cancel(), [hoverExpansion]);
  // Expansion changes the row geometry even if the pointer stays still.
  useEffect(() => {
    const drag = dragRef.current;
    if (drag?.moving) setDrop(findDrop(drag.x, drag.y));
  }, [findDrop]);

  useEffect(() => {
    if (!draggingIds.length) return;
    let frame = 0;
    const scroll = () => {
      const tree = treeRef.current;
      const drag = dragRef.current;
      if (!tree || !drag) return;
      const bounds = tree.getBoundingClientRect();
      const inside = drag.x >= bounds.left && drag.x <= bounds.right;
      const delta = inside
        ? drag.y < bounds.top + 32
          ? -10
          : drag.y > bounds.bottom - 32
            ? 10
            : 0
        : 0;
      if (delta) {
        const previous = tree.scrollTop;
        tree.scrollTop += delta;
        if (tree.scrollTop !== previous) {
          updateScrollWindow();
          setDrop(findDrop(drag.x, drag.y));
        }
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    const cancel = () => stopDrag();
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stopDrag();
    };
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, [draggingIds, findDrop, stopDrag, updateScrollWindow]);

  const start = Math.max(0, Math.floor((scrollWindow.top - TREE_PADDING) / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    rows.length,
    Math.ceil((scrollWindow.top + scrollWindow.height - TREE_PADDING) / ROW_HEIGHT) + OVERSCAN,
  );
  const renderedIndices: number[] = [];
  // Preserve the keyboard entry point and any active editor even when scrolled offscreen.
  const tabIndex = tabStop ? visibleIds.indexOf(tabStop) : -1;
  const editIndex = editingId ? visibleIds.indexOf(editingId) : -1;
  for (let index = start; index < end; index++) renderedIndices.push(index);
  for (const index of [tabIndex, editIndex]) {
    if (index < 0 || renderedIndices.includes(index)) continue;
    const insertAt = renderedIndices.findIndex((item) => item > index);
    if (insertAt < 0) renderedIndices.push(index);
    else renderedIndices.splice(insertAt, 0, index);
  }

  function toggleExpanded(id: string) {
    setExpansion((previous) => {
      const collapsed = new Set(previous.collapsed);
      if (collapsed.has(id)) collapsed.delete(id);
      else collapsed.add(id);
      return { ...previous, collapsed };
    });
  }

  function focusRow(id: string | undefined) {
    if (!id) return;
    pendingFocus.current = id;
    setFocusId(id);
    revealRow(id);
    const row = rowElements.current.get(id);
    if (row) {
      row.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }

  function finishRename(id: string, name?: string) {
    if (name !== undefined) onRename(id, name);
    setEditingId(null);
    focusRow(id);
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>, row: LayerRow) {
    if (event.target !== event.currentTarget) return;
    const { node, hasChildren, inheritedLock } = row;
    const index = visibleIds.indexOf(node.id);
    const expanded = !expansion.collapsed.has(node.id);
    let next: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = visibleIds[Math.min(index + 1, rows.length - 1)];
        break;
      case "ArrowUp":
        next = visibleIds[Math.max(index - 1, 0)];
        break;
      case "Home":
        next = visibleIds[0];
        break;
      case "End":
        next = visibleIds[visibleIds.length - 1];
        break;
      case "ArrowRight":
        if (hasChildren && !expanded) toggleExpanded(node.id);
        else if (hasChildren) next = visibleIds[index + 1];
        break;
      case "ArrowLeft":
        if (hasChildren && expanded) toggleExpanded(node.id);
        else next = node.parentId;
        break;
      case "Enter":
      case " ":
        onSelect(node.id, {
          additive: event.metaKey || event.ctrlKey,
          range: event.shiftKey,
          visibleIds,
        });
        break;
      case "F2":
        if (!node.locked && !inheritedLock) setEditingId(node.id);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusRow(next);
  }

  const dragName =
    draggingIds.length === 1
      ? (document.getFrame(draggingIds[0])?.name ?? "Layer")
      : `${draggingIds.length} layers`;
  const targetName = drop?.id ? document.getFrame(drop.id)?.name : undefined;
  const dropDescription = !drop
    ? "Choose a destination"
    : !targetName
      ? "Move to canvas"
      : `${drop.placement === "inside" ? "Into" : drop.placement === "before" ? "Above" : "Below"} ${targetName}`;

  return (
    <aside className="canvas-layers" aria-label="Layers panel" data-canvas-ui="">
      <header className="canvas-layers-header">
        <h2>Layers</h2>
        <button
          type="button"
          ref={collapseButton}
          className="canvas-layers-collapse"
          aria-label="Hide layers"
          title="Hide layers"
          onClick={onCollapse}
        >
          <PanelLeftCloseIcon size={15} strokeWidth={1.6} aria-hidden="true" />
        </button>
      </header>
      {rows.length === 0 ? (
        <p className="canvas-layers-empty">Your layers will appear here.</p>
      ) : (
        <div
          ref={treeRef}
          className="canvas-layers-tree"
          role="tree"
          tabIndex={-1}
          aria-label="Layers"
          aria-multiselectable
          data-dragging={draggingIds.length > 0 || undefined}
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && dragRef.current) {
              event.preventDefault();
              event.stopPropagation();
              stopDrag();
            }
          }}
          onPointerDown={(event) => {
            event.stopPropagation();
            suppressClick.current = false;
            if (event.button !== 0 || (event.target as HTMLElement).closest("button,input")) return;
            const id = (event.target as HTMLElement).closest<HTMLElement>("[data-layer-id]")
              ?.dataset.layerId;
            const row = rows.find((item) => item.node.id === id);
            if (!row || row.node.locked || row.inheritedLock) return;
            const ids = document.getRootIds(
              selected.has(row.node.id) ? selectedIds : [row.node.id],
            );
            dragRef.current = {
              excluded: new Set(document.getDescendantIds(ids)),
              ids,
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              x: event.clientX,
              y: event.clientY,
              moving: false,
            };
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (event.buttons !== 1) {
              stopDrag();
              return;
            }
            drag.x = event.clientX;
            drag.y = event.clientY;
            if (!drag.moving && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 4) {
              drag.moving = true;
              suppressClick.current = true;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDraggingIds(drag.ids);
              onHover(null);
            }
            if (drag.moving) {
              event.preventDefault();
              setDrop(findDrop(drag.x, drag.y));
            }
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            const target = findDrop(event.clientX, event.clientY);
            if (drag.moving && target) {
              onMove(drag.ids, target.id, target.placement);
              if (target.placement === "inside" && target.id)
                setExpansion((previous) => {
                  const collapsed = new Set(previous.collapsed);
                  collapsed.delete(target.id!);
                  return { ...previous, collapsed };
                });
            }
            stopDrag();
          }}
          onPointerCancel={stopDrag}
          onLostPointerCapture={() => {
            if (dragRef.current) stopDrag();
          }}
          onMouseLeave={() => onHover(null)}
          onScroll={updateScrollWindow}
        >
          <div
            className="canvas-layers-spacer"
            role="presentation"
            style={{ height: rows.length * ROW_HEIGHT }}
          >
            {drop && drop.placement !== "inside" && (
              <div
                className="canvas-layer-drop-line"
                style={{ top: drop.top, left: 8 + drop.depth * 16 }}
                aria-hidden="true"
              />
            )}
            {renderedIndices.map((rowIndex) => {
              const row = rows[rowIndex];
              const {
                node,
                depth,
                index,
                siblingCount,
                hasChildren,
                inheritedLock,
                inheritedHidden,
              } = row;
              const expanded = !expansion.collapsed.has(node.id);
              const locked = Boolean(node.locked) || inheritedLock;
              const onlyParentLocked = inheritedLock && !node.locked;
              const Icon = NODE_ICONS[node.kind ?? "frame"];
              return (
                <div
                  key={node.id}
                  ref={(element) => {
                    if (element) rowElements.current.set(node.id, element);
                    else rowElements.current.delete(node.id);
                  }}
                  className="canvas-layer-row"
                  role="treeitem"
                  aria-label={node.name}
                  aria-level={depth + 1}
                  aria-posinset={index}
                  aria-setsize={siblingCount}
                  aria-selected={selected.has(node.id)}
                  aria-expanded={hasChildren ? expanded : undefined}
                  data-layer-id={node.id}
                  data-locked={locked || undefined}
                  data-hidden={node.hidden || inheritedHidden || undefined}
                  data-dragging={draggingIds.includes(node.id) || undefined}
                  data-drop-inside={
                    (drop?.id === node.id && drop.placement === "inside") || undefined
                  }
                  tabIndex={tabStop === node.id ? 0 : -1}
                  style={{ "--layer-depth": depth, top: rowIndex * ROW_HEIGHT } as CSSProperties}
                  onFocus={() => setFocusId(node.id)}
                  onMouseEnter={() => onHover(node.id)}
                  onKeyDown={(event) => keyDown(event, row)}
                  onClick={(event) => {
                    if (suppressClick.current) return;
                    focusRow(node.id);
                    onSelect(node.id, {
                      additive: event.metaKey || event.ctrlKey,
                      range: event.shiftKey,
                      visibleIds,
                    });
                  }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      className="canvas-layer-disclosure"
                      aria-label={`${expanded ? "Collapse" : "Expand"} ${node.name}`}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleExpanded(node.id);
                        focusRow(node.id);
                      }}
                    >
                      <ChevronRightIcon
                        size={12}
                        strokeWidth={1.7}
                        className={expanded ? "is-expanded" : undefined}
                        aria-hidden="true"
                      />
                    </button>
                  ) : (
                    <span className="canvas-layer-disclosure-space" />
                  )}
                  <Icon
                    className="canvas-layer-icon"
                    size={14}
                    strokeWidth={1.6}
                    aria-hidden="true"
                  />
                  {editingId === node.id ? (
                    <LayerNameEditor
                      name={node.name}
                      onSave={(name) => finishRename(node.id, name)}
                      onCancel={() => finishRename(node.id)}
                    />
                  ) : (
                    <span
                      className="canvas-layer-name"
                      title={node.name}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        if (!locked) setEditingId(node.id);
                      }}
                    >
                      {node.name}
                    </span>
                  )}
                  <div className="canvas-layer-actions">
                    <button
                      type="button"
                      className="canvas-layer-visibility"
                      aria-label={
                        inheritedHidden && !node.hidden
                          ? `${node.name} is hidden by its parent`
                          : `${node.hidden ? "Show" : "Hide"} ${node.name}`
                      }
                      title={
                        inheritedHidden && !node.hidden
                          ? "Parent is hidden"
                          : node.hidden
                            ? "Show layer"
                            : "Hide layer"
                      }
                      disabled={inheritedHidden && !node.hidden}
                      tabIndex={tabStop === node.id ? 0 : -1}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleHidden(node.id);
                        focusRow(node.id);
                      }}
                    >
                      {node.hidden || inheritedHidden ? (
                        <EyeOffIcon size={13} strokeWidth={1.6} aria-hidden="true" />
                      ) : (
                        <EyeIcon size={13} strokeWidth={1.6} aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="canvas-layer-lock"
                      aria-label={
                        onlyParentLocked
                          ? `${node.name} is locked by its parent`
                          : `${node.locked ? "Unlock" : "Lock"} ${node.name}`
                      }
                      title={
                        onlyParentLocked
                          ? "Parent is locked"
                          : node.locked
                            ? "Unlock layer"
                            : "Lock layer"
                      }
                      disabled={onlyParentLocked}
                      tabIndex={tabStop === node.id ? 0 : -1}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleLock(node.id);
                        focusRow(node.id);
                      }}
                    >
                      {locked ? (
                        <LockKeyholeIcon size={12} strokeWidth={1.6} aria-hidden="true" />
                      ) : (
                        <UnlockKeyholeIcon size={12} strokeWidth={1.6} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {draggingIds.length > 0 && (
        <output className="canvas-layer-drag-preview" aria-live="polite">
          <span className="canvas-layer-drag-name">{dragName}</span>
          <span className="canvas-layer-drag-destination">{dropDescription}</span>
        </output>
      )}
    </aside>
  );
});
