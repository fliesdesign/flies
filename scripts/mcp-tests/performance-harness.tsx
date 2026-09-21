import type { CanvasFrame } from "@flies/canvas";
import { moveSelection } from "@flies/canvas";
/* eslint-disable no-await-in-loop -- Browser performance phases run on consecutive frames. */
import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { DesignCanvas, type CanvasControls } from "@/components/canvas/design-canvas";

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const round = (value: number) => Math.round(value * 100) / 100;

function populatedArtboards(): CanvasFrame[] {
  const nodes: CanvasFrame[] = [];

  for (let board = 0; board < 3; board++) {
    const rootId = `perf-board-${board}`;
    const origin = board * 960;
    nodes.push({
      id: rootId,
      name: `Page ${board + 1}`,
      x: origin,
      y: 0,
      width: 900,
      height: 1100,
      fill: "#ffffff",
    });

    for (let card = 0; card < 60; card++) {
      const id = `${rootId}-card-${card}`;
      const x = origin + 24 + (card % 5) * 174;
      const y = 24 + Math.floor(card / 5) * 88;
      nodes.push(
        {
          id,
          name: `Card ${card + 1}`,
          parentId: rootId,
          x,
          y,
          width: 162,
          height: 76,
          fill: "#f7f7f7",
          cornerRadius: 8,
          borderWidth: 1,
          borderColor: "#dddddd",
          shadows: [{ offsetX: 0, offsetY: 2, blur: 4, spread: 0, color: "#00000018" }],
        },
        {
          id: `${id}-title`,
          name: "Title",
          kind: "text",
          parentId: id,
          x: x + 10,
          y: y + 10,
          width: 142,
          height: 20,
          text: `Result ${card + 1}`,
          fontSize: 14,
          fontWeight: 600,
          color: "#222222",
        },
        {
          id: `${id}-body`,
          name: "Description",
          kind: "text",
          parentId: id,
          x: x + 10,
          y: y + 32,
          width: 142,
          height: 18,
          text: "Editable native text",
          fontSize: 11,
          color: "#777777",
        },
        {
          id: `${id}-badge`,
          name: "Badge",
          kind: "rectangle",
          parentId: id,
          x: x + 10,
          y: y + 55,
          width: 40,
          height: 10,
          cornerRadius: 5,
          fill: "#b8d2ef",
        },
      );
    }
  }

  return nodes;
}

export async function mountPerformance({ probe = true }: { probe?: boolean } = {}) {
  const host = document.createElement("div");
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "9999",
    background: "#0c0c0c",
  });
  document.body.append(host);
  const root = createRoot(host);
  const renders = new Map<string, number>();
  const mounts = new Map<string, number>();

  function RenderProbe({ frame }: { frame: CanvasFrame }) {
    renders.set(frame.id, (renders.get(frame.id) ?? 0) + 1);
    useEffect(() => {
      mounts.set(frame.id, (mounts.get(frame.id) ?? 0) + 1);
    }, [frame.id]);

    return null;
  }

  const controls = await new Promise<CanvasControls>((resolve) => {
    flushSync(() =>
      root.render(
        <DesignCanvas
          initialFrames={populatedArtboards()}
          persist={false}
          FrameContent={probe ? RenderProbe : undefined}
          onReady={(value) => {
            if (value) resolve(value);
          }}
        />,
      ),
    );
  });

  controls.setPanelsOpen(false);
  controls.camera.setViewport({ x: 60, y: 60, zoom: 0.38 });
  controls.camera.flush();
  await nextFrame();
  await nextFrame();

  async function measure(phase: "pan" | "zoom" | "culling" | "drag") {
    const zoom = phase === "culling" ? 0.8 : 0.38;
    controls.camera.setViewport({ x: 60, y: 60, zoom });
    controls.camera.flush();
    await nextFrame();
    await nextFrame();

    const startingElements = new Map(
      [...host.querySelectorAll<HTMLElement>(".canvas-frame-position")].map((element) => [
        element.dataset.frameId!,
        element,
      ]),
    );

    const sampleElement = host.querySelector<HTMLElement>(
      '[data-frame-id="perf-board-0-card-4-title"]',
    )!;

    const sampleBefore = sampleElement.getBoundingClientRect();
    renders.clear();
    mounts.clear();
    let frameStyleChanges = 0;
    let cameraStyleChanges = 0;

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target as HTMLElement;
        if (target.classList.contains("canvas-frame-position")) frameStyleChanges++;
        if (target.classList.contains("canvas-world")) cameraStyleChanges++;
      }
    });

    observer.observe(host, { subtree: true, attributes: true, attributeFilter: ["style"] });

    const subtree = controls.document
      .getDescendantIds(["perf-board-0"])
      .map((id) => controls.document.getFrame(id)!);

    if (phase === "drag") {
      controls.select("perf-board-0");
      controls.document.beginGesture(subtree.map((node) => node.id));
    }

    const intervals: number[] = [];
    let last = await nextFrame();

    for (let tick = 0; tick < 80; tick++) {
      if (phase === "drag")
        controls.previewMany(
          moveSelection(subtree, ["perf-board-0"], { x: tick * 0.5, y: tick * 0.25 }),
        );
      else
        controls.camera.setViewport({
          x: 60 - (phase === "culling" ? tick * 5 : tick * 0.25),
          y: 60 - tick * 0.1,
          zoom: phase === "zoom" ? 0.38 + tick * 0.0005 : zoom,
        });
      const now = await nextFrame();
      if (tick >= 10) intervals.push(now - last);
      last = now;
    }

    controls.flushPreview();
    controls.camera.flush();
    await nextFrame();
    observer.disconnect();
    const endingElements = [...host.querySelectorAll<HTMLElement>(".canvas-frame-position")];

    const stableElements = endingElements.filter((element) =>
      startingElements.has(element.dataset.frameId!),
    );

    const remountedNodes = stableElements.filter(
      (element) => startingElements.get(element.dataset.frameId!) !== element,
    ).length;

    const stableFrameRenders = [...renders]
      .filter(([id]) => startingElements.has(id))
      .reduce((sum, [, count]) => sum + count, 0);

    const samples = intervals.toSorted((a, b) => a - b);

    const result = {
      phase,
      contentProbe: probe,
      sampleMovement: {
        x: round(sampleElement.getBoundingClientRect().x - sampleBefore.x),
        y: round(sampleElement.getBoundingClientRect().y - sampleBefore.y),
      },
      frameLabelHeight: round(
        host.querySelector(".canvas-frame-label")!.getBoundingClientRect().height,
      ),
      totalNodes: controls.document.getSceneFrames().length,
      mountedNodes: endingElements.length,
      frameContentRenders: [...renders.values()].reduce((sum, value) => sum + value, 0),
      stableFrameRenders,
      frameContentMounts: [...mounts.values()].reduce((sum, value) => sum + value, 0),
      remountedNodes,
      frameStyleChanges,
      cameraStyleChanges,
      meanFrameMs: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
      p95FrameMs: round(samples[Math.ceil(samples.length * 0.95) - 1]),
      maxFrameMs: round(samples[samples.length - 1]),
    };

    if (phase === "drag") controls.document.endGesture(true);

    return result;
  }

  return {
    measure,
    dispose: () => {
      root.unmount();
      host.remove();
    },
  };
}
