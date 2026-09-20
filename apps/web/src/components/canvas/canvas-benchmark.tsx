import { createMixedBenchmarkNodes } from "@flies/canvas";
import { moveSelection, resizeSelection } from "@flies/canvas";
import { getClippingAncestors, getVisibleBoundsInRoundedClips } from "@flies/canvas";
import { changeCanvasProperty } from "@flies/canvas";
import { viewportBounds } from "@flies/canvas";
/* eslint-disable no-await-in-loop -- Benchmark frames and phases must run sequentially. */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import { measureCanvasTextHeight } from "./canvas-node-content";
import { DesignCanvas, type CanvasControls } from "./design-canvas";

type PhaseResult = {
  phase: string;
  meanFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  framesOver34ms: number;
  mountedNodes: number;
  visibleNodes: number;
  canvasDomElements: number;
  editorDomElements: number;
  documentDomElements: number;
  propertiesPanelElements: number;
  layerRows: number;
  frameStyleChanges: number;
  cameraStyleChanges: number;
};
type SceneResult = {
  totalNodes: number;
  rootBoards: number;
  nodesByKind: Record<string, number>;
  autoLayoutFrames: number;
  panels: { layers: boolean; properties: boolean };
  sceneReadyMs: number;
  phases: PhaseResult[];
  heapMB: number | null;
  history: unknown;
};
const COUNTS = [1000, 5000, 10000];
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const round = (number: number) => Math.round(number * 100) / 100;

async function settle(frames = 3) {
  for (let i = 0; i < frames; i++) await nextFrame();
}

function editorElement(controls: CanvasControls) {
  return controls.surface.closest(".canvas-editor") ?? controls.surface;
}

function visiblePanels(controls: CanvasControls) {
  const editor = editorElement(controls);
  const visible = (selector: string) => {
    const panel = editor.querySelector(selector);
    return Boolean(
      panel && panel.getBoundingClientRect().width && getComputedStyle(panel).display !== "none",
    );
  };
  return { layers: visible(".canvas-layers"), properties: visible(".canvas-properties") };
}

async function measurePhase(
  controls: CanvasControls,
  phase: string,
  update: (index: number) => void,
  stopped: () => boolean,
): Promise<PhaseResult> {
  let frameStyleChanges = 0;
  let cameraStyleChanges = 0;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const element = mutation.target as Element;
      if (element.classList.contains("canvas-frame-position")) frameStyleChanges++;
      if (element.classList.contains("canvas-world")) cameraStyleChanges++;
    }
  });
  observer.observe(controls.surface, {
    attributes: true,
    attributeFilter: ["style"],
    subtree: true,
  });
  const intervals: number[] = [];
  let last = await nextFrame();
  try {
    for (let i = 0; i < 120; i++) {
      if (stopped() || document.visibilityState !== "visible")
        throw new Error("Benchmark stopped. Keep this window visible while measuring.");
      update(i);
      const now = await nextFrame();
      if (i >= 20) intervals.push(now - last);
      last = now;
    }
    controls.flushPreview();
    controls.camera.flush();
    await settle(1);
  } finally {
    observer.disconnect();
  }
  intervals.sort((a, b) => a - b);
  const editor = editorElement(controls);
  const mounted = [...controls.surface.querySelectorAll<HTMLElement>(".canvas-frame-position")];
  const current = controls.camera.getCurrent();
  const view = viewportBounds(current.viewport, current.size, 0);
  const visibleNodes = mounted.filter((element) => {
    const node = controls.document.getFrame(element.dataset.frameId ?? "");
    if (!node || controls.document.isHidden(node.id)) return false;
    const bounds = getVisibleBoundsInRoundedClips(
      node,
      getClippingAncestors(controls.document, node),
    );
    return (
      bounds &&
      bounds.x < view.x + view.width &&
      bounds.x + bounds.width > view.x &&
      bounds.y < view.y + view.height &&
      bounds.y + bounds.height > view.y
    );
  }).length;
  return {
    phase,
    meanFrameMs: round(intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length),
    p95FrameMs: round(intervals[Math.ceil(intervals.length * 0.95) - 1]),
    maxFrameMs: round(intervals[intervals.length - 1]),
    framesOver34ms: intervals.filter((interval) => interval > 34).length,
    mountedNodes: mounted.length,
    visibleNodes,
    canvasDomElements: controls.surface.querySelectorAll("*").length,
    editorDomElements: editor.querySelectorAll("*").length + 1,
    documentDomElements: document.querySelectorAll("*").length,
    propertiesPanelElements: editor.querySelectorAll(".canvas-properties *").length,
    layerRows: editor.querySelectorAll('[role="treeitem"]').length,
    frameStyleChanges,
    cameraStyleChanges,
  };
}

export default function CanvasBenchmark() {
  const [scene, setScene] = useState(() => ({ nodes: createMixedBenchmarkNodes(1000), key: 0 }));
  const [countChoice, setCountChoice] = useState("all");
  const [results, setResults] = useState<SceneResult[]>([]);
  const [status, setStatus] = useState("Ready");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState("");
  const readyRef = useRef<((controls: CanvasControls) => void) | null>(null);
  const controlsRef = useRef<CanvasControls | null>(null);
  const stoppedRef = useRef(false);
  const onReady = useCallback((controls: CanvasControls | null) => {
    controlsRef.current = controls;
    if (controls && readyRef.current) {
      readyRef.current(controls);
      readyRef.current = null;
    }
  }, []);
  useEffect(
    () => () => {
      stoppedRef.current = true;
    },
    [],
  );

  async function run() {
    stoppedRef.current = false;
    setRunning(true);
    setResults([]);
    setReport("");
    const samples: SceneResult[] = [];
    try {
      for (const count of countChoice === "all" ? COUNTS : [Number(countChoice)]) {
        setStatus(`Loading ${count.toLocaleString()} nodes…`);
        const start = performance.now();
        const controls = await new Promise<CanvasControls>((resolve) => {
          readyRef.current = resolve;
          setScene((previous) => ({
            nodes: createMixedBenchmarkNodes(count),
            key: previous.key + 1,
          }));
        });
        controls.setPanelsOpen(true);
        controls.select("mixed-0-title");
        await settle();
        controls.camera.setViewport({ x: 80, y: 60, zoom: 1 });
        controls.camera.flush();
        await settle();
        await Promise.all(
          [...controls.surface.querySelectorAll("img")].map((image) =>
            image.decode().catch(() => {}),
          ),
        );
        const panels = visiblePanels(controls);
        if (!panels.layers || !panels.properties)
          throw new Error(
            "Widen the window so both Layers and Properties panels can stay visible.",
          );
        const sceneReadyMs = round(performance.now() - start);
        const nodes = controls.document.getFrames();
        const nodesByKind: Record<string, number> = {};
        for (const node of nodes)
          nodesByKind[node.kind ?? "frame"] = (nodesByKind[node.kind ?? "frame"] ?? 0) + 1;
        const phases: PhaseResult[] = [];
        const phase = async (name: string, update: (index: number) => void) => {
          setStatus(`${count.toLocaleString()} nodes · ${name}`);
          phases.push(await measurePhase(controls, name, update, () => stoppedRef.current));
        };
        await phase("pan-100%-text-selected", (i) => {
          for (let sample = 0; sample < 4; sample++)
            controls.camera.setViewport({ x: 80 - (i + sample / 4) * 5, y: 60 - i * 2, zoom: 1 });
        });
        await phase("zoom-100%-10%-full-detail", (i) => {
          controls.camera.setViewport({ x: 80, y: 60, zoom: 1 - (i / 119) * 0.9 });
        });
        controls.camera.setViewport({ x: 80, y: 60, zoom: 1 });
        controls.camera.flush();
        const root = controls.document.getFrame("mixed-0-frame")!;
        const subtree = controls.document
          .getDescendantIds([root.id])
          .map((id) => controls.document.getFrame(id)!);
        controls.select(root.id);
        controls.document.beginGesture(subtree.map((node) => node.id));
        await settle();
        await phase("drag-10-node-subtree", (i) => {
          for (let sample = 0; sample < 4; sample++)
            controls.previewMany(
              moveSelection(subtree, [root.id], { x: i + sample / 4, y: i / 2 }),
            );
        });
        controls.flushPreview();
        controls.document.endGesture();
        controls.document.undo();

        const layout = controls.document.getFrame("mixed-0-layout")!;
        const layoutTree = controls.document
          .getDescendantIds([layout.id])
          .map((id) => controls.document.getFrame(id)!);
        controls.select(layout.id);
        controls.document.beginGesture(layoutTree.map((node) => node.id));
        await settle();
        await phase("resize-auto-layout-frame", (i) => {
          const width = layout.width + Math.sin((i / 119) * Math.PI) * 120;
          controls.previewMany(
            resizeSelection(layoutTree, [layout.id], layout, { ...layout, width }),
          );
        });
        controls.flushPreview();
        controls.document.endGesture(true);

        const title = controls.document.getFrame("mixed-0-title")!;
        const propertyNodes = controls.document.getFrames();
        controls.select(title.id);
        controls.document.beginGesture(title.id);
        await settle();
        await phase("text-font-size-preview", (i) => {
          controls.previewMany(
            changeCanvasProperty(
              propertyNodes,
              [title.id],
              "fontSize",
              20 + (i % 18),
              measureCanvasTextHeight,
            ),
          );
        });
        controls.flushPreview();
        controls.document.endGesture(true);
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } })
          .memory;
        const result: SceneResult = {
          totalNodes: nodes.length,
          rootBoards: nodes.filter((node) => !node.parentId).length,
          nodesByKind,
          autoLayoutFrames: nodes.filter(
            (node) => (!node.kind || node.kind === "frame") && node.layout,
          ).length,
          panels,
          sceneReadyMs,
          phases,
          heapMB: memory ? round(memory.usedJSHeapSize / 1024 / 1024) : null,
          history: controls.document.getHistoryStats(),
        };
        samples.push(result);
        setResults([...samples]);
      }
      const controls = controlsRef.current;
      setReport(
        JSON.stringify(
          {
            recordedAt: new Date().toISOString(),
            userAgent: navigator.userAgent,
            build: import.meta.env.MODE,
            viewport: controls?.camera.getCurrent().size,
            window: { width: window.innerWidth, height: window.innerHeight },
            devicePixelRatio: window.devicePixelRatio,
            methodology:
              "Real typed document nodes and production HTML/CSS renderer; nested frames/groups, text, embedded PNG images, rectangles, pen paths and auto layout. Layers and Properties remain open, with text selected during pan/zoom. Exact total node counts (not boards or fake DOM content). Persistent storage disabled. Scene-ready includes fixture creation, initial fit, panel opening, camera reset, six settling frames and mounted image decode. Each phase uses 20 warmup + 100 sampled animation-frame intervals; pan and subtree drag submit four coalesced samples/tick. Five phases per scene. Mounted/visible nodes and DOM counts include ancestors/overscan and are measured after each phase; visible count intersects rounded ancestor clips and viewport. Editor DOM includes both panels, document DOM also includes benchmark controls. These are display frame intervals, not hardware input latency. Optional Chromium heap is coarse, not process/peak memory. No baseline speedup claim.",
            results: samples,
          },
          null,
          2,
        ),
      );
      setStatus("Complete");
    } catch (error) {
      controlsRef.current?.flushPreview();
      controlsRef.current?.document.endGesture(true);
      setStatus(error instanceof Error ? error.message : "Benchmark failed");
    } finally {
      setRunning(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([report], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "canvas-browser-benchmark.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <>
      <DesignCanvas key={scene.key} initialFrames={scene.nodes} persist={false} onReady={onReady} />
      <section
        aria-label="Canvas performance benchmark"
        className={
          running
            ? "fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg"
            : "fixed top-4 right-4 z-50 max-h-[90vh] w-[min(540px,calc(100vw-32px))] overflow-auto rounded-xl border bg-popover p-4 text-xs shadow-lg"
        }
      >
        {!running && (
          <>
            <h1 className="mb-2 text-sm font-semibold">Canvas performance benchmark</h1>
            <p className="mb-3 text-muted-foreground">
              Real documents with 1,000 / 5,000 / 10,000 mixed nodes. Both panels stay open. Five
              phases take about ten seconds per scene at 60 Hz. Your saved canvas is untouched.
            </p>
            <div className="mb-3 flex items-center gap-2">
              <label className="sr-only" htmlFor="benchmark-count">
                Benchmark node count
              </label>
              <select
                id="benchmark-count"
                value={countChoice}
                onChange={(event) => setCountChoice(event.target.value)}
                className="h-8 rounded-md border bg-input px-2"
              >
                <option value="all">All sizes</option>
                {COUNTS.map((count) => (
                  <option key={count} value={count}>
                    {count.toLocaleString()} nodes
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={run}>
                Run benchmarks
              </Button>
              {report && (
                <Button size="sm" variant="secondary" onClick={download}>
                  Download results
                </Button>
              )}
            </div>
          </>
        )}
        <output className={running ? "whitespace-nowrap" : "mb-3 block"}>{status}</output>
        {running && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              stoppedRef.current = true;
            }}
          >
            Stop
          </Button>
        )}
        {!running && (
          <>
            {results.map((result) => (
              <div key={result.totalNodes} className="mt-3 border-t pt-3">
                <h2 className="mb-2 font-semibold">
                  {result.totalNodes.toLocaleString()} nodes · ready {result.sceneReadyMs} ms
                </h2>
                <table className="w-full text-left tabular-nums">
                  <thead>
                    <tr>
                      <th>Phase</th>
                      <th>Mean</th>
                      <th>p95</th>
                      <th>Mounted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.phases.map((item) => (
                      <tr key={item.phase}>
                        <td className="py-1">{item.phase}</td>
                        <td>{item.meanFrameMs} ms</td>
                        <td>{item.p95FrameMs} ms</td>
                        <td>{item.mountedNodes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {report && (
              <details className="mt-3">
                <summary>JSON report</summary>
                <textarea
                  aria-label="Benchmark JSON report"
                  readOnly
                  value={report}
                  className="mt-2 h-40 w-full rounded border bg-input p-2 font-mono text-[10px]"
                />
              </details>
            )}
            <p className="mt-3 text-muted-foreground">
              Keep this window visible. Results depend on hardware, display refresh, and browser.
              The 10% overview keeps visible content at full detail.
            </p>
          </>
        )}
      </section>
    </>
  );
}
