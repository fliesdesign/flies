import type { CanvasCamera } from "@flies/canvas";
import type { CanvasDocument } from "@flies/canvas";
import { fitViewport } from "@flies/canvas";
import { agentActivity, type AgentActivity } from "@flies/canvas";
import { useEffect, useLayoutEffect, useReducer, useRef, useSyncExternalStore } from "react";

import "./canvas-agent-activity.css";

export function CanvasAgentActivity({
  document,
  camera,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
}) {
  const store = agentActivity(document);
  const activity = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return activity ? (
    <ActiveAgentActivity document={document} camera={camera} activity={activity} />
  ) : null;
}

// Camera and document subscriptions only exist while an agent has a visible footprint.
function ActiveAgentActivity({
  document,
  camera,
  activity,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  activity: AgentActivity;
}) {
  useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot);
  const { viewport, size } = useSyncExternalStore(
    camera.subscribe,
    camera.getSnapshot,
    camera.getSnapshot,
  );
  const layer = useRef<HTMLDivElement>(null);
  const animated = useRef(new WeakMap<Element, string>());
  const [, refreshGeometry] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    const cleanups = activity.nodeIds.map((id) => document.subscribeFrame(id, refreshGeometry));
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [activity.nodeIds, document]);
  const animations = useRef(new Map<Element, Animation>());
  useLayoutEffect(
    () => () => {
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    },
    [],
  );
  useLayoutEffect(() => {
    if (
      !activity.changedIds.length ||
      Date.now() - activity.changedAt > 600 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const canvas = layer.current?.parentElement;
    if (!canvas || canvas.closest("[hidden]")) return;
    const change = `${activity.sequence}:${activity.changedAt}`;
    for (const id of document.getRootIds(activity.changedIds)) {
      const element = canvas.querySelector<HTMLElement>(
        `.canvas-frame-position[data-frame-id="${CSS.escape(id)}"]`,
      );
      if (!element || animated.current.get(element) === change) continue;
      animated.current.set(element, change);
      animations.current.get(element)?.cancel();
      const opacity = Number(getComputedStyle(element).opacity);
      const animation = element.animate([{ opacity: opacity * 0.25 }, { opacity }], {
        duration: 320,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
      });
      animations.current.set(element, animation);
      animation.addEventListener(
        "finish",
        () => {
          if (animations.current.get(element) === animation) animations.current.delete(element);
        },
        { once: true },
      );
    }
    // A pan or live drag only moves the footprint; it must not rescan every canvas node for fades.
  }, [activity.changedAt, activity.changedIds, activity.sequence, document]);
  const nodes = activity.nodeIds.flatMap((id) => {
    const node = document.getFrame(id);
    return node && !document.isHidden(id) ? [node] : [];
  });
  // Deleted nodes retain their last footprint briefly; existing nodes always use live geometry.
  const targets = nodes.length ? nodes : activity.removed;
  const bounds = targets.length
    ? targets.reduce(
        (box, node) => ({
          left: Math.min(box.left, node.x),
          top: Math.min(box.top, node.y),
          right: Math.max(box.right, node.x + node.width),
          bottom: Math.max(box.bottom, node.y + node.height),
        }),
        { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
      )
    : null;
  const screen = bounds
    ? {
        left: bounds.left * viewport.zoom + viewport.x,
        top: bounds.top * viewport.zoom + viewport.y,
        width: (bounds.right - bounds.left) * viewport.zoom,
        height: (bounds.bottom - bounds.top) * viewport.zoom,
      }
    : null;
  const offscreen =
    screen &&
    (screen.left + screen.width < 0 ||
      screen.top + screen.height < 0 ||
      screen.left > size.x ||
      screen.top > size.y);
  return (
    <div ref={layer} className="canvas-agent-layer" data-phase={activity.phase}>
      {screen && !offscreen && (
        <div className="canvas-agent-outline" aria-hidden="true" style={screen}>
          <span className="canvas-agent-label">Agent</span>
        </div>
      )}
      <output className="canvas-agent-status" aria-live="polite" aria-atomic="true">
        <span className="canvas-agent-dot" aria-hidden="true" />
        <span>
          Agent <span className="canvas-agent-separator">·</span> {activity.label}
        </span>
        {offscreen && (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              camera.setViewport(fitViewport(targets, camera.getCurrent().size));
              camera.flush();
            }}
          >
            Show
          </button>
        )}
      </output>
    </div>
  );
}
