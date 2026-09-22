/* oxlint-disable unicorn/consistent-function-scoping -- Browser callbacks must contain every helper they serialize. */
/* eslint-disable no-await-in-loop -- Frame samples depend on the preceding camera update. */
import { expect, test } from "@playwright/test";

const hardware = process.env.FLIES_GPU_HARDWARE === "1";
const targetFps = Number(process.env.FLIES_GPU_TARGET_FPS ?? "60");

for (const count of [1000, 5000]) {
  test(`native WebGL2 retains mixed artwork while animating ${count} nodes`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/recents");

    const report = await page.evaluate(async (nodeCount) => {
      const library = "/packages/canvas/src/index.ts";

      const { CanvasWebglRenderer, CanvasDocument, CanvasCamera, createMixedBenchmarkNodes } =
        await import(/* @vite-ignore */ library);

      const canvas = document.createElement("canvas");
      Object.assign(canvas.style, { position: "fixed", inset: "0", zIndex: "99999" });
      document.body.append(canvas);
      const documentModel = new CanvasDocument(createMixedBenchmarkNodes(nodeCount));
      const camera = new CanvasCamera();
      camera.setSize({ x: 1280, y: 720 });
      camera.setViewport({ x: 48, y: 48, zoom: 1 });
      camera.flush();
      const rendererErrors: string[] = [];

      const renderer = await CanvasWebglRenderer.create({
        canvas,
        document: documentModel,
        camera,
        onError: (error: unknown) => rendererErrors.push(String(error)),
      });

      const gl = canvas.getContext("webgl2")!;
      const rendererInfo = gl.getExtension("WEBGL_debug_renderer_info");

      const contextInfo = {
        version: gl.getParameter(gl.VERSION),
        renderer: gl.getParameter(gl.RENDERER),
        unmaskedRenderer: rendererInfo
          ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
          : null,
        density: window.devicePixelRatio,
      };

      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
      const sorted = (values: number[]) => values.toSorted((a, b) => a - b);

      const summarize = (values: number[]) => ({
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        p95: sorted(values)[Math.ceil(values.length * 0.95) - 1],
        max: Math.max(...values),
      });

      try {
        // Warm the complete sampled path before measuring texture reuse.
        for (let index = 0; index < 40; index++) {
          camera.setViewport({ x: 48 + Math.sin(index / 6) * 8, y: 48, zoom: 1 });
          camera.flush();
          await frame();
        }

        for (let index = 0; index < 120 && renderer.getStats().pendingResources; index++)
          await frame();
        const before = renderer.getStats();
        const frameIntervals: number[] = [];
        const cpuRenderMs: number[] = [];
        const blankFrames: number[] = [];
        let previous = await frame();

        for (let index = 0; index < 120; index++) {
          // Four input samples/tick mimic a high-rate pointer device.
          for (let sample = 0; sample < 4; sample++)
            camera.setViewport({
              x: 48 + Math.sin((index + sample / 4) / 6) * 8,
              y: 48,
              zoom: 1,
            });
          const now = await frame();

          if (index >= 20) {
            const stats = renderer.getStats();
            frameIntervals.push(now - previous);
            cpuRenderMs.push(stats.renderMs);
            if (!stats.drawCalls) blankFrames.push(index);
          }

          previous = now;
        }

        const after = renderer.getStats();
        // The renderer must sleep when the camera/document stop changing.
        for (let index = 0; index < 5; index++) await frame();
        const settled = renderer.getStats();
        for (let index = 0; index < 12; index++) await frame();
        const idle = renderer.getStats();

        return {
          nodeCount,
          contextInfo,
          frameIntervals: summarize(frameIntervals),
          cpuRenderMs: summarize(cpuRenderMs),
          sampledFrames: frameIntervals.length,
          blankFrames,
          before,
          after,
          idleRenders: idle.renderCount - settled.renderCount,
          errors: rendererErrors,
        };
      } finally {
        renderer.destroy();
        canvas.remove();
      }
    }, count);

    await testInfo.attach(`webgl2-${count}-performance.json`, {
      body: JSON.stringify(
        {
          scope: hardware
            ? "Native WebGL2 in Chromium on this machine; measured refresh cadence and CPU render time."
            : "SwiftShader functional regression run; these timings do not prove hardware FPS.",
          hardware,
          targetFps,
          ...report,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(report.contextInfo.version).toContain("WebGL 2.0");
    expect(report.sampledFrames).toBe(100);
    expect(report.before.pendingResources).toBe(0);
    expect(report.after.textureUploads).toBe(report.before.textureUploads);
    expect(report.after.renderCount).toBeGreaterThan(report.before.renderCount + 90);
    expect(report.blankFrames).toEqual([]);
    expect(report.idleRenders).toBe(0);
    expect(report.errors).toEqual([]);
    expect(errors).toEqual([]);

    if (hardware) {
      expect([60, 120], "Choose an actual 60 Hz or 120 Hz target").toContain(targetFps);
      expect(
        report.contextInfo.unmaskedRenderer,
        "Hardware timing must identify its GPU",
      ).toBeTruthy();
      expect(report.contextInfo.unmaskedRenderer).not.toMatch(/SwiftShader|llvmpipe|software/i);
      const budgetMs = 1000 / targetFps;
      expect(report.cpuRenderMs.p95).toBeLessThan(budgetMs);
      expect(report.frameIntervals.p95).toBeLessThan(budgetMs + 2);
    }
  });
}

test.describe("dense hardware and document interaction", () => {
  test.skip(!hardware, "Dense frame cadence needs a physical GPU; SwiftShader is covered above.");

  for (const count of [1000, 5000]) {
    test(`${count} mixed nodes at normal and fit-all zoom retain ${targetFps} Hz interaction`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(300_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto("/recents");

      const report = await page.evaluate(async (nodeCount) => {
        const library = "/packages/canvas/src/index.ts";

        const {
          CanvasWebglRenderer,
          CanvasDocument,
          CanvasCamera,
          createMixedBenchmarkNodes,
          moveSelection,
          resizeSelection,
        } = await import(/* @vite-ignore */ library);

        const canvas = document.createElement("canvas");
        Object.assign(canvas.style, { position: "fixed", inset: "0", zIndex: "99999" });
        document.body.append(canvas);
        const fixture = createMixedBenchmarkNodes(nodeCount);
        const doc = new CanvasDocument(fixture);
        const camera = new CanvasCamera();
        camera.setSize({ x: 1280, y: 720 });
        camera.setViewport({ x: 48, y: 48, zoom: 1 });
        camera.flush();
        const rendererErrors: string[] = [];

        const renderer = await CanvasWebglRenderer.create({
          canvas,
          document: doc,
          camera,
          onError: (error: unknown) => rendererErrors.push(String(error)),
          profiling: true,
        });

        const gl = canvas.getContext("webgl2")!;
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        const unmaskedRenderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
        const roots = fixture.filter((node) => !node.parentId);
        const width = Math.max(...roots.map((node) => node.x + node.width));
        const height = Math.max(...roots.map((node) => node.y + node.height));
        const fitZoom = Math.min((1280 - 96) / width, (720 - 96) / height);
        const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

        const stats = () => {
          const { rasters: _rasters, ...counters } = renderer.getStats({ rasters: false });

          return { ...counters, cachedRasters: counters.rasterCount };
        };

        const summarize = (values: number[]) => {
          const ordered = values.toSorted((a, b) => a - b);

          return {
            mean: values.reduce((sum, value) => sum + value, 0) / values.length,
            p95: ordered[Math.ceil(values.length * 0.95) - 1],
            max: Math.max(...values),
          };
        };

        const phases = [];

        try {
          for (const view of ["normal", "fit-all"] as const) {
            const zoom = view === "normal" ? 1 : fitZoom;
            camera.setViewport({ x: 48, y: 48, zoom });
            camera.flush();
            const readyStarted = performance.now();
            await renderer.whenReady();
            const sceneReadyMs = performance.now() - readyStarted;
            await frame();

            for (const action of ["pan", "subtree-drag", "layout-resize", "text-edit"] as const) {
              const root = doc.getFrame("mixed-0-frame")!;
              const layout = doc.getFrame("mixed-0-layout")!;
              const title = doc.getFrame("mixed-0-title")!;

              const subtree = doc
                .getDescendantIds([root.id])
                .map((id: string) => doc.getFrame(id)!);

              const layoutTree = doc
                .getDescendantIds([layout.id])
                .map((id: string) => doc.getFrame(id)!);

              if (action !== "pan")
                doc.beginGesture(
                  action === "text-edit" ? title.id : subtree.map((node) => node.id),
                );

              const apply = (index: number) => {
                if (action === "pan") {
                  for (let sample = 0; sample < 4; sample++)
                    camera.setViewport({
                      x: 48 + Math.sin((index + sample / 4) / 9) * 8,
                      y: 48,
                      zoom,
                    });
                } else if (action === "subtree-drag") {
                  for (let sample = 0; sample < 4; sample++)
                    doc.previewMany(
                      moveSelection(subtree, [root.id], {
                        x: Math.sin((index + sample / 4) / 9) * 24,
                        y: Math.cos((index + sample / 4) / 9) * 12,
                      }),
                    );
                } else if (action === "layout-resize") {
                  doc.previewMany(
                    resizeSelection(layoutTree, [layout.id], layout, {
                      ...layout,
                      width: layout.width + Math.sin(index / 9) * 40,
                    }),
                  );
                } else {
                  // Exercise the shared live document/raster path used by remote
                  // text edits and committed input, including glyph replacement.
                  doc.preview({ ...title, text: `Project ${index % 150}: typing` });
                }
              };

              let peakTextureBytes = stats().textureBytes;

              for (let index = 0; index < 150; index++) {
                apply(index);
                await frame();
                peakTextureBytes = Math.max(peakTextureBytes, stats().textureBytes);
              }

              const before = stats();
              const intervals: number[] = [];
              const renderMs: number[] = [];
              const drawCalls: number[] = [];
              const primitives: number[] = [];
              const gpuMs: number[] = [];
              let gpuSamples = before.gpuSamples;
              let previous = await frame();

              for (let index = 0; index < 150; index++) {
                apply(index);
                const now = await frame();
                const sample = stats();
                peakTextureBytes = Math.max(peakTextureBytes, sample.textureBytes);
                intervals.push(now - previous);
                renderMs.push(sample.renderMs);
                drawCalls.push(sample.drawCalls);
                primitives.push(sample.primitiveCount);

                if (sample.gpuSamples > gpuSamples && sample.gpuMs !== null) {
                  gpuMs.push(sample.gpuMs);
                  gpuSamples = sample.gpuSamples;
                }

                previous = now;
              }

              const after = stats();
              if (action !== "pan") doc.endGesture(true);
              camera.setViewport({ x: 48, y: 48, zoom });
              camera.flush();
              await renderer.whenReady();
              await frame();
              phases.push({
                view,
                action,
                zoom,
                sceneReadyMs,
                warmupFrames: 150,
                sampleFrames: 150,
                frameIntervals: summarize(intervals),
                cpuRenderMs: summarize(renderMs),
                minimumDrawCalls: Math.min(...drawCalls),
                minimumPrimitiveCount: Math.min(...primitives),
                gpuRenderMs: gpuMs.length ? summarize(gpuMs) : null,
                gpuSampleCount: gpuMs.length,
                peakTextureBytes,
                before,
                after,
              });
            }
          }

          return {
            nodeCount,
            unmaskedRenderer,
            viewport: { width: 1280, height: 720, density: window.devicePixelRatio },
            phases,
            errors: rendererErrors,
          };
        } finally {
          renderer.destroy();
          canvas.remove();
        }
      }, count);

      await testInfo.attach(`webgl2-${count}-dense-interaction.json`, {
        body: JSON.stringify(
          {
            ...report,
            targetFps,
            headed: process.env.FLIES_GPU_HEADED === "1",
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
      expect(report.unmaskedRenderer).toBeTruthy();
      expect(report.unmaskedRenderer).not.toMatch(/SwiftShader|llvmpipe|software/i);
      expect(report.phases).toHaveLength(8);
      expect(report.errors).toEqual([]);
      expect(errors).toEqual([]);

      for (const phase of report.phases) {
        const label = `${count} ${phase.view} ${phase.action}`;
        expect.soft(phase.sampleFrames, label).toBe(150);
        expect
          .soft(phase.after.renderCount - phase.before.renderCount, `${label}: rendered samples`)
          .toBeGreaterThanOrEqual(phase.sampleFrames);
        expect.soft(phase.minimumDrawCalls, `${label}: no blank frames`).toBeGreaterThan(0);
        expect
          .soft(phase.cpuRenderMs.p95, `${label}: CPU frame budget`)
          .toBeLessThan(1000 / targetFps);
        expect
          .soft(phase.frameIntervals.p95, `${label}: displayed frame budget`)
          .toBeLessThan(1000 / targetFps + 2);
        if (phase.action === "pan" || phase.action === "subtree-drag")
          expect
            .soft(phase.after.textureUploads, `${label}: no camera/position raster uploads`)
            .toBe(phase.before.textureUploads);
        if (phase.view === "fit-all")
          expect
            .soft(phase.minimumPrimitiveCount, `${label}: actual dense scene`)
            .toBeGreaterThan(count / 2);
      }
    });
  }
});

/* eslint-enable no-await-in-loop */

test("hardware clipped batches stream without synchronizing every draw", async ({
  page,
}, testInfo) => {
  test.skip(!hardware, "Native driver buffer streaming requires a physical GPU.");
  test.setTimeout(90_000);
  await page.goto("/recents");

  const report = await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasWebglRenderer, CanvasDocument, CanvasCamera, createMixedBenchmarkNodes } =
      await import(/* @vite-ignore */ path);

    const nodes = createMixedBenchmarkNodes(5000).map(
      (frame: { parentId?: string; width: number; height: number }) =>
        frame.parentId
          ? frame
          : Object.assign(frame, { cornerRadius: Math.min(frame.width, frame.height) / 2 }),
    );

    const roots = nodes.filter((frame: { parentId?: string }) => !frame.parentId);

    const width = Math.max(
      ...roots.map((frame: { x: number; width: number }) => frame.x + frame.width),
    );

    const height = Math.max(
      ...roots.map((frame: { y: number; height: number }) => frame.y + frame.height),
    );

    const zoom = Math.min(1184 / width, 624 / height);
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const doc = new CanvasDocument(nodes);
    const camera = new CanvasCamera();
    camera.setSize({ x: 1280, y: 720 });
    camera.setViewport({ x: 48, y: 48, zoom });
    camera.flush();
    const errors: string[] = [];

    const renderer = await CanvasWebglRenderer.create({
      canvas,
      document: doc,
      camera,
      profiling: true,
      onError: (error: unknown) => errors.push(String(error)),
    });

    try {
      const gl = canvas.getContext("webgl2")!;
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      const backend = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
      const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

      const cpu: number[] = [],
        intervals: number[] = [],
        gpu: number[] = [],
        clips: number[] = [],
        primitives: number[] = [];

      let previous = await frame(),
        gpuSamples = 0;

      for (let i = 0; i < 300; i++) {
        camera.setViewport({ x: 48 + Math.sin(i / 9) * 8, y: 48, zoom });
        // oxlint-disable-next-line no-await-in-loop
        const now = await frame();
        const stats = renderer.getStats({ rasters: false });

        if (i >= 150) {
          cpu.push(stats.renderMs);
          intervals.push(now - previous);
          clips.push(stats.clipCount);
          primitives.push(stats.primitiveCount);

          if (stats.gpuSamples > gpuSamples && stats.gpuMs !== null) {
            gpu.push(stats.gpuMs);
            gpuSamples = stats.gpuSamples;
          }
        }

        previous = now;
      }

      const p95 = (values: number[]) =>
        values.length
          ? values.toSorted((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
          : null;

      return {
        backend,
        errors,
        warmupFrames: 150,
        sampleFrames: cpu.length,
        cpuP95: p95(cpu)!,
        frameP95: p95(intervals)!,
        gpuP95: p95(gpu),
        minimumClips: Math.min(...clips),
        minimumPrimitives: Math.min(...primitives),
        stats: renderer.getStats({ rasters: false }),
      };
    } finally {
      renderer.destroy();
      canvas.remove();
    }
  });

  await testInfo.attach("webgl2-clipped-streaming.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
  expect(report.backend).toBeTruthy();
  expect(report.backend).not.toMatch(/SwiftShader|llvmpipe|software/i);
  expect(report.errors).toEqual([]);
  expect(report.sampleFrames).toBe(150);
  expect(report.minimumClips).toBeGreaterThanOrEqual(1000);
  expect(report.minimumPrimitives).toBeGreaterThan(2500);
  expect(report.cpuP95).toBeLessThan(1000 / targetFps);
  expect(report.frameP95).toBeLessThan(1000 / targetFps + 2);
});
