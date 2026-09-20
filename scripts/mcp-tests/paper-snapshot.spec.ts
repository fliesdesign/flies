import { readFileSync, writeFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import type { CanvasFrame } from "../../src/lib/canvas-document";

const sample = readFileSync(new URL("./fixtures/paper-snapshot.txt", import.meta.url), "utf8");
const sourceImageUrls = Array.from(sample.matchAll(/<img[^>]+src="([^"]+)"/g), (match) => match[1]);
const smallSnapshot = `<meta charset="utf-8"><x-paper-html><div style="width:240px;height:80px;box-sizing:border-box;background:#ffffff;padding:16px"><span style="font:20px Arial;color:#111111">Editable capture</span></div></x-paper-html>`;
const fixture = "[data-snapshot-fixture]";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "snapshotFixture", await mountSnapshotFixture());
  });
}

async function paste(page: Page, source: string, options: { text?: string; image?: boolean } = {}) {
  return page.evaluate(
    ({ html, text, image }) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      if (text) data.setData("text/plain", text);
      if (image)
        data.items.add(new File([new Uint8Array([1, 2, 3])], "preview.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      Reflect.get(window, "snapshotFixture").controls.surface.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { html: source, ...options },
  );
}

async function frames(page: Page): Promise<CanvasFrame[]> {
  return page.evaluate(() => Reflect.get(window, "snapshotFixture").controls.document.getFrames());
}

async function routeSnapshotImages(page: Page) {
  const images = await page.evaluate(
    (urls) =>
      urls.map((url, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = index ? 32 : 19;
        canvas.height = index ? 32 : 11;
        const context = canvas.getContext("2d")!;
        context.fillStyle = index ? "#4285f4" : "#c0c0c0";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#ffffff";
        if (index) {
          context.beginPath();
          context.arc(16, 16, 8, 0, Math.PI * 2);
          context.fill();
        } else {
          for (let x = 2; x < 17; x += 4) context.fillRect(x, 3, 2, 2);
          context.fillRect(4, 7, 11, 2);
        }
        return { url, base64: canvas.toDataURL().split(",")[1] };
      }),
    sourceImageUrls,
  );
  const requests: string[] = [];
  await Promise.all(
    images.map(({ url, base64 }) =>
      page.route(url, async (route) => {
        requests.push(route.request().url());
        await route.fulfill({
          contentType: "image/png",
          body: Buffer.from(base64, "base64"),
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }),
    ),
  );
  return requests;
}

test("the supplied Paper capture keeps its natural box size, text, and rasterized SVG artwork", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const assetRequests = await routeSnapshotImages(page);
  const result = await page.evaluate(async (html) => {
    const path = "/src/lib/paper-snapshot.ts";
    const { importPaperSnapshot, isPaperSnapshot } = await import(/* @vite-ignore */ path);
    const { nodes, warnings } = await importPaperSnapshot(html);
    const imageNodes = nodes.filter((node: CanvasFrame) => node.kind === "image");
    const paintedPixels = await Promise.all(
      imageNodes.map(async (node: { src: string }) => {
        const image = new Image();
        image.src = node.src;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let painted = 0;
        for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) painted++;
        return painted;
      }),
    );
    const documentPath = "/src/lib/canvas-document.ts";
    const exportPath = "/src/components/canvas/canvas-export.tsx";
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    const scene = new CanvasDocument(nodes);
    const png = await exportCanvasPng(scene.getFrames(), scene.getChildren());
    const pngBytes = Array.from(new Uint8Array(await png.arrayBuffer()));
    return { recognized: isPaperSnapshot(html), nodes, warnings, paintedPixels, pngBytes };
  }, sample);
  writeFileSync(testInfo.outputPath("paper-snapshot.png"), Buffer.from(result.pngBytes));
  expect(result.recognized).toBe(true);
  const roots = result.nodes.filter((node: CanvasFrame) => !node.parentId);
  expect(roots).toHaveLength(1);
  expect(roots[0]).toMatchObject({ name: "Paper snapshot", x: 0, y: 0, width: 1544, height: 56 });
  const text = result.nodes
    .filter((node: CanvasFrame) => node.kind === "text")
    .map((node: { text: string }) => node.text);
  expect(text).toEqual(expect.arrayContaining(["DK", "Opret", "9+", "Søg"]));
  expect(
    result.nodes.find((node: CanvasFrame) => node.kind === "text" && node.text === "Søg"),
  ).toMatchObject({ color: "#757575ff" });
  expect(result.paintedPixels.length).toBeGreaterThan(3);
  expect(result.paintedPixels.every((count: number) => count > 0)).toBe(true);
  expect(sourceImageUrls).toHaveLength(2);
  expect(assetRequests).toEqual(expect.arrayContaining(sourceImageUrls));
  expect(assetRequests).toHaveLength(2);
  expect(result.nodes.some((node: CanvasFrame) => node.name === "Image placeholder")).toBe(false);
  expect(
    result.nodes.every(
      (node: CanvasFrame) => node.kind !== "image" || node.src.startsWith("data:image/png;base64,"),
    ),
  ).toBe(true);
  const ids = new Set(result.nodes.map((node: CanvasFrame) => node.id));
  expect(result.nodes.every((node: CanvasFrame) => !node.parentId || ids.has(node.parentId))).toBe(
    true,
  );
  expect(
    result.nodes.every((node: CanvasFrame) =>
      [node.x, node.y, node.width, node.height].every(Number.isFinite),
    ),
  ).toBe(true);
});

test("HTML clipboard paste imports the supplied capture before plain text or an image, with one undo step", async ({
  page,
}) => {
  await mount(page);
  await routeSnapshotImages(page);
  expect(await paste(page, sample, { text: "Flattened clipboard fallback", image: true })).toBe(
    true,
  );
  await expect.poll(async () => (await frames(page)).length).toBeGreaterThan(5);
  const imported = await frames(page);
  expect(imported.filter((node) => !node.parentId)).toHaveLength(1);
  expect(imported[0]).toMatchObject({ name: "Paper snapshot", width: 1544, height: 56 });
  expect(
    imported.some((node) => node.kind === "text" && node.text === "Flattened clipboard fallback"),
  ).toBe(false);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "snapshotFixture").controls.getSelection()))
    .toEqual([imported[0].id]);
  await page.locator(`${fixture} .design-canvas`).focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await frames(page)).length).toBe(0);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(async () => await frames(page)).toEqual(imported);
});

test("captured text remains editable and its paste event is left to the active text editor", async ({
  page,
}) => {
  await mount(page);
  await paste(page, smallSnapshot);
  await expect
    .poll(async () => (await frames(page)).some((node) => node.kind === "text"))
    .toBe(true);
  const textNode = (await frames(page)).find((node) => node.kind === "text")!;
  await page
    .locator(`${fixture} .canvas-frame-position[data-frame-id="${textNode.id}"]`)
    .dblclick();
  const editor = page.locator(`${fixture} textarea.canvas-text-editor`);
  await expect(editor).toBeVisible();
  const before = await frames(page);
  const prevented = await editor.evaluate((element, html) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "Ordinary text paste");
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, smallSnapshot);
  expect(prevented).toBe(false);
  expect(await frames(page)).toEqual(before);
  await editor.fill("Edited after importing");
  await editor.press("Control+Enter");
  await expect
    .poll(async () => (await frames(page)).find((node) => node.id === textNode.id))
    .toMatchObject({ kind: "text", text: "Edited after importing" });
});

test("the context-menu Paste command reads text/html from the Clipboard API", async ({ page }) => {
  await mount(page);
  await page.evaluate((html) => {
    Object.defineProperty(navigator.clipboard, "read", {
      configurable: true,
      value: async () => [
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob(["Wrong plain fallback"], { type: "text/plain" }),
        }),
      ],
    });
  }, smallSnapshot);
  await page
    .locator(`${fixture} .design-canvas`)
    .click({ button: "right", position: { x: 320, y: 220 } });
  await page.getByRole("menuitem", { name: /^Paste\s*⌘/ }).click();
  await expect
    .poll(async () => (await frames(page)).filter((node) => !node.parentId))
    .toHaveLength(1);
  const imported = await frames(page);
  expect(imported[0]).toMatchObject({
    name: "Paper snapshot",
    x: 320,
    y: 220,
    width: 240,
    height: 80,
  });
  expect(imported.some((node) => node.kind === "text" && node.text === "Editable capture")).toBe(
    true,
  );
});

test("internal node clipboard data takes priority over Paper HTML", async ({ page }) => {
  await mount(page);
  await page.evaluate((html) => {
    const data = new DataTransfer();
    data.setData(
      "application/x-lra-canvas+json",
      JSON.stringify({
        type: "lra-canvas",
        version: 1,
        nodes: [{ id: "original", name: "Internal frame", x: 10, y: 20, width: 100, height: 90 }],
      }),
    );
    data.setData("text/html", html);
    Reflect.get(window, "snapshotFixture").controls.surface.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, smallSnapshot);
  await expect.poll(async () => (await frames(page)).length).toBe(1);
  expect((await frames(page))[0]).toMatchObject({ name: "Internal frame", width: 100, height: 90 });
});

test("context-menu Paste falls back to plain text when reading rich clipboard data is denied", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "read", {
      configurable: true,
      value: async () => {
        throw new DOMException("Denied", "NotAllowedError");
      },
    });
    Object.defineProperty(navigator.clipboard, "readText", {
      configurable: true,
      value: async () => "Clipboard fallback",
    });
  });
  await page
    .locator(`${fixture} .design-canvas`)
    .click({ button: "right", position: { x: 320, y: 220 } });
  await page.getByRole("menuitem", { name: /^Paste\s*⌘/ }).click();
  await expect.poll(async () => (await frames(page)).length).toBe(1);
  expect((await frames(page))[0]).toMatchObject({ kind: "text", text: "Clipboard fallback" });
});

test("a real HTML clipboard round-trip preserves the Paper wrapper and imports through keyboard paste", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await mount(page);
  await page.evaluate(async (html) => {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob(["Plain clipboard text"], { type: "text/plain" }),
      }),
    ]);
  }, smallSnapshot);
  await page.locator(`${fixture} .design-canvas`).focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+v" : "Control+v");
  await expect
    .poll(async () => (await frames(page)).filter((node) => !node.parentId))
    .toHaveLength(1);
  expect((await frames(page))[0]).toMatchObject({ name: "Paper snapshot", width: 240, height: 80 });
});

test("an empty Paper snapshot reports failure without inserting its plain-text fallback", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, "snapshotFixture").controls.document.add({
      id: "existing",
      name: "Existing work",
      x: 0,
      y: 0,
      width: 80,
      height: 80,
    });
  });
  const before = await frames(page);
  expect(await paste(page, "<x-paper-html></x-paper-html>", { text: "Do not import me" })).toBe(
    true,
  );
  await expect(page.locator(`${fixture} .canvas-notice`)).toBeVisible();
  await expect(page.locator(`${fixture} .canvas-notice`)).not.toHaveText("Importing…");
  expect(await frames(page)).toEqual(before);
  await page.locator(`${fixture} .design-canvas`).focus();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => await frames(page)).toEqual([]);
});

test("snapshot measurement stays passive: scripts, embeds, and remote CSS images do not execute or fetch", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("https://snapshot.example.invalid/**", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/lib/paper-snapshot.ts";
    const { importPaperSnapshot } = await import(/* @vite-ignore */ path);
    Reflect.set(window, "snapshotScriptRan", false);
    const html = `<x-paper-html><div style="width:300px;height:80px;background-image:url(https://snapshot.example.invalid/style.png)">
      <script>window.snapshotScriptRan=true</script>
      <style>@import url(https://snapshot.example.invalid/style.css);</style>
      <iframe src="https://snapshot.example.invalid/embed"></iframe>
      <img src="https://snapshot.example.invalid/image.png" onerror="window.snapshotScriptRan=true" style="width:20px;height:20px">
      <img src="javascript:window.snapshotScriptRan=true" style="width:20px;height:20px">
      <svg width="20" height="20"><image href="https://snapshot.example.invalid/svg-image.png" width="20" height="20" /><rect width="20" height="20" fill="#333" /></svg>
      <a href="javascript:window.snapshotScriptRan=true">Safe text</a>
    </div></x-paper-html>`;
    const imageRequests: string[] = [];
    const imported = await importPaperSnapshot(html, {
      loadImage: async (url: string) => {
        imageRequests.push(url);
        throw new Error("Offline for this test");
      },
    });
    return { ...imported, imageRequests, executed: Reflect.get(window, "snapshotScriptRan") };
  });
  expect(result.executed).toBe(false);
  expect(
    result.nodes.some((node: CanvasFrame) => node.kind === "text" && node.text === "Safe text"),
  ).toBe(true);
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(result.imageRequests).toEqual(["https://snapshot.example.invalid/image.png"]);
  expect(requests).toEqual([]);
});

test("SVG root opacity is applied once, including CSS overriding the matching presentation attribute", async ({
  page,
}) => {
  await page.goto("/");
  const alphas = await page.evaluate(async () => {
    const importPath = "/src/lib/paper-snapshot.ts";
    const documentPath = "/src/lib/canvas-document.ts";
    const exportPath = "/src/components/canvas/canvas-export.tsx";
    const { importPaperSnapshot } = await import(/* @vite-ignore */ importPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    return Promise.all(
      [
        'width="24" height="24" opacity="0.5" style="opacity:0.5"',
        'width="24" height="24" opacity="0.5"',
      ].map(async (attributes) => {
        const { nodes } = await importPaperSnapshot(
          `<x-paper-html><svg ${attributes} viewBox="0 0 24 24"><rect width="24" height="24" fill="red" /></svg></x-paper-html>`,
        );
        const scene = new CanvasDocument(nodes);
        const png = await exportCanvasPng(scene.getFrames(), scene.getChildren());
        const bitmap = await createImageBitmap(png);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 24;
        const context = canvas.getContext("2d")!;
        context.drawImage(bitmap, 0, 0);
        const alpha = context.getImageData(12, 12, 1, 1).data[3];
        bitmap.close();
        return alpha;
      }),
    );
  });
  expect(alphas).toHaveLength(2);
  for (const alpha of alphas) expect(Math.abs(alpha - 128)).toBeLessThanOrEqual(1);
});

test("captured asymmetric corners preserve transparent corners, fill, and border pixels", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const importPath = "/src/lib/paper-snapshot.ts";
    const documentPath = "/src/lib/canvas-document.ts";
    const exportPath = "/src/components/canvas/canvas-export.tsx";
    const { importPaperSnapshot } = await import(/* @vite-ignore */ importPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    const { nodes } = await importPaperSnapshot(
      '<x-paper-html><div style="box-sizing:border-box;width:80px;height:40px;border:2px solid #0000ff;background:#ff0000;border-radius:20px 0 20px 0"></div></x-paper-html>',
    );
    const scene = new CanvasDocument(nodes);
    const png = await exportCanvasPng(scene.getFrames(), scene.getChildren());
    const bitmap = await createImageBitmap(png);
    const canvas = document.createElement("canvas");
    canvas.width = 80;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const pixel = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
    const pixels = {
      topLeft: pixel(0, 0),
      topRight: pixel(79, 0),
      bottomLeft: pixel(0, 39),
      bottomRight: pixel(79, 39),
      center: pixel(40, 20),
      topEdge: pixel(40, 0),
      curvedBorder: pixel(6, 6),
      insideCurve: pixel(9, 9),
    };
    bitmap.close();
    return { root: nodes[0], pixels };
  });
  expect(result.root).toMatchObject({ width: 80, height: 40 });
  expect(result.pixels.topLeft[3]).toBe(0);
  expect(result.pixels.bottomRight[3]).toBe(0);
  expect(result.pixels.topRight).toEqual([0, 0, 255, 255]);
  expect(result.pixels.bottomLeft).toEqual([0, 0, 255, 255]);
  expect(result.pixels.topEdge).toEqual([0, 0, 255, 255]);
  expect(result.pixels.curvedBorder[0]).toBeLessThan(10);
  expect(result.pixels.curvedBorder[2]).toBeGreaterThan(240);
  expect(result.pixels.curvedBorder[3]).toBeGreaterThan(240);
  expect(result.pixels.insideCurve).toEqual([255, 0, 0, 255]);
  expect(result.pixels.center).toEqual([255, 0, 0, 255]);
});

test("embedded root images decode before measurement and invalid bytes produce a sized placeholder", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const importPath = "/src/lib/paper-snapshot.ts";
    const documentPath = "/src/lib/canvas-document.ts";
    const exportPath = "/src/components/canvas/canvas-export.tsx";
    const { importPaperSnapshot } = await import(/* @vite-ignore */ importPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 6;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#0000ff";
    context.fillRect(0, 0, 8, 6);
    const valid = await importPaperSnapshot(
      `<x-paper-html><img src="${canvas.toDataURL()}" style="display:block;width:16px;height:12px"></x-paper-html>`,
    );
    const scene = new CanvasDocument(valid.nodes);
    const png = await exportCanvasPng(scene.getFrames(), scene.getChildren());
    const bitmap = await createImageBitmap(png);
    canvas.width = 16;
    canvas.height = 12;
    context.drawImage(bitmap, 0, 0);
    const pixel = Array.from(context.getImageData(8, 6, 1, 1).data);
    bitmap.close();
    const invalid = await importPaperSnapshot(
      '<x-paper-html><img src="data:image/png;base64,AAAA" style="display:block;width:16px;height:12px"></x-paper-html>',
    );
    return { valid, invalid, pixel };
  });
  expect(result.valid.nodes[0]).toMatchObject({ width: 16, height: 12 });
  expect(result.valid.nodes.some((node: CanvasFrame) => node.kind === "image")).toBe(true);
  expect(result.pixel).toEqual([0, 0, 255, 255]);
  expect(result.invalid.nodes[0]).toMatchObject({ width: 16, height: 12 });
  expect(result.invalid.nodes.some((node: CanvasFrame) => node.name === "Image placeholder")).toBe(
    true,
  );
  expect(result.invalid.warnings.length).toBeGreaterThan(0);
});
