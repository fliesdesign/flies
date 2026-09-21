import type { CanvasCamera, CanvasDocument } from "@flies/canvas";
import { useEffect, useRef, useSyncExternalStore } from "react";

import type { RealtimeFile } from "@/lib/realtime";

import "./canvas-presence.css";

export function CanvasPresence({
  realtime,
  camera,
  document,
  selection,
}: {
  realtime: RealtimeFile;
  camera: CanvasCamera;
  document: CanvasDocument;
  selection: readonly string[];
}) {
  const state = useSyncExternalStore(
    realtime.subscribe,
    realtime.getSnapshot,
    realtime.getSnapshot,
  );

  const { viewport } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );

  useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  const layer = useRef<HTMLDivElement>(null);
  const selected = useRef(selection);
  useEffect(() => {
    selected.current = selection;
  }, [selection]);
  useEffect(() => {
    const surface = layer.current?.parentElement;
    if (!surface) return;
    let cursor: { x: number; y: number } | null = null;
    let editing = false;

    const update = () =>
      realtime.presence({
        cursor:
          surface.closest("[hidden]") || window.document.visibilityState === "hidden"
            ? null
            : cursor,
        selection: [...selected.current].slice(0, 100),
        activity: editing ? "editing" : "viewing",
      });

    const move = (event: PointerEvent) => {
      if ((event.target as Element)?.closest?.("[data-canvas-ui]")) {
        cursor = null;
        update();

        return;
      }

      const bounds = surface.getBoundingClientRect();
      const view = camera.getCurrent().viewport;
      cursor = {
        x: (event.clientX - bounds.left - view.x) / view.zoom,
        y: (event.clientY - bounds.top - view.y) / view.zoom,
      };
      editing = event.buttons !== 0;
      update();
    };

    const leave = () => {
      cursor = null;
      editing = false;
      update();
    };

    const timer = setInterval(update, 200);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", move);
    surface.addEventListener("pointerleave", leave);
    window.addEventListener("blur", leave);

    return () => {
      clearInterval(timer);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", move);
      surface.removeEventListener("pointerleave", leave);
      window.removeEventListener("blur", leave);
      realtime.presence({ cursor: null, selection: [], activity: "viewing" });
    };
  }, [camera, realtime]);

  return (
    <div ref={layer} className="canvas-presence" aria-label="Live collaborators">
      {state.peers.map((peer) => (
        <div
          key={peer.connectionId}
          className="canvas-peer"
          data-highlighted={state.highlightedUserId === peer.userId || undefined}
          data-dimmed={
            Boolean(state.highlightedUserId && state.highlightedUserId !== peer.userId) || undefined
          }
        >
          {peer.selection.flatMap((id) => {
            const node = document.getFrame(id);
            if (!node || document.isHidden(id)) return [];

            return [
              <div
                key={id}
                className="canvas-peer-selection"
                style={{
                  left: node.x * viewport.zoom + viewport.x,
                  top: node.y * viewport.zoom + viewport.y,
                  width: node.width * viewport.zoom,
                  height: node.height * viewport.zoom,
                  borderColor: peer.color,
                }}
              />,
            ];
          })}
          {peer.cursor && (
            <div
              className="canvas-peer-cursor"
              data-peer-name={peer.name}
              style={{
                transform: `translate(${peer.cursor.x * viewport.zoom + viewport.x}px, ${peer.cursor.y * viewport.zoom + viewport.y}px)`,
                color: peer.color,
              }}
            >
              <svg width="19" height="23" viewBox="0 0 19 23" aria-hidden="true">
                <path
                  d="M1 1v18l5-5 4 8 4-2-4-7h7Z"
                  fill="currentColor"
                  stroke="var(--background)"
                  strokeWidth="1.5"
                />
              </svg>
              <span style={{ background: peer.color }}>
                {peer.name}
                {peer.activity === "editing" ? " · editing" : ""}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
