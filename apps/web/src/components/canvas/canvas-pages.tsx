import type { CanvasPage } from "@flies/canvas";
import { ChevronRightIcon, FileIcon, PlusIcon } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

import { CanvasNameEditor } from "./canvas-name-editor";

type CanvasPagesProps = {
  pages: readonly CanvasPage[];
  activePageId: string | undefined;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
};

/** The canvases in this document. Each page owns its own artwork, camera and layer tree. */
export function CanvasPages({
  pages,
  activePageId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
}: CanvasPagesProps) {
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const removable = pages.length > 1;

  function keyDown(event: KeyboardEvent<HTMLDivElement>, page: CanvasPage) {
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      setEditingId(page.id);
    } else if ((event.key === "Delete" || event.key === "Backspace") && removable) {
      event.preventDefault();
      onRemove(page.id);
    }
  }

  return (
    <section className="canvas-pages" aria-label="Pages">
      <header className="canvas-pages-header">
        <button
          type="button"
          className="canvas-pages-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRightIcon
            size={12}
            strokeWidth={1.7}
            className={open ? "is-expanded" : undefined}
            aria-hidden="true"
          />
          Pages
        </button>
        <button
          type="button"
          className="canvas-pages-add"
          aria-label="Add page"
          title="Add page"
          onClick={onAdd}
        >
          <PlusIcon size={14} strokeWidth={1.7} aria-hidden="true" />
        </button>
      </header>
      {open && (
        <div role="tablist" aria-label="Pages" className="canvas-pages-list">
          {pages.map((page) => (
            <ContextMenu key={page.id}>
              <ContextMenuTrigger
                role="tab"
                className="canvas-page-row"
                aria-selected={page.id === activePageId}
                tabIndex={page.id === activePageId ? 0 : -1}
                onClick={() => onSelect(page.id)}
                onKeyDown={(event) => keyDown(event, page)}
              >
                <FileIcon
                  className="canvas-layer-icon"
                  size={14}
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
                {editingId === page.id ? (
                  <CanvasNameEditor
                    name={page.name}
                    label="Page name"
                    onSave={(name) => {
                      onRename(page.id, name);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <span
                    className="canvas-layer-name"
                    title={page.name}
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      setEditingId(page.id);
                    }}
                  >
                    {page.name}
                  </span>
                )}
              </ContextMenuTrigger>
              <ContextMenuContent className="canvas-menu">
                <ContextMenuItem onClick={() => setEditingId(page.id)}>Rename</ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem disabled={!removable} onClick={() => onRemove(page.id)}>
                  Delete page
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      )}
    </section>
  );
}
