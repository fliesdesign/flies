/* eslint-disable no-await-in-loop -- Benchmark frames and phases must run sequentially. */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { createBenchmarkFrames } from "@/lib/canvas-benchmark-fixtures";

import { BenchmarkFrameContent } from "./benchmark-content";
import { DesignCanvas, type CanvasControls } from "./design-canvas";

type PhaseResult = {
  phase: string;
  meanFrameMs: number;
  p95FrameMs: number;
  maxFrameMs: number;
  framesOver34ms: number;
  mountedFrames: number;
  domElements: number;
  frameStyleChanges: number;
  cameraStyleChanges: number;
};
type SceneResult = {
  totalFrames: number;
  sceneReadyMs: number;
  phases: PhaseResult[];
  heapMB: number | null;
  history: unknown;
};
const COUNTS = [1000, 5000, 10000];
const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const round = (number: number) => Math.round(number * 100) / 100;

async function settle(frames = 20) {
  for (let i = 0; i < frames; i++) await nextFrame();
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
  } finally {
    observer.disconnect();
  }
  intervals.sort((a, b) => a - b);
  return {
    phase,
    meanFrameMs: round(intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length),
    p95FrameMs: round(intervals[Math.ceil(intervals.length * 0.95) - 1]),
    maxFrameMs: round(intervals[intervals.length - 1]),
    framesOver34ms: intervals.filter((interval) => interval > 34).length,
    mountedFrames: controls.surface.querySelectorAll(".canvas-frame-position").length,
    domElements: controls.surface.querySelectorAll("*").length,
    frameStyleChanges,
    cameraStyleChanges,
  };
}

export default function CanvasBenchmark() {
  const [scene, setScene] = useState(() => ({ frames: createBenchmarkFrames(1000), key: 0 }));
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
      for (const count of COUNTS) {
        setStatus(`Loading ${count.toLocaleString()} frames…`);
        const start = performance.now();
        const controls = await new Promise<CanvasControls>((resolve) => {
          readyRef.current = resolve;
          setScene((previous) => ({ frames: createBenchmarkFrames(count), key: previous.key + 1 }));
        });
        await settle(3);
        controls.camera.setViewport({ x: 60, y: 90, zoom: 1 });
        controls.camera.flush();
        await settle(3);
        const sceneReadyMs = round(performance.now() - start);
        await settle();
        const phases: PhaseResult[] = [];
        setStatus(`${count.toLocaleString()} frames · pan at 100%`);
        phases.push(
          await measurePhase(
            controls,
            "pan-100%",
            (i) => {
              // Multiple input samples within one display frame exercise coalescing.
              for (let sample = 0; sample < 4; sample++)
                controls.camera.setViewport({
                  x: 60 - (i + sample / 4) * 5,
                  y: 90 - i * 2,
                  zoom: 1,
                });
            },
            () => stoppedRef.current,
          ),
        );
        setStatus(`${count.toLocaleString()} frames · zoom`);
        phases.push(
          await measurePhase(
            controls,
            "zoom-35%-100%",
            (i) => {
              controls.camera.setViewport({
                x: 60,
                y: 90,
                zoom: 0.675 + Math.cos((i / 119) * Math.PI * 2) * 0.325,
              });
            },
            () => stoppedRef.current,
          ),
        );
        controls.camera.setViewport({ x: 60, y: 90, zoom: 1 });
        controls.camera.flush();
        const frame = controls.document.getFrames().find((item) => item.x === 0 && item.y === 0)!;
        controls.select(frame.id);
        controls.document.beginGesture(frame.id);
        await settle();
        setStatus(`${count.toLocaleString()} frames · drag`);
        phases.push(
          await measurePhase(
            controls,
            "drag-100%",
            (i) => {
              for (let sample = 0; sample < 4; sample++)
                controls.preview({ ...frame, x: frame.x + i + sample, y: frame.y + i / 2 });
            },
            () => stoppedRef.current,
          ),
        );
        controls.flushPreview();
        controls.document.endGesture();
        controls.document.undo();
        controls.select(null);
        controls.camera.setViewport({ x: 60, y: 90, zoom: 0.1 });
        controls.camera.flush();
        await settle();
        setStatus(`${count.toLocaleString()} frames · overview at 10%`);
        phases.push(
          await measurePhase(
            controls,
            "pan-10%-full-detail",
            (i) => {
              controls.camera.setViewport({ x: 60 - i * 2, y: 90 - i, zoom: 0.1 });
            },
            () => stoppedRef.current,
          ),
        );
        const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } })
          .memory;
        const result = {
          totalFrames: count,
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
            devicePixelRatio: window.devicePixelRatio,
            methodology:
              "Actual HTML/CSS renderer, text/local SVG images/nested layouts, persistent storage disabled. Scene-ready time includes fixture creation, initial fit-to-view render, camera reset, and six settling frames. 20 warmup + 100 sampled animation-frame intervals per phase; four coalesced input samples/tick in pan and drag. Counts are frames (~30 HTML elements each), mounted/DOM counts at phase end. Frame intervals include rendering workload and display scheduling, not end-to-end hardware input latency. Chromium heap reading is optional/coarse and not total process or peak memory. No baseline browser speedup claim.",
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
      <DesignCanvas
        key={scene.key}
        initialFrames={scene.frames}
        persist={false}
        FrameContent={BenchmarkFrameContent}
        onReady={onReady}
      />
      <section
        aria-label="Canvas performance benchmark"
        className="fixed top-4 right-4 z-50 max-h-[90vh] w-[min(540px,calc(100vw-32px))] overflow-auto rounded-xl border bg-popover p-4 text-xs shadow-lg"
      >
        <h1 className="mb-2 text-sm font-semibold">Canvas performance benchmark</h1>
        <p className="mb-3 text-muted-foreground">
          Isolated sample documents: 1,000 / 5,000 / 10,000 frames with text, images, and nested
          HTML. Your saved canvas is untouched.
        </p>
        <div className="mb-3 flex gap-2">
          <Button size="sm" disabled={running} onClick={run}>
            Run benchmarks
          </Button>
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
          {report && (
            <Button size="sm" variant="secondary" onClick={download}>
              Download results
            </Button>
          )}
        </div>
        <output className="mb-3 block">{status}</output>
        {results.map((result) => (
          <div key={result.totalFrames} className="mt-3 border-t pt-3">
            <h2 className="mb-2 font-semibold">
              {result.totalFrames.toLocaleString()} frames · ready {result.sceneReadyMs} ms
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
                {result.phases.map((phase) => (
                  <tr key={phase.phase}>
                    <td className="py-1">{phase.phase}</td>
                    <td>{phase.meanFrameMs} ms</td>
                    <td>{phase.p95FrameMs} ms</td>
                    <td>{phase.mountedFrames}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <p className="mt-3 text-muted-foreground">
          Keep this window visible. Results depend on hardware, display refresh, and browser. The
          10% overview keeps all visible content at full detail.
        </p>
      </section>
    </>
  );
}
