import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Benchmark =
  import.meta.env.DEV || import.meta.env.MODE === "benchmark"
    ? lazy(() => import("@/components/canvas/canvas-benchmark"))
    : null;

export const Route = createFileRoute("/benchmark")({
  component: () =>
    Benchmark ? (
      <Suspense fallback={null}>
        <Benchmark />
      </Suspense>
    ) : (
      <p className="p-6">Benchmark is available in development or benchmark builds.</p>
    ),
});
