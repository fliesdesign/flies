import { performance } from "node:perf_hooks";
import process from "node:process";

import {
  CanvasDocument,
  CanvasSpatialIndex,
  createBenchmarkFrames,
  viewportBounds,
  type CanvasFrame,
} from "@flies/canvas";

const COUNTS = [1_000, 5_000, 10_000];
const POINTER_UPDATES = 1_000;
const HISTORY_UPDATES = 100;
const QUERY_SAMPLES = 200;
const SCREEN = { x: 1440, y: 900 };

function round(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function summarize(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    totalMs: round(sorted.reduce((sum, sample) => sum + sample, 0)),
  };
}

function measure(operation: (iteration: number) => void, count: number) {
  const samples: number[] = [];
  for (let iteration = 0; iteration < count; iteration++) {
    const start = performance.now();
    operation(iteration);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function measureQuery(index: CanvasSpatialIndex, zoom: number) {
  // Sample a short camera sweep. The number of mounted candidates varies with
  // position; all samples include the same 200-screen-pixel overscan as the UI.
  let minCandidates = Infinity;
  let maxCandidates = 0;
  const timings = measure((iteration) => {
    const visible = index.query(
      viewportBounds({ x: -(iteration % 100) * 8, y: -((iteration * 3) % 100), zoom }, SCREEN),
    );
    minCandidates = Math.min(minCandidates, visible.length);
    maxCandidates = Math.max(maxCandidates, visible.length);
  }, QUERY_SAMPLES);
  return { zoom, minCandidates, maxCandidates, ...timings };
}

function previousArrayAlgorithms(initial: CanvasFrame[], target: CanvasFrame) {
  // Reproduce the old data operations, without React or storage. These timings
  // compare algorithms only and must never be interpreted as browser frame time.
  let frames = initial;
  const preview = measure((iteration) => {
    const next = { ...target, x: target.x + (iteration % 97) + 1 };
    frames = frames.map((frame) => (frame.id === target.id ? next : frame));
  }, POINTER_UPDATES);

  const history: CanvasFrame[][] = [];
  const commit = measure((iteration) => {
    const before = frames;
    const next = { ...target, x: target.x + iteration + 1 };
    frames = frames.map((frame) => (frame.id === target.id ? next : frame));
    // oxlint-disable-next-line oxc/no-map-spread -- Reproduce the former snapshot algorithm.
    history.push(before.map((frame) => ({ ...frame })));
  }, HISTORY_UPDATES);

  return {
    previewArrayMap: preview,
    commitArrayMapAndFullSnapshot: commit,
    retainedHistoryFrameObjects: history.reduce((total, entry) => total + entry.length, 0),
    finalFrameCount: frames.length,
  };
}

function benchmark(count: number) {
  const frames = createBenchmarkFrames(count);
  const construction = measure(() => {
    const document = new CanvasDocument(frames);
    const index = new CanvasSpatialIndex(document.getFrames());
    // Consume the constructed data to avoid measuring an unused allocation.
    if (index.query(frames[0]).length === 0) throw new Error("Missing initial frame");
  }, 7);

  const document = new CanvasDocument(frames);
  const index = new CanvasSpatialIndex(frames);
  const target = frames[Math.floor(count / 2)];
  const notifications = { document: 0, editedFrame: 0, unrelatedFrame: 0, committedChanges: 0 };
  document.subscribe(() => notifications.document++);
  document.subscribeFrame(target.id, () => notifications.editedFrame++);
  document.subscribeFrame(frames[0].id, () => notifications.unrelatedFrame++);
  document.subscribeChanges((ids) => {
    notifications.committedChanges++;
    for (const id of ids) {
      const frame = document.getFrame(id);
      if (frame) index.upsert(frame);
      else index.remove(id);
    }
  });

  const queries = [measureQuery(index, 1), measureQuery(index, 0.1)];
  document.beginGesture(target.id);
  const preview = measure((iteration) => {
    document.preview({ ...target, x: target.x + (iteration % 97) + 1 });
  }, POINTER_UPDATES);
  const previewNotifications = { ...notifications };
  document.endGesture();

  const commit = measure(() => {
    const current = document.getFrame(target.id)!;
    document.update({ ...current, x: current.x + 1 });
  }, HISTORY_UPDATES);
  const undo = measure(() => document.undo(), HISTORY_UPDATES);
  const redo = measure(() => document.redo(), HISTORY_UPDATES);

  return {
    count,
    constructDocumentAndSpatialIndex: construction,
    queries,
    targetedPreview: preview,
    previewNotifications,
    committedUpdateIncludingIndex: commit,
    undoIncludingIndex: undo,
    redoIncludingIndex: redo,
    history: document.getHistoryStats(),
    previousAlgorithms: previousArrayAlgorithms(frames, target),
  };
}

// Warm the code paths once; reported scenes always start from fresh fixtures.
benchmark(100);
const scenes = COUNTS.map(benchmark);
process.stdout.write(
  `${JSON.stringify(
    {
      scope:
        "Pure JavaScript document/index algorithms; excludes browser layout, paint, React, and localStorage",
      runtime: process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.version}`,
      platform: `${process.platform}/${process.arch}`,
      screen: SCREEN,
      pointerUpdates: POINTER_UPDATES,
      historyUpdates: HISTORY_UPDATES,
      scenes,
    },
    null,
    2,
  )}\n`,
);
