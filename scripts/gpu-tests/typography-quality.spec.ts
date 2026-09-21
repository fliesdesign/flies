import { writeFile } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/packages/canvas/src/index.ts";

    const { CanvasDocument, CanvasCamera, CanvasGpuRenderer } = await import(
      /* @vite-ignore */ path
    );

    const host = document.createElement("div");
    host.dataset.textQuality = "";
    Object.assign(host.style, {
      position: "fixed",
      inset: "0",
      zIndex: "9999",
      background: "#ffffff",
    });
    const canvas = document.createElement("canvas");
    host.append(canvas);
    document.body.append(host);

    const doc = new CanvasDocument([
      {
        id: "label",
        name: "Button label",
        kind: "text",
        x: 50,
        y: 50,
        width: 280,
        height: 40,
        text: "Open in browser",
        fontSize: 16,
        fontFamily: "Arial",
        fontWeight: 400,
        color: "#000000",
      },
      {
        id: "serif",
        name: "Serif label",
        kind: "text",
        x: 50,
        y: 100,
        width: 280,
        height: 40,
        text: "Sharp type, 0123",
        fontSize: 18,
        fontFamily: "Georgia",
        fontStyle: "italic",
        color: "#000000",
      },
      {
        id: "offscreen",
        name: "Distant label",
        kind: "text",
        x: 5000,
        y: 50,
        width: 280,
        height: 40,
        text: "Distant type",
        fontSize: 16,
        color: "#000000",
      },
      {
        id: "large",
        name: "Large type",
        kind: "text",
        x: 5000,
        y: 100,
        width: 12000,
        height: 1000,
        text: "A very large text texture that remains bounded",
        fontSize: 700,
        color: "#000000",
      },
    ]);

    const camera = new CanvasCamera();
    camera.setSize({ x: 1280, y: 720 });
    camera.setViewport({ x: 0, y: 0, zoom: 1 });
    camera.flush();
    const errors: string[] = [];

    const renderer = await CanvasGpuRenderer.create({
      canvas,
      document: doc,
      camera,
      onError: (error: unknown) => errors.push(String(error)),
    });

    Reflect.set(window, "textQuality", { renderer, camera, document: doc, errors });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function rasterState(page: Page) {
  return page.evaluate(() => {
    const { renderer, errors } = Reflect.get(window, "textQuality");
    const gpu = Reflect.get(renderer, "renderer");

    return {
      errors,
      texts: [...Reflect.get(renderer, "nodes").entries()].map(([id, node]) => {
        const text = node.text;
        const texture = text ? Reflect.get(text, "_gpuData")[gpu.uid]?.texture : undefined;

        return {
          id,
          resolution: text?.resolution,
          texture: texture?.uid,
          width: texture?.source.pixelWidth,
          height: texture?.source.pixelHeight,
        };
      }),
    };
  });
}

async function softness(page: Page, png: Buffer, density: number) {
  return page.evaluate(
    async ({ data, dpr }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);

      return [100, 300].map((y) => {
        const pixels = context.getImageData(98 * dpr, y * dpr, 610 * dpr, 105 * dpr).data;

        let ink = 0,
          soft = 0;

        for (let index = 0; index < pixels.length; index += 4) {
          if (pixels[index] < 240) ink++;
          if (pixels[index] >= 48 && pixels[index] < 224) soft++;
        }

        return { ink, fraction: soft / ink };
      });
    },
    { data: png.toString("base64"), dpr: density },
  );
}

for (const density of [1, 2]) {
  test.describe(`text density ${density}`, () => {
    test.use({ deviceScaleFactor: density });
    test("high-zoom glyphs stay crisp and camera movement reuses their texture", async ({
      page,
    }, testInfo) => {
      await mount(page);
      await page.evaluate(() => {
        const { camera } = Reflect.get(window, "textQuality");
        camera.setViewport({ x: -100, y: -100, zoom: 4 });
        camera.flush();
      });
      await expect
        .poll(
          async () =>
            (await rasterState(page)).texts.find((text) => text.id === "label")!.resolution,
        )
        .toBe(4 * density);
      const sharp = await page.locator("[data-text-quality]").screenshot();
      const stable = await rasterState(page);
      expect(stable.texts.find((text) => text.id === "offscreen")!.resolution).toBe(
        Math.max(2, density),
      );

      for (const text of stable.texts) {
        expect(text.width).toBeLessThanOrEqual(4096);
        expect(text.height).toBeLessThanOrEqual(4096);
        expect(text.width * text.height).toBeLessThanOrEqual(4_194_304);
      }

      await page.evaluate(() => {
        const { camera } = Reflect.get(window, "textQuality");

        for (const [x, zoom] of [
          [-120, 4],
          [-80, 3.8],
          [-100, 4],
        ]) {
          camera.setViewport({ x, y: -100, zoom });
          camera.flush();
        }
      });
      expect((await rasterState(page)).texts).toEqual(stable.texts);
      // Render the former fixed-DPR density once as a reference. This is the same
      // retained WebGPU scene; only glyph texture sampling quality differs.
      await page.evaluate((dpr) => {
        const { renderer } = Reflect.get(window, "textQuality");
        for (const node of Reflect.get(renderer, "nodes").values())
          if (node.text) node.text.resolution = Math.min(dpr, node.text.resolution);
        Reflect.get(renderer, "renderer").render({ container: Reflect.get(renderer, "world") });
      }, density);
      const blurry = await page.locator("[data-text-quality]").screenshot();
      await writeFile(`/tmp/flies-text-sharp-dpr${density}.png`, sharp);
      await writeFile(`/tmp/flies-text-old-dpr${density}.png`, blurry);
      const sharpStats = await softness(page, sharp, density);
      const blurryStats = await softness(page, blurry, density);

      for (let index = 0; index < sharpStats.length; index++) {
        expect(sharpStats[index].ink).toBeGreaterThan(100);
        expect(sharpStats[index].fraction).toBeLessThan(blurryStats[index].fraction * 0.7);
      }

      expect((await rasterState(page)).errors).toEqual([]);
      await testInfo.attach(`text-400-percent-dpr${density}.png`, {
        body: sharp,
        contentType: "image/png",
      });
      await testInfo.attach(`text-old-density-dpr${density}.png`, {
        body: blurry,
        contentType: "image/png",
      });
    });
  });
}

test("GPU text baselines match browser text for normal and tight line boxes", async ({ page }) => {
  await mount(page);

  const samples = await page.evaluate(async () => {
    const fixture = Reflect.get(window, "textQuality");

    const fixtureNodes = [
      { fontFamily: "Arial", lineHeight: 1.25 },
      { fontFamily: "Arial", lineHeight: 0.8 },
      { fontFamily: "Georgia", lineHeight: 1 },
      { fontFamily: "Arial", fontStyle: "italic", lineHeight: 0.9 },
    ].map((style, index) => ({
      id: `baseline-${index}`,
      name: `Baseline ${index}`,
      kind: "text",
      x: 50,
      y: 40 + index * 130,
      width: 400,
      height: 90,
      text: "Éq Åy Open",
      fontSize: 32,
      color: "#000000",
      fontFamily: style.fontFamily,
      fontStyle: style.fontStyle,
      lineHeight: style.lineHeight,
    }));

    fixture.document.replaceAll(fixtureNodes);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );

    return fixtureNodes;
  });

  const gpu = await page.locator("[data-text-quality]").screenshot();
  await page.evaluate((nodes) => {
    const host = document.querySelector("[data-text-quality]")!;
    (host.querySelector("canvas") as HTMLCanvasElement).style.visibility = "hidden";

    for (const node of nodes) {
      const text = document.createElement("span");
      Object.assign(text.style, {
        position: "absolute",
        display: "block",
        left: `${node.x}px`,
        top: `${node.y}px`,
        width: `${node.width}px`,
        height: `${node.height}px`,
        whiteSpace: "pre-wrap",
        overflow: "hidden",
        padding: "0",
        border: "0",
        margin: "0",
        fontSize: `${node.fontSize}px`,
        fontFamily: node.fontFamily,
        fontStyle: node.fontStyle ?? "normal",
        fontWeight: "400",
        lineHeight: String(node.lineHeight),
        color: "#000000",
      });
      text.textContent = node.text;
      host.append(text);
    }
  }, samples);
  const dom = await page.locator("[data-text-quality]").screenshot();

  const bounds = await page.evaluate(
    async ({ images, regions }) => {
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
            const pixels = context.getImageData(
              region.x,
              region.y,
              region.width,
              region.height,
            ).data;

            let top = region.height,
              bottom = -1;

            for (let y = 0; y < region.height; y++)
              for (let x = 0; x < region.width; x++) {
                if (pixels[(y * region.width + x) * 4] < 170) {
                  top = Math.min(top, y);
                  bottom = Math.max(bottom, y);
                }
              }

            return { top, bottom };
          });
        }),
      );
    },
    { images: [gpu.toString("base64"), dom.toString("base64")], regions: samples },
  );

  for (let index = 0; index < samples.length; index++) {
    expect(bounds[0][index].bottom).toBeGreaterThan(0);
    expect(Math.abs(bounds[0][index].top - bounds[1][index].top)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds[0][index].bottom - bounds[1][index].bottom)).toBeLessThanOrEqual(1);
  }

  await writeFile("/tmp/flies-text-baseline-gpu.png", gpu);
  await writeFile("/tmp/flies-text-baseline-dom.png", dom);
});

/* eslint-disable no-await-in-loop -- Each capture depends on the preceding camera or document update. */
for (const density of [1, 2]) {
  test.describe(`minified text density ${density}`, () => {
    test.use({ deviceScaleFactor: density });
    test("zooming out after close inspection preserves thin strokes while panning", async ({
      page,
    }, testInfo) => {
      await mount(page);
      await page.evaluate(() => {
        const fixture = Reflect.get(window, "textQuality");
        document.querySelector<HTMLElement>("[data-text-quality]")!.style.background = "#0c0c0c";
        fixture.document.replaceAll([
          {
            id: "headline",
            name: "Headline",
            kind: "text",
            x: 50,
            y: 50,
            width: 520,
            height: 60,
            text: "Same canvas. Same layers.",
            fontSize: 40,
            fontFamily: "Arial",
            color: "#ececec",
          },
          {
            id: "button",
            name: "Button label",
            kind: "text",
            x: 50,
            y: 150,
            width: 280,
            height: 40,
            text: "Open in browser",
            fontSize: 15,
            fontFamily: "Arial",
            color: "#ececec",
          },
        ]);
        fixture.camera.setViewport({ x: 0, y: 0, zoom: 4 });
        fixture.camera.flush();
      });
      await expect
        .poll(
          async () =>
            (await rasterState(page)).texts.find((text) => text.id === "button")!.resolution,
        )
        .toBe(4 * density);
      const textures = await rasterState(page);
      const results = [];

      for (const zoom of [0.52, 0.25, 0.125]) {
        const frames: string[] = [];

        for (const phase of [0, 0.25, 0.5, 0.75]) {
          await page.evaluate(
            ({ zoom: scale, phase: offset }) => {
              const { camera } = Reflect.get(window, "textQuality");
              camera.setViewport({ x: 40 + offset, y: 40 + offset, zoom: scale });
              camera.flush();
            },
            { zoom, phase },
          );
          const screenshot = await page.locator("[data-text-quality]").screenshot();
          frames.push(screenshot.toString("base64"));
          if (phase === 0)
            await testInfo.attach(`overview-${zoom}-dpr${density}.png`, {
              body: screenshot,
              contentType: "image/png",
            });
        }

        const coverage = await page.evaluate(
          async ({ images, zoom: scale, density: pixelRatio }) => {
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

                return [50, 150].map((y) => {
                  const data = context.getImageData(
                    Math.floor((40 + 48 * scale) * pixelRatio),
                    Math.floor((40 + (y - 2) * scale) * pixelRatio),
                    Math.ceil((524 * scale + 3) * pixelRatio),
                    Math.ceil((64 * scale + 3) * pixelRatio),
                  ).data;

                  let ink = 0;
                  for (let i = 0; i < data.length; i += 4) ink += Math.max(0, (data[i] - 12) / 224);

                  return ink;
                });
              }),
            );
          },
          { images: frames, zoom, density },
        );

        for (const index of [0, 1]) {
          const ink = coverage.map((sample) => sample[index]);

          const variation =
            (Math.max(...ink) - Math.min(...ink)) / (ink.reduce((a, b) => a + b, 0) / ink.length);

          results.push({ zoom, index, variation, ink });
          expect(Math.min(...ink), `visible strokes at ${zoom}`).toBeGreaterThan(1);
          // At fewer than three device pixels tall, 8-bit coverage and mask
          // quantization are significant even with correct filtered sampling.
          const tinyGlyph = (index === 0 ? 40 : 15) * zoom * density < 3;
          expect
            .soft(variation, `stroke coverage while panning at ${zoom}, label ${index}`)
            .toBeLessThan(tinyGlyph ? 0.1 : 0.035);
        }
      }

      await testInfo.attach("minified-text-coverage.json", {
        body: JSON.stringify(results, null, 2),
        contentType: "application/json",
      });
      expect((await rasterState(page)).texts).toEqual(textures.texts);
      expect((await rasterState(page)).errors).toEqual([]);
    });
  });
}

test.describe("Retina compositing", () => {
  test.use({ deviceScaleFactor: 2 });
  test("nested frames and appearance filters preserve the sharpness of ungrouped artwork", async ({
    page,
  }, testInfo) => {
    await mount(page);
    const images = [];

    for (const zoom of [0.52, 1, 2]) {
      const screenshots: Buffer[] = [];

      for (const variant of ["flat", "nested", "filtered", "blended"]) {
        await page.evaluate(
          async ({ zoom: scale, variant: treatment }) => {
            const { document: doc, camera } = Reflect.get(window, "textQuality");

            const content = [
              {
                id: "headline",
                name: "Headline",
                kind: "text",
                x: 60,
                y: 60,
                width: 480,
                height: 48,
                text: "A design canvas you can use.",
                fontSize: 32,
                fontFamily: "Arial",
                color: "#000000",
              },
              {
                id: "label",
                name: "Label",
                kind: "text",
                x: 60,
                y: 140,
                width: 280,
                height: 28,
                text: "Open in browser",
                fontSize: 15,
                fontFamily: "Arial",
                color: "#000000",
              },
              {
                id: "line",
                name: "Thin divider",
                kind: "rectangle",
                x: 60,
                y: 200,
                width: 300,
                height: 1,
                fill: "#000000",
              },
            ];

            const containers =
              treatment === "flat"
                ? []
                : Array.from({ length: 6 }, (_, index) => ({
                    id: `container-${index}`,
                    name: "Container",
                    kind: index % 2 ? "group" : "frame",
                    x: 30,
                    y: 30,
                    width: 600,
                    height: 260,
                    fill: "#00000000",
                    clipContent: false,
                    ...(index ? { parentId: `container-${index - 1}` } : {}),
                    ...(treatment === "filtered" && index === 3
                      ? { filters: { grayscale: 1 } }
                      : {}),
                    ...(treatment === "blended" && index === 3 ? { blendMode: "multiply" } : {}),
                  }));

            if (containers.length)
              for (const frame of content) Object.assign(frame, { parentId: "container-5" });
            doc.replaceAll([...containers, ...content]);
            camera.setViewport({ x: 20.25, y: 20.25, zoom: scale });
            camera.flush();
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            );
          },
          { zoom, variant },
        );
        const png = await page.locator("[data-text-quality]").screenshot();
        screenshots.push(png);
        await testInfo.attach(`${variant}-${zoom}.png`, { body: png, contentType: "image/png" });
      }

      const errors = await page.evaluate(
        async (pngs) => {
          const pixels = await Promise.all(
            pngs.map(async (png) => {
              const image = new Image();
              image.src = `data:image/png;base64,${png}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const ctx = canvas.getContext("2d")!;
              ctx.drawImage(image, 0, 0);

              return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            }),
          );

          let ink = 0;
          for (let i = 0; i < pixels[0].length; i += 4) ink += 255 - pixels[0][i];

          return pixels.slice(1).map((data) => {
            let difference = 0;
            for (let i = 0; i < data.length; i += 4) difference += Math.abs(data[i] - pixels[0][i]);

            return difference / ink;
          });
        },
        screenshots.map((png) => png.toString("base64")),
      );

      images.push({ zoom, errors });
      for (const [index, error] of errors.entries())
        expect
          .soft(error, `${["nested", "filtered", "blended"][index]} pixels at ${zoom}`)
          .toBeLessThan(0.1);
    }

    await testInfo.attach("compositing-differences.json", {
      body: JSON.stringify(images, null, 2),
      contentType: "application/json",
    });
    await writeFile("/tmp/flies-compositing-differences.json", JSON.stringify(images));
    expect((await rasterState(page)).errors).toEqual([]);
  });
});

/* eslint-enable no-await-in-loop */
