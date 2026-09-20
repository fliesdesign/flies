import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";
import { setCanvasInspection } from "@/lib/canvas-inspection";

export async function mountSnapshotFixture() {
  setCanvasInspection(true);
  const host = document.createElement("div");
  host.dataset.snapshotFixture = "";
  Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "1" });
  document.body.append(host);
  const root = createRoot(host);
  const controls = await new Promise<CanvasControls>((resolve) => {
    flushSync(() =>
      root.render(
        <DesignCanvas
          initialFrames={[]}
          persist={false}
          onReady={(value) => {
            if (value) resolve(value);
          }}
        />,
      ),
    );
  });
  controls.setPanelsOpen(false);
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
  controls.camera.flush();
  return {
    controls,
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}
