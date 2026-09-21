import { writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test.use({ deviceScaleFactor: 2 });

test("MCP imports centered button labels and normal-line-height headings without WebGPU clipping", async ({
  page,
}, testInfo) => {
  await page.goto("/");

  const samples = await page.evaluate(async () => {
    const harnessPath = "/scripts/gpu-tests/gpu-harness.tsx";
    const editorPath = "/src/lib/mcp/editor.ts";
    const { mountGpuFixture } = await import(/* @vite-ignore */ harnessPath);
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const fixture = await mountGpuFixture();
    fixture.controls.document.replaceAll([]);

    const buttonStyle =
      "box-sizing:border-box;width:240px;height:64px;border:0;padding:0;margin:0;background:#eeeeee;color:#000000;font-family:Arial;font-size:16px;font-weight:400;line-height:normal";

    const html = `<main style="box-sizing:border-box;width:900px;height:400px;padding:32px;background:#ffffff;color:#000000;font-family:Arial;line-height:normal">
      <h1 data-name="Normal heading" style="margin:0;font-family:Arial;font-size:48px;font-weight:400;line-height:normal">Then keep going by hand.</h1>
      <div style="display:flex;gap:32px;margin-top:32px">
        <button data-name="Flex button" style="${buttonStyle};display:flex;align-items:center;justify-content:center">Open in browser</button>
        <button data-name="Grid button" style="${buttonStyle};display:grid;place-items:center">Keep going</button>
      </div>
    </main>`;

    const result = await editorTool(fixture.controls, "write_html", {
      html,
      x: 40,
      y: 60,
      width: 900,
      height: 400,
    });

    const imported = JSON.parse((result.content[0] as { text: string }).text);
    if (imported.warnings.length) throw new Error(JSON.stringify(imported.warnings));
    Reflect.set(
      window,
      "importedTextNodes",
      fixture.controls.document.getFrames().filter((node) => node.kind === "text"),
    );

    const reference = document.createElement("iframe");
    reference.dataset.textImportReference = "";
    Object.assign(reference.style, {
      position: "fixed",
      inset: "0",
      width: "1280px",
      height: "720px",
      border: "0",
      zIndex: "10000",
      visibility: "hidden",
      background: "#ffffff",
    });

    const loaded = new Promise<void>((resolve) =>
      reference.addEventListener("load", () => resolve(), { once: true }),
    );

    reference.srcdoc = `<!doctype html><html><head><style>html,body{margin:0;background:#fff}</style></head><body><div style="position:absolute;left:40px;top:60px">${html}</div></body></html>`;
    document.body.append(reference);
    await loaded;
    await reference.contentDocument!.fonts.ready;

    return ["Normal heading", "Flex button", "Grid button"].map((name) => {
      const box = reference
        .contentDocument!.querySelector(`[data-name="${name}"]`)!
        .getBoundingClientRect();

      return {
        name,
        x: Math.floor(box.x),
        y: Math.floor(box.y),
        width: Math.ceil(box.right) - Math.floor(box.x),
        height: Math.ceil(box.bottom) - Math.floor(box.y),
      };
    });
  });

  const artwork = page.locator("[data-gpu-fixture] .canvas-gpu-surface[data-renderer=webgpu]");
  await expect(artwork, "Imported text must use WebGPU, never the DOM fallback").toBeVisible();
  await expect(page.locator("[data-gpu-fixture] .canvas-frame-position")).toHaveCount(0);
  const density = await page.evaluate(() => window.devicePixelRatio);
  const gpu = await page.locator("[data-gpu-fixture]").screenshot();
  await page.locator("[data-text-import-reference]").evaluate((node) => {
    (node as HTMLElement).style.visibility = "visible";
  });
  const dom = await page.locator("[data-text-import-reference]").screenshot();
  await testInfo.attach("mcp-text-webgpu.png", { body: gpu, contentType: "image/png" });
  await testInfo.attach("mcp-text-browser-reference.png", { body: dom, contentType: "image/png" });
  await writeFile("/tmp/flies-text-import-gpu.png", gpu);
  await writeFile("/tmp/flies-text-import-dom.png", dom);

  const bounds = await page.evaluate(
    async ({ images, regions, pixelRatio }) => {
      return Promise.all(
        images.map(async (png) => {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);

          return regions.map((region) => {
            const width = region.width * pixelRatio;
            const height = region.height * pixelRatio;

            const pixels = context.getImageData(
              region.x * pixelRatio,
              region.y * pixelRatio,
              width,
              height,
            ).data;

            let left = width,
              right = -1,
              top = height,
              bottom = -1,
              ink = 0,
              coverage = 0;

            const thresholds = [64, 128, 170, 224];
            const histogram = thresholds.map(() => 0);
            const background = region.name === "Normal heading" ? 255 : 238;

            for (let y = 0; y < height; y++) {
              for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                const luminance = Math.max(pixels[index], pixels[index + 1], pixels[index + 2]);
                coverage += Math.max(0, (background - luminance) / background);
                thresholds.forEach((threshold, level) => {
                  if (luminance < threshold) histogram[level]++;
                });
                if (luminance >= 170) continue;
                left = Math.min(left, x);
                right = Math.max(right, x);
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
                ink++;
              }
            }

            return {
              left: left / pixelRatio,
              right: right / pixelRatio,
              top: top / pixelRatio,
              bottom: bottom / pixelRatio,
              ink,
              coverage,
              histogram,
            };
          });
        }),
      );
    },
    {
      images: [gpu.toString("base64"), dom.toString("base64")],
      regions: samples,
      pixelRatio: density,
    },
  );

  const diagnostics = JSON.stringify(
    { samples, bounds, nodes: await page.evaluate(() => Reflect.get(window, "importedTextNodes")) },
    null,
    2,
  );

  await testInfo.attach("mcp-text-glyph-diagnostics.json", {
    body: diagnostics,
    contentType: "application/json",
  });
  await writeFile("/tmp/flies-text-import-diagnostics.json", diagnostics);

  for (let index = 0; index < samples.length; index++) {
    const actual = bounds[0][index];
    const expected = bounds[1][index];
    expect(actual.ink, `${samples[index].name} has visible glyphs`).toBeGreaterThan(100);

    for (const edge of ["left", "right", "top", "bottom"] as const) {
      expect(
        Math.abs(actual[edge] - expected[edge]),
        `${samples[index].name}: ${edge}`,
      ).toBeLessThanOrEqual(2);
    }

    // Fractional glyph placement changes how many antialiased pixels cross a
    // binary threshold. Integrated darkness retains the same glyph coverage.
    const coverageRatio = actual.coverage / expected.coverage;
    expect(coverageRatio, `${samples[index].name} retains all glyph coverage`).toBeGreaterThan(
      0.98,
    );
    expect(coverageRatio, `${samples[index].name} preserves font weight`).toBeLessThan(1.02);
  }
});
