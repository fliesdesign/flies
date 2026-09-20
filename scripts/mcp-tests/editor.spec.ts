import { expect, test } from "@playwright/test";

test("HTML import, document history and screenshot use the real renderer", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const htmlModule = "/src/lib/mcp/html.ts";
    const docModule = "/src/lib/canvas-document.ts";
    const exportModule = "/src/components/canvas/canvas-export.tsx";
    const { importHtml } = await import(/* @vite-ignore */ htmlModule);
    const { CanvasDocument } = await import(/* @vite-ignore */ docModule);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportModule);
    const nodes = await importHtml(
      '<div data-name="Card" style="display:flex;flex-direction:column;gap:12px;padding:20px;width:300px;height:200px;background:#ff0000;border-radius:8px;font-family:Georgia;color:#ffffff"><p style="font-size:24px">Hello Flies</p><div style="width:60px;height:40px;background:#00ff00"></div></div>',
      { x: 100, y: 200, width: 800 },
    );
    const doc = new CanvasDocument();
    doc.addMany(nodes);
    const root = doc.getChildren()[0];
    const text = nodes.find((node: { kind: string }) => node.kind === "text");
    const png = await exportCanvasPng(doc.getCommittedFrames(), [root]);
    const url = URL.createObjectURL(png);
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const pixel = Array.from(ctx.getImageData(10, 100, 1, 1).data);
    URL.revokeObjectURL(url);
    doc.undo();
    const emptyAfterUndo = doc.getIds().length === 0;
    doc.redo();
    return {
      root: nodes[0],
      text,
      pixel,
      pngSize: png.size,
      width: image.width,
      height: image.height,
      emptyAfterUndo,
      restored: doc.getIds().length === nodes.length,
    };
  });
  expect(result.root).toMatchObject({ name: "Card", x: 100, y: 200, width: 300, height: 200 });
  expect(result.text).toMatchObject({ text: "Hello Flies", x: 120, y: 220, fontSize: 24 });
  expect(result.pixel).toEqual([255, 0, 0, 255]);
  expect([result.width, result.height]).toEqual([300, 200]);
  expect(result.pngSize).toBeGreaterThan(500);
  expect(result.emptyAfterUndo && result.restored).toBe(true);
});

test("untrusted or unsupported HTML is rejected without scripts or network requests", async ({
  page,
}) => {
  await page.goto("/");
  const errors = await page.evaluate(async () => {
    const path = "/src/lib/mcp/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);
    const sources = [
      "<script>window.pwned=true</script>",
      '<img src="https://example.com/test.png">',
      '<div onclick="alert(1)">Hi</div>',
      '<div style="background:image-set(&quot;https://example.com/image.png&quot;)">Hi</div>',
      '<div style="transform:rotate(20deg)">Hi</div>',
    ];
    return Promise.all(
      sources.map(async (source) => {
        try {
          await importHtml(source, { x: 0, y: 0, width: 400 });
          return false;
        } catch {
          return true;
        }
      }),
    );
  });
  expect(errors).toEqual([true, true, true, true, true]);
});

test("write_html replacement is atomic and undo restores the old children", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const docPath = "/src/lib/canvas-document.ts";
    const editorPath = "/src/lib/mcp/editor.ts";
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const doc = new CanvasDocument([
      { id: "parent", name: "Frame", x: 100, y: 200, width: 400, height: 300 },
      {
        id: "old",
        parentId: "parent",
        name: "Old",
        kind: "rectangle",
        x: 100,
        y: 200,
        width: 40,
        height: 40,
        fill: "#000000",
      },
    ]);
    const controls = { document: doc, prepare: () => {}, select: () => {}, getSelection: () => [] };
    await editorTool(controls, "write_html", {
      parentId: "parent",
      replace: true,
      x: 10,
      y: 20,
      html: '<div style="width:80px;height:60px;background:#abcdef"></div>',
    });
    const child = doc.getFrame(doc.getChildren("parent")[0]);
    const oldRemoved = !doc.getFrame("old");
    await editorTool(controls, "undo", {});
    const restored = doc.getChildren("parent");
    try {
      await editorTool(controls, "write_html", {
        parentId: "parent",
        replace: true,
        html: "<iframe></iframe>",
      });
    } catch {
      /* Expected. */
    }
    return { child, oldRemoved, restored, afterFailure: doc.getChildren("parent") };
  });
  expect(result.child).toMatchObject({ parentId: "parent", x: 110, y: 220, width: 80, height: 60 });
  expect(result.oldRemoved).toBe(true);
  expect(result.restored).toEqual(["old"]);
  expect(result.afterFailure).toEqual(["old"]);
});
