/* eslint-disable no-await-in-loop -- Browser phases and metric snapshots must remain ordered. */
import { expect, test } from "@playwright/test";

test("three populated artboards preserve mounted content while navigating", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const session = await page.context().newCDPSession(page);
  let compositorLayers = 0;
  let drawingLayers = 0;
  session.on("LayerTree.layerTreeDidChange", ({ layers = [] }) => {
    compositorLayers = layers.length;
    drawingLayers = layers.filter((layer) => layer.drawsContent).length;
  });
  await session.send("LayerTree.enable");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/performance-harness.tsx";
    const { mountPerformance } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "canvasPerformance", await mountPerformance());
  });
  await session.send("Performance.enable");
  const report = [];

  for (const phase of ["pan", "zoom", "culling", "drag"] as const) {
    if (phase === "drag") {
      await page.evaluate(async () => {
        Reflect.get(window, "canvasPerformance").dispose();
        const path = "/scripts/mcp-tests/performance-harness.tsx";
        const { mountPerformance } = await import(/* @vite-ignore */ path);
        Reflect.set(window, "canvasPerformance", await mountPerformance({ probe: false }));
      });
    }

    const before = await session.send("Performance.getMetrics");

    const result = await page.evaluate(
      (name) => Reflect.get(window, "canvasPerformance").measure(name),
      phase,
    );

    const after = await session.send("Performance.getMetrics");
    const metrics: Record<string, number> = {};

    for (const name of [
      "LayoutCount",
      "RecalcStyleCount",
      "LayoutDuration",
      "RecalcStyleDuration",
      "ScriptDuration",
      "TaskDuration",
    ]) {
      const initial = before.metrics.find((metric) => metric.name === name)?.value ?? 0;
      const final = after.metrics.find((metric) => metric.name === name)?.value ?? 0;
      metrics[name] = Math.round((final - initial) * 1000000) / 1000000;
    }

    report.push({ ...result, compositorLayers, drawingLayers, metrics });
    expect(result.totalNodes).toBe(723);
    expect(result.remountedNodes).toBe(0);
    expect(result.frameLabelHeight).toBeCloseTo(16, 1);

    if (phase === "culling") {
      expect(result.frameContentRenders).toBeLessThan(100);
      expect(result.stableFrameRenders).toBe(0);
    }

    if (phase === "drag") {
      expect(result.contentProbe).toBe(false);
      expect(result.sampleMovement.x).toBeCloseTo(15.01, 1);
      expect(result.sampleMovement.y).toBeCloseTo(7.5, 1);
    }

    if (phase === "pan" || phase === "zoom") {
      expect(result.frameStyleChanges).toBe(0);
      expect(result.frameContentRenders).toBe(0);
    }
  }

  await testInfo.attach("three-artboard-performance.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  console.log(
    JSON.stringify(
      {
        scope:
          "Headless Chromium development renderer; timings are observations, not native latency or FPS guarantees",
        phases: report,
      },
      null,
      2,
    ),
  );
  await page.evaluate(() => Reflect.get(window, "canvasPerformance").dispose());
});
