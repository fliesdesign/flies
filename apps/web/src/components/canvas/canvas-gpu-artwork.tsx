import type { CanvasCamera } from "@flies/canvas";
import type { CanvasDocument } from "@flies/canvas";
import type { CanvasGpuRenderer } from "@flies/canvas";
import { useLayoutEffect, useRef } from "react";

/** Own one GPU canvas per initialization, including React strict-mode remounts. */
export function CanvasGpuArtwork({
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
  const renderer = useRef<CanvasGpuRenderer | null>(null);
  const editing = useRef(editingId ?? null);

  useLayoutEffect(() => {
    editing.current = editingId ?? null;
    renderer.current?.setEditingId(editing.current);
  }, [editingId]);

  useLayoutEffect(() => {
    const element = host.current!;
    let cancelled = false;
    let failed = false;
    let instance: CanvasGpuRenderer | undefined;
    // Webviews without WebGPU keep the existing artwork renderer.
    onReady(false);
    if (!Reflect.get(navigator, "gpu")) return;
    const canvas = element.ownerDocument.createElement("canvas");
    canvas.className = "canvas-gpu-surface";
    canvas.setAttribute("aria-hidden", "true");

    const fallback = (error: unknown) => {
      if (cancelled || failed) return;
      failed = true;

      // Commit an active draft before the fallback remounts its editing overlay.
      if (canvas.dataset.renderer === "webgpu") {
        element
          .closest(".design-canvas")
          ?.querySelector<HTMLTextAreaElement>(".canvas-text-editor")
          ?.blur();
      }

      renderer.current = null;
      instance?.destroy();
      canvas.remove();
      onReady(false);
      console.warn("WebGPU artwork unavailable; using the HTML renderer.", error);
    };

    void (async () => {
      try {
        const { CanvasGpuRenderer } = await import("@flies/canvas");
        if (cancelled) return;
        element.append(canvas);
        instance = await CanvasGpuRenderer.create({ canvas, document, camera, onError: fallback });

        if (cancelled || failed) {
          instance.destroy();
          canvas.remove();

          return;
        }

        renderer.current = instance;
        instance.setEditingId(editing.current);
        canvas.dataset.renderer = "webgpu";
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

  return <div ref={host} className="canvas-gpu-host" aria-hidden="true" />;
}
