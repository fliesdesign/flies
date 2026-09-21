import { setCanvasInspection, type CanvasFrame } from "@flies/canvas";
import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";

function populatedFrames(): CanvasFrame[] {
  const image = document.createElement("canvas");
  image.width = image.height = 16;
  const context = image.getContext("2d")!;
  context.fillStyle = "#0000ff";
  context.fillRect(0, 0, 16, 16);

  return [
    {
      id: "board",
      name: "Page one",
      x: 120,
      y: 100,
      width: 320,
      height: 320,
      fill: "#ffffff",
      cornerRadius: 20,
    },
    {
      id: "red",
      name: "Red",
      kind: "rectangle",
      parentId: "board",
      x: 150,
      y: 150,
      width: 100,
      height: 80,
      fill: "#ff0000",
      cornerRadius: 16,
    },
    {
      id: "clipped",
      name: "Clipped",
      kind: "rectangle",
      parentId: "board",
      x: 380,
      y: 100,
      width: 120,
      height: 80,
      fill: "#00ff00",
    },
    {
      id: "text",
      name: "Editable text",
      kind: "text",
      parentId: "board",
      x: 150,
      y: 260,
      width: 220,
      height: 32,
      text: "WebGPU text",
      fontSize: 24,
      color: "#000000",
    },
    {
      id: "image",
      name: "Blue image",
      kind: "image",
      parentId: "board",
      x: 150,
      y: 320,
      width: 40,
      height: 40,
      src: image.toDataURL(),
    },
    { id: "board-two", name: "Page two", x: 500, y: 100, width: 300, height: 320, fill: "#ffffff" },
    {
      id: "alpha",
      name: "Opacity group",
      kind: "group",
      parentId: "board-two",
      x: 520,
      y: 120,
      width: 180,
      height: 120,
      opacity: 0.5,
    },
    {
      id: "alpha-red",
      name: "Under",
      kind: "rectangle",
      parentId: "alpha",
      x: 520,
      y: 120,
      width: 180,
      height: 120,
      fill: "#ff0000",
    },
    {
      id: "alpha-blue",
      name: "Over",
      kind: "rectangle",
      parentId: "alpha",
      x: 560,
      y: 150,
      width: 80,
      height: 60,
      fill: "#0000ff",
    },
    {
      id: "board-three",
      name: "Page three",
      x: 860,
      y: 100,
      width: 300,
      height: 320,
      fill: "#ffffff",
    },
    {
      id: "border",
      name: "Border",
      kind: "rectangle",
      parentId: "board-three",
      x: 890,
      y: 130,
      width: 100,
      height: 80,
      fill: "#ffff00",
      borderWidth: 4,
      borderColor: "#000000",
    },
    {
      id: "hidden",
      name: "Hidden",
      kind: "rectangle",
      parentId: "board-three",
      x: 1010,
      y: 130,
      width: 100,
      height: 80,
      fill: "#ff0000",
      hidden: true,
    },
    {
      id: "shadows",
      name: "Shadows",
      kind: "rectangle",
      parentId: "board-three",
      x: 890,
      y: 260,
      width: 100,
      height: 80,
      fill: "#ffffff",
      shadows: [
        { offsetX: 8, offsetY: 0, blur: 0, spread: 0, color: "#000000" },
        { offsetX: 4, offsetY: 0, blur: 0, spread: 0, color: "#000000", inset: true },
      ],
    },
  ];
}

export async function mountGpuFixture({ strict = false }: { strict?: boolean } = {}) {
  const host = document.createElement("div");
  host.dataset.gpuFixture = "";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    background: "#0c0c0c",
  });
  document.body.append(host);
  const root = createRoot(host);

  const controls = await new Promise<CanvasControls>((resolve) => {
    const editor = (
      <DesignCanvas
        initialFrames={populatedFrames()}
        persist={false}
        onReady={(value) => {
          if (value) resolve(value);
        }}
      />
    );

    flushSync(() => root.render(strict ? <StrictMode>{editor}</StrictMode> : editor));
  });

  controls.setPanelsOpen(false);
  // Let the editor's initial ResizeObserver fit finish before fixing test coordinates.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  controls.camera.setViewport({ x: 0, y: 0, zoom: 1 });
  controls.camera.flush();

  return {
    controls,
    setInspection: setCanvasInspection,
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}
