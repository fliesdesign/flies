import { CanvasCamera } from "@flies/canvas";
import { CanvasDocument } from "@flies/canvas";
import { agentActivity } from "@flies/canvas";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { CanvasAgentActivity } from "@/components/canvas/canvas-agent-activity";

export function mountActivity() {
  const doc = new CanvasDocument([
    { id: "agent-frame", name: "Frame", x: 100, y: 80, width: 200, height: 100 },
  ]);

  const camera = new CanvasCamera();
  camera.setSize({ x: 800, y: 600 });
  camera.flush();
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    background: "#0c0c0c",
  });
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() =>
    root.render(
      <>
        <div
          className="canvas-frame-position"
          data-frame-id="agent-frame"
          style={{ width: 200, height: 100, opacity: 0.7 }}
        />
        <CanvasAgentActivity document={doc} camera={camera} />
      </>,
    ),
  );
  const activity = agentActivity(doc);
  const sequence = activity.begin("update_node", { nodeId: "agent-frame" });

  return {
    change: () =>
      activity.capture(doc, () => doc.update({ ...doc.getFrame("agent-frame")!, x: 120 })),
    pan: () => {
      camera.setViewport({ x: 30, y: 40, zoom: 2 });
      camera.flush();
    },
    drag: () => {
      doc.beginGesture("agent-frame");
      doc.preview({ ...doc.getFrame("agent-frame")!, x: 160 });
    },
    saving: () => activity.saving(sequence),
    finish: () => activity.finish(sequence),
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}
