import type { CanvasFrame } from "@/lib/canvas-document";

/** A repeatable scene, including frames above and to the left of the origin. */
export function createBenchmarkFrames(count: number): CanvasFrame[] {
  const length = Math.max(0, Math.floor(count));
  const columns = Math.ceil(Math.sqrt(length));
  return Array.from({ length }, (_, index) => ({
    id: `bench-${index}`,
    name: `Frame ${index + 1}`,
    x: ((index % columns) - 2) * 480,
    y: (Math.floor(index / columns) - 1) * 360,
    width: 400,
    height: 280,
  }));
}
