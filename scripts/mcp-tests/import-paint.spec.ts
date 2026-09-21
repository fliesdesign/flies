import { expect, test } from "@playwright/test";

test("HTML paint preserves nested rotation, origin, gradient, ordered filters and PNG pixels", async ({
  page,
}) => {
  await page.goto("/");

  const sourceHtml = `<main data-name="Art" style="position:relative;width:500px;height:400px;background:#ffffff">
<div data-name="Rotated" style="position:absolute;left:150px;top:100px;width:200px;height:160px;transform:translate(12px,8px) rotate(30deg);transform-origin:20px 40px;background:linear-gradient(125deg,#ff3300, #2255ff);filter:contrast(0.8) brightness(0.7)">
<div data-name="Child" style="position:absolute;left:25px;top:40px;width:90px;height:55px;background:#44ee99;rotate:-20deg;mix-blend-mode:multiply"></div></div>
<div data-name="Radial" style="position:absolute;left:15px;top:280px;width:120px;height:80px;background:radial-gradient(ellipse at center,#ff000080 0%,#0000ff00 100%) #88bb88"></div></main>`;

  const result = await page.evaluate(async (html) => {
    const htmlPath = "/packages/html/src/html.ts",
      exportPath = "/src/components/canvas/canvas-export.tsx";

    const { importHtml } = await import(/* @vite-ignore */ htmlPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    const nodes = await importHtml(html, { x: 0, y: 0, width: 500 });
    const blob = await exportCanvasPng(nodes, [nodes[0].id]);

    const url = URL.createObjectURL(blob),
      image = new Image();

    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);

    const points = [
      { x: 220, y: 130 },
      { x: 260, y: 170 },
      { x: 210, y: 170 },
      { x: 310, y: 230 },
      { x: 75, y: 320 },
      { x: 20, y: 285 },
    ];

    const pixels = points.map((p) => Array.from(ctx.getImageData(p.x, p.y, 1, 1).data));
    URL.revokeObjectURL(url);
    const source = document.createElement("div");
    source.dataset.source = "true";
    source.style.cssText = "position:fixed;left:0;top:0;width:500px;height:400px;z-index:99999;";
    source.innerHTML = html;
    document.body.append(source);

    return { nodes, points, pixels };
  }, sourceHtml);

  expect(result.nodes.find((n) => n.name === "Rotated")).toMatchObject({
    width: 200,
    height: 160,
    rotation: expect.closeTo(30, 3),
    filters: { order: ["contrast", "brightness"] },
    gradient: { type: "linear" },
  });
  expect(result.nodes.find((n) => n.name === "Child")).toMatchObject({
    rotation: expect.closeTo(-20, 3),
    blendMode: "multiply",
  });
  const screenshot = await page.locator("[data-source]").screenshot();

  const expected = await page.evaluate(
    async ({ png, points }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);

      return points.map((p) => Array.from(ctx.getImageData(p.x, p.y, 1, 1).data));
    },
    { png: screenshot.toString("base64"), points: result.points },
  );

  for (let i = 0; i < expected.length; i++)
    for (let c = 0; c < 3; c++)
      expect(
        Math.abs(result.pixels[i][c] - expected[i][c]),
        `sample ${i}: native ${result.pixels[i]} HTML ${expected[i]}`,
      ).toBeLessThanOrEqual(5);
});

test("Tailwind paint imports through MCP validation, edits, persistence and undo", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts",
      projectPath = "/packages/canvas/src/canvas-project.ts";

    const { editorTool } = await import(/* @vite-ignore */ editorPath),
      { CanvasDocument } = await import(/* @vite-ignore */ docPath),
      { packCanvasProject, unpackCanvasProject } = await import(/* @vite-ignore */ projectPath);

    const doc = new CanvasDocument();
    const controls = { document: doc, prepare: () => {}, select: () => {}, getSelection: () => [] };

    const args = {
      html: '<section data-name="Paint" class="h-40 w-64 bg-linear-to-r from-red-500 via-green-500 to-blue-500 rotate-12 translate-x-4 blur-xs brightness-125 contrast-75 grayscale-25 hue-rotate-30 invert-10 saturate-150 sepia-25 mix-blend-screen"><p>Editable</p></section>',
    };

    const preview = await editorTool(controls, "write_html", { ...args, validateOnly: true });
    const countBefore = doc.getIds().length;
    await editorTool(controls, "write_html", args);
    const imported = doc.getFrames();
    const root = imported[0];

    const restored = unpackCanvasProject(
      packCanvasProject("Paint", imported, doc.getTheme()),
    ).nodes;

    await editorTool(controls, "update_node", { nodeId: root.id, properties: { rotation: 45 } });
    doc.undo();
    const afterUndo = doc.getFrame(root.id);
    doc.undo();

    return {
      preview: JSON.parse(preview.content[0].text),
      countBefore,
      root,
      imported,
      restored,
      afterUndo,
      empty: doc.getIds().length === 0,
    };
  });

  expect(result.preview.applied).toBe(false);
  expect(result.countBefore).toBe(0);
  expect(result.root).toMatchObject({
    rotation: expect.closeTo(12, 8),
    x: 16,
    gradient: { interpolation: "oklab", stops: expect.any(Array) },
    blendMode: "screen",
    filters: {
      blur: 4,
      brightness: 1.25,
      order: ["blur", "brightness", "contrast", "grayscale", "hue", "invert", "saturate", "sepia"],
    },
  });
  expect(result.restored).toEqual(result.imported);
  expect(result.afterUndo.rotation).toBeCloseTo(12);
  expect(result.empty).toBe(true);
});

test("unrepresentable paint fails atomically with actionable errors", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";

    const { editorTool } = await import(/* @vite-ignore */ editorPath),
      { CanvasDocument } = await import(/* @vite-ignore */ docPath);

    const doc = new CanvasDocument([
      { id: "target", name: "Original", x: 0, y: 0, width: 300, height: 300 },
    ]);

    const controls = { document: doc, prepare: () => {}, select: () => {}, getSelection: () => [] };

    const before = JSON.stringify(doc.getFrames()),
      errors = [];

    for (const style of [
      "transform:skewX(20deg)",
      "transform:scale(2)",
      "background:conic-gradient(red,blue)",
      "background:radial-gradient(at left,red,blue)",
      "filter:brightness(2) brightness(.5)",
      "filter:drop-shadow(0 0 2px red)",
      "background:linear-gradient(red -20%,blue 100%)",
    ]) {
      try {
        // Mutations against the same target must remain sequential.
        // eslint-disable-next-line no-await-in-loop
        await editorTool(controls, "write_html", {
          targetId: "target",
          html: `<div style="width:200px;height:100px;${style}">Bad</div>`,
        });
      } catch (error) {
        errors.push(String(error));
      }
    }

    return { errors, unchanged: before === JSON.stringify(doc.getFrames()) };
  });

  expect(result.errors).toHaveLength(7);
  expect(result.unchanged).toBe(true);
});

test("gradient import preserves corner directions, stop fixup and modern color interpolation", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/packages/html/src/html.ts",
      paintPath = "/packages/canvas/src/canvas-paint.ts";

    const { importHtml } = await import(/* @vite-ignore */ path),
      { gradientCss } = await import(/* @vite-ignore */ paintPath);

    const gradients = [
      "linear-gradient(to top right,red,blue)",
      "linear-gradient(to bottom left,red 10%,green,blue 90%)",
      "linear-gradient(90deg,red 0px 45px,blue 45px 240px)",
      "linear-gradient(to right, oklch(63.7% 0.237 25.331), oklch(62.3% 0.214 259.815))",
      "radial-gradient(ellipse at center in oklab,red,blue)",
    ];

    const host = document.createElement("div");
    host.dataset.gradientComparison = "true";
    host.style.cssText = "position:fixed;left:0;top:0;z-index:99999;width:480px;background:white";

    for (const gradient of gradients) {
      // Each import creates and cleans up its own measurement host.
      // eslint-disable-next-line no-await-in-loop
      const nodes = await importHtml(
        `<div style="width:240px;height:100px;background:${gradient}"></div>`,
        { x: 0, y: 0, width: 240 },
      );

      const row = document.createElement("div");
      row.style.cssText = "display:flex;height:100px";

      for (const background of [gradient, gradientCss(nodes[0].gradient)]) {
        const block = document.createElement("div");
        block.style.cssText = "width:240px;height:100px";
        block.style.background = background;
        row.append(block);
      }

      host.append(row);
    }

    document.body.append(host);
  });
  const png = await page.locator("[data-gradient-comparison]").screenshot();

  const comparisons = await page.evaluate(async (data) => {
    const image = new Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);

    return Array.from({ length: 5 }, (_, row) =>
      [20, 60, 120, 200, 225].map((x) => ({
        original: Array.from(ctx.getImageData(x, row * 100 + 35, 1, 1).data),
        imported: Array.from(ctx.getImageData(x + 240, row * 100 + 35, 1, 1).data),
      })),
    );
  }, png.toString("base64"));

  for (const [row, samples] of comparisons.entries())
    for (const sample of samples)
      for (let c = 0; c < 3; c++)
        expect(
          Math.abs(sample.original[c] - sample.imported[c]),
          `gradient ${row}: original ${sample.original}, imported ${sample.imported}`,
        ).toBeLessThanOrEqual(6);
});
