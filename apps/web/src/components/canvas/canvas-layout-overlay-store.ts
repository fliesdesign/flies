import type { CanvasDocument } from "@flies/canvas";
import { useMemo, useSyncExternalStore } from "react";

/** A scalar snapshot avoids rebuilding a child list for each notification in a reflow. */
export class LayoutOverlayStore {
  private revision = 0;
  constructor(
    private readonly document: CanvasDocument,
    private readonly id: string | undefined,
    private readonly children: readonly string[],
    revision: number,
  ) {
    this.revision = revision;
  }

  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => {
    const ids = this.id ? [this.id, ...this.children] : [];
    const related = new Set(ids);

    for (const id of ids) {
      let parent = this.document.getFrame(id)?.parentId;

      while (parent && !related.has(parent)) {
        related.add(parent);
        parent = this.document.getFrame(parent)?.parentId;
      }
    }

    const subscriptions = [...related].map((id) =>
      this.document.subscribeFrame(id, () => {
        this.revision++;
        listener();
      }),
    );

    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  };
}

export function useLayoutOverlayStore(
  document: CanvasDocument,
  id: string | undefined,
  children: readonly string[],
  revision: number,
) {
  const store = useMemo(
    () => new LayoutOverlayStore(document, id, children, revision),
    [document, id, children, revision],
  );

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
