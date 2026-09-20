import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import {
  CanvasDocument,
  loadCanvasFrames,
  loadCanvasTheme,
  saveCanvasFrames,
  type CanvasFrame,
} from "./canvas-document";
import { EMPTY_THEME, type CanvasTheme } from "./canvas-theme";

export type { CanvasFrame } from "./canvas-document";

type CanvasDocumentOptions = {
  initialFrames?: readonly CanvasFrame[];
  initialTheme?: CanvasTheme;
  persist?: boolean;
  onSaveError?: () => void;
};

export function useCanvasDocument({
  initialFrames,
  initialTheme,
  persist = true,
  onSaveError,
}: CanvasDocumentOptions = {}) {
  const [canvasDocument] = useState(
    () =>
      new CanvasDocument(
        initialFrames ?? (persist ? loadCanvasFrames(undefined, { migrateLegacy: true }) : []),
        initialTheme ?? (persist && !initialFrames ? loadCanvasTheme() : EMPTY_THEME),
      ),
  );

  useEffect(() => {
    if (!persist) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = false;

    const flush = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!dirty) return;
      if (
        saveCanvasFrames(canvasDocument.getCommittedFrames(), undefined, canvasDocument.getTheme())
      )
        dirty = false;
      else onSaveError?.();
    };
    const unsubscribe = canvasDocument.subscribe(() => {
      dirty = true;
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    });
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };

    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flush();
    };
  }, [canvasDocument, persist, onSaveError]);

  return canvasDocument;
}

export function useCanvasFrame(canvasDocument: CanvasDocument, id: string | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      id === null ? () => {} : canvasDocument.subscribeFrame(id, listener),
    [canvasDocument, id],
  );
  const getSnapshot = useCallback(
    () => (id === null ? undefined : canvasDocument.getFrame(id)),
    [canvasDocument, id],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useCanvasSnapshot(canvasDocument: CanvasDocument) {
  return useSyncExternalStore(
    canvasDocument.subscribe,
    canvasDocument.getSnapshot,
    canvasDocument.getSnapshot,
  );
}
