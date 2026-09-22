import type { CanvasCamera } from "@flies/canvas";
import type { CanvasDocument } from "@flies/canvas";
import type { CanvasWebglRenderer } from "@flies/canvas";
import { useLayoutEffect, useRef } from "react";

/** Own one WebGL canvas per initialization, including React strict-mode remounts. */
export function CanvasWebglArtwork({
  document,
  camera,
  editingId,
  onReady,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  editingId?: string | null;
  onReady: (ready: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<CanvasWebglRenderer | null>(null);
  const editing = useRef(editingId ?? null);

  useLayoutEffect(() => {
    editing.current = editingId ?? null;
    renderer.current?.setEditingId(editing.current);
  }, [editingId]);

  useLayoutEffect(() => {
    const element = host.current!;
    let cancelled = false;
    let failed = false;
    let instance: CanvasWebglRenderer | undefined;
    onReady(false);
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.className = "canvas-webgl-surface";
    canvas.setAttribute("aria-hidden", "true");

    const fallback = (error: unknown) => {
      if (cancelled || failed) return;
      failed = true;

      // Commit an active draft before the fallback remounts its editing overlay.
      if (canvas.dataset.renderer === "webgl2") {
        element
          .closest(".design-canvas")
          ?.querySelector<HTMLElement>(".canvas-text-editor")
          ?.blur();
      }

      renderer.current = null;
      instance?.destroy();
      canvas.remove();
      onReady(false);
      console.warn("WebGL artwork unavailable; using the HTML renderer.", error);
    };

    void (async () => {
      try {
        const { CanvasWebglRenderer } = await import("@flies/canvas");
        if (cancelled) return;
        element.append(canvas);
        instance = await CanvasWebglRenderer.create({
          canvas,
          document,
          camera,
          onError: fallback,
        });

        if (cancelled || failed) {
          instance.destroy();
          canvas.remove();

          return;
        }

        renderer.current = instance;
        instance.setEditingId(editing.current);
        onReady(true);
      } catch (error) {
        fallback(error);
      }
    })();

    return () => {
      cancelled = true;
      renderer.current = null;
      instance?.destroy();
      canvas.remove();
    };
  }, [document, camera, onReady]);

  return <div ref={host} className="canvas-webgl-host" aria-hidden="true" />;
}
