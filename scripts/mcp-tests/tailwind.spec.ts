import { expect, test } from "@playwright/test";

function find<T extends { name: string }>(nodes: T[], name: string) {
  return nodes.find((node) => node.name === name);
}

test("MCP compiles Tailwind offline into editable geometry, colors, typography and effects", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";

    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const doc = new CanvasDocument();
    const controls = { document: doc, prepare: () => {} };

    const html = `<section data-name="Card" class="flex w-[400px] flex-col gap-4 rounded-xl border border-slate-200 bg-white p-6 shadow-md">
      <h2 class="text-2xl font-bold text-blue-600">Tailwind works</h2>
      <p class="text-sm leading-6 text-slate-600">Editable text</p>
      <div data-name="Grid" class="grid grid-cols-2 gap-3"><div data-name="A" class="h-12 bg-red-500"></div><div data-name="B" class="h-12 bg-blue-500" style="background-color:#00ff00"></div></div>
      <button class="h-10 rounded-full bg-black px-4 text-white">Continue</button>
    </section>`;

    const preview = JSON.parse(
      (await editorTool(controls, "write_html", { html, width: 600, validateOnly: true }))
        .content[0].text,
    );

    const previewCount = doc.getIds().length;

    const response = JSON.parse(
      (await editorTool(controls, "write_html", { html, width: 600, x: 50, y: 60 })).content[0]
        .text,
    );

    const nodes = doc.getFrames();
    const before = JSON.stringify(nodes);
    doc.undo();
    const undone = doc.getIds().length;
    doc.redo();

    return {
      preview,
      previewCount,
      response,
      nodes,
      undone,
      redone: JSON.stringify(doc.getFrames()) === before,
      iframes: window.document.querySelectorAll("iframe").length,
    };
  });

  expect(result.preview.applied).toBe(false);
  expect(result.previewCount).toBe(0);
  expect(result.response.applied).toBe(true);
  const card = result.nodes.find((n: { name: string }) => n.name === "Card");
  const title = result.nodes.find((n: { text: string }) => n.text === "Tailwind works");
  const a = result.nodes.find((n: { name: string }) => n.name === "A");
  const b = result.nodes.find((n: { name: string }) => n.name === "B");
  expect(card).toMatchObject({
    x: 50,
    y: 60,
    width: 400,
    cornerRadius: 12,
    borderWidth: 1,
    fill: "#ffffffff",
  });
  expect(card.shadows.length).toBeGreaterThan(0);
  expect(title).toMatchObject({
    kind: "text",
    x: 75,
    y: 85,
    fontSize: 24,
    fontWeight: 700,
    fontFamily: "Arial",
  });
  expect(title.color).not.toBe("#000000ff");
  expect(a.width).toBe(169);
  expect(b.x - a.x).toBe(181);
  expect(b.fill).toBe("#00ff00ff");
  expect(result.undone).toBe(0);
  expect(result.redone).toBe(true);
  expect(result.iframes).toBe(0);
});

test("responsive utilities use import width and remain isolated across calls and editor styles", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const path = "/src/lib/mcp/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);
    const before = getComputedStyle(document.body).backgroundColor;
    document.documentElement.style.fontSize = "20px";

    const html =
      '<section data-name="Responsive" class="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 bg-white"><div data-name="First" class="h-12 bg-blue-500"></div><div data-name="Second" class="h-12 bg-red-500"></div></section>';

    const narrow = await importHtml(html, { x: 0, y: 0, width: 400 });
    const wide = await importHtml(html, { x: 0, y: 0, width: 800 });

    const plain = await importHtml(
      '<section data-name="Plain" class="w-[123px] h-12 bg-white"></section>',
      { x: 0, y: 0, width: 800 },
    );

    const unchanged = before === getComputedStyle(document.body).backgroundColor;
    document.documentElement.style.removeProperty("font-size");

    return { narrow, wide, plain, unchanged };
  });

  expect(find(result.narrow, "First")).toMatchObject({ x: 16, y: 16, width: 368, height: 48 });
  expect(find(result.narrow, "Second")).toMatchObject({ x: 16, y: 80 });
  expect(find(result.wide, "First")).toMatchObject({ x: 16, y: 16, width: 376 });
  expect(find(result.wide, "Second")).toMatchObject({ x: 408, y: 16 });
  expect(result.plain[0].width).toBe(123);
  expect(result.unchanged).toBe(true);
});

test("Tailwind replacements are atomic and reject unsupported or resource-loading utilities", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";

    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);

    const doc = new CanvasDocument([
      { id: "target", name: "Old", x: 20, y: 30, width: 400, height: 200 },
    ]);

    const controls = { document: doc, prepare: () => {} };
    await editorTool(controls, "write_html", {
      targetId: "target",
      html: '<section data-name="New" class="h-full w-full bg-white p-4"><p class="text-xl text-red-500">New content</p></section>',
    });
    const nodes = doc.getFrames();
    const before = JSON.stringify(nodes);
    const errors = [];

    for (const cls of [
      "bg-[url(https://example.com/image.png)]",
      "bg-conic from-red-500 to-blue-500",
      "skew-x-12",
      "before:content-['bad']",
    ]) {
      try {
        // Exercise serial MCP edits against the same target.
        // eslint-disable-next-line no-await-in-loop
        await editorTool(controls, "write_html", {
          targetId: "target",
          html: `<section class="h-40 ${cls}">Bad</section>`,
        });
      } catch (error) {
        errors.push(String(error));
      }
    }

    return {
      nodes,
      errors,
      unchanged: before === JSON.stringify(doc.getFrames()),
      iframes: document.querySelectorAll("iframe").length,
    };
  });

  expect(result.nodes[0]).toMatchObject({
    id: "target",
    name: "New",
    x: 20,
    y: 30,
    width: 400,
    height: 200,
  });
  expect(result.errors).toHaveLength(4);
  expect(result.unchanged).toBe(true);
  expect(result.iframes).toBe(0);
});
