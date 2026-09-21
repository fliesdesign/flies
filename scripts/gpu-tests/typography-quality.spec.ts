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
