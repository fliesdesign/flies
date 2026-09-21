import { expect, test } from "@playwright/test";

test("SVG file import preserves vectors through projects, clipboard, and code export", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const module = "/packages/canvas/src/index.ts";
    const exporter = "/src/lib/canvas-code-export.ts";

    const {
      readCanvasImage,
      CanvasDocument,
      packCanvasProject,
      unpackCanvasProject,
      encodeCanvasClipboard,
      decodeCanvasClipboard,
    } = await import(/* @vite-ignore */ module);

    const { exportCanvasCode } = await import(/* @vite-ignore */ exporter);

    const asset = await readCanvasImage(
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 24" onload="alert(1)"><script>alert(1)</script><foreignObject/><image href="https://example.invalid/track"/><defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs><rect width="32" height="24" fill="url(#paint)"/></svg>',
        ],
        "Logo.svg",
        { type: "image/svg+xml" },
      ),
    );

    const scene = new CanvasDocument([{ ...asset, id: "svg", x: 10, y: 20 }]);
    const initial = scene.getFrame("svg");
    scene.update({ ...initial, width: 320, height: 240 });
    scene.undo();
    const restored = scene.getFrame("svg");
    scene.redo();
    const saved = unpackCanvasProject(packCanvasProject("Vectors", scene.getFrames())).nodes[0];
    const copied = decodeCanvasClipboard(encodeCanvasClipboard(scene.getFrames(), ["svg"]))[0];

    return {
      asset,
      restored,
      saved,
      copied,
      source: atob(asset.src.split(",")[1]),
      code: exportCanvasCode(scene.getFrames(), ["svg"], "css"),
    };
  });

  expect(result.asset).toMatchObject({ kind: "svg", width: 32, height: 24, name: "Logo" });
  expect(result.source).toContain("linearGradient");
  expect(result.source).not.toMatch(/script|onload|foreignObject|https:\/\/example/);
  expect(result.restored).toMatchObject({ width: 32, height: 24, src: result.asset.src });
  expect(result.saved).toMatchObject({ kind: "svg", width: 320, src: result.asset.src });
  expect(result.copied).toMatchObject({ kind: "svg", src: result.asset.src });
  expect(result.code).toContain(result.asset.src);
});

test("inline SVG imports as a vector node with inherited color and exports visible pixels", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const module = "/packages/html/src/html.ts";
    const exporter = "/src/components/canvas/canvas-export.tsx";
    const { importHtml } = await import(/* @vite-ignore */ module);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exporter);

    const nodes = await importHtml(
      '<div style="width:100px;height:100px;color:#ff0000"><svg data-name="Icon" width="100" height="100" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></svg></div>',
      { x: 0, y: 0, width: 100 },
    );

    const node = nodes.find((item: { kind: string }) => item.kind === "svg");
    const png = await exportCanvasPng(nodes, [node.id]);
    const image = new Image();
    image.src = URL.createObjectURL(png);
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    URL.revokeObjectURL(image.src);

    return { node, pixel: [...context.getImageData(50, 50, 1, 1).data] };
  });

  expect(result.node).toMatchObject({ kind: "svg", name: "Icon", width: 100, height: 100 });
  expect(result.pixel).toEqual([255, 0, 0, 255]);
});

test("SVG files reject malformed markup", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const module = "/packages/canvas/src/canvas-svg.ts";
    const { readCanvasSvg } = await import(/* @vite-ignore */ module);

    try {
      readCanvasSvg("<svg><path></svg>");
    } catch (error) {
      return String(error);
    }

    return "accepted";
  });

  expect(result).toContain("not valid SVG");
});
