import { expect, test } from "@playwright/test";

const google = `<main data-name="Google Home" style="width:100%;height:100%;background:white;display:flex;flex-direction:column;font-family:system-ui">
<header style="height:64px;padding:12px 24px;display:flex;justify-content:flex-end;align-items:center;gap:20px"><a>Gmail</a><a>Images</a><button style="background:#1a73e8;color:white;border-radius:4px;padding:10px 24px">Sign in</button></header>
<section style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;flex:1">
<div data-name="Google" style="display:flex;font-size:64px;line-height:1;font-weight:400"><span style="color:#4285f4">G</span><span style="color:#ea4335">o</span><span style="color:#fbbc05">o</span><span style="color:#4285f4">g</span><span style="color:#34a853">l</span><span style="color:#ea4335">e</span></div>
<div data-name="Search" style="display:flex;align-items:center;width:560px;height:46px;padding:0 18px;border:1px solid #dfe1e5;border-radius:999px;background:#ffffff;box-shadow:0 1px 6px rgba(32,33,36,0.18)"><input type="search" placeholder="Search Google or type a URL" style="width:100%;height:100%;font-size:14px;color:#666666" /></div>
<div style="display:flex;gap:12px"><button style="padding:10px 16px;background:#f8f9fa;border:1px solid #dadce0;border-radius:4px">Google Search</button><button style="padding:10px 16px;background:#f8f9fa;border-radius:4px">I'm Feeling Lucky</button></div>
<p style="font-size:12px">Google offered in: <a style="color:#1a0dab;text-decoration:underline">Dansk</a></p>
</section><footer style="background:#f2f2f2;border-top:1px solid #dadce0;display:flex;justify-content:space-between;padding:16px 24px;font-size:13px;color:#70757a"><span>About</span><span>Privacy</span><span>Settings</span></footer></main>`;

test("Google-style HTML imports as a compact editable layout with real inline type and effects", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async (html) => {
    const htmlPath = "/src/lib/mcp/html.ts",
      docPath = "/src/lib/canvas-document.ts",
      exportPath = "/src/components/canvas/canvas-export.tsx";
    const { importHtml } = await import(/* @vite-ignore */ htmlPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportPath);
    const nodes = await importHtml(html, { x: 50, y: 60, width: 960, height: 600 });
    const doc = new CanvasDocument(nodes);
    const png = await exportCanvasPng(doc.getFrames(), doc.getChildren());
    const logo = nodes.find((node: { name: string }) => node.name === "Google");
    const letters = doc.getChildren(logo.id).map((id: string) => doc.getFrame(id));
    const input = nodes.find(
      (node: { kind: string; text: string }) =>
        node.kind === "text" && node.text === "Search Google or type a URL",
    );
    const search = nodes.find((node: { name: string }) => node.name === "Search");
    return {
      root: nodes[0],
      count: nodes.length,
      letters,
      search,
      input,
      pngBytes: png.size,
      blankNames: nodes.filter((node: { name: string }) => node.name === "div").length,
      underline: nodes.find((node: { text: string }) => node.text === "Dansk"),
      footerBorder: nodes.find((node: { name: string }) => node.name === "Top border"),
    };
  }, google);
  expect(result.root).toMatchObject({ name: "Google Home", x: 50, y: 60, width: 960, height: 600 });
  expect(result.count).toBeLessThan(40);
  expect(result.blankNames).toBe(0);
  expect(result.letters.map((node: { text: string }) => node.text).join("")).toBe("Google");
  expect(result.letters.every((node: { kind: string }) => node.kind === "text")).toBe(true);
  expect(new Set(result.letters.map((node: { color: string }) => node.color)).size).toBe(4);
  expect(result.search).toMatchObject({
    width: 560,
    height: 46,
    borderWidth: 1,
    cornerRadius: 999,
  });
  expect(result.search.shadows).toHaveLength(1);
  expect(result.input.fontFamily).toBe("Arial");
  expect(result.input.y).toBeGreaterThan(result.search.y + 5);
  expect(result.input.y + result.input.height).toBeLessThan(
    result.search.y + result.search.height - 5,
  );
  expect(result.underline).toMatchObject({ kind: "text", textDecoration: "underline" });
  expect(result.footerBorder.height).toBe(1);
  expect(result.pngBytes).toBeGreaterThan(10000);
});

test("validateOnly reports layers without changing document or undo history", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/src/lib/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const document = new CanvasDocument([
      { id: "frame", name: "Test", x: 0, y: 0, width: 800, height: 600 },
    ]);
    const before = document.getSnapshot().revision;
    const response = await editorTool({ document, prepare: () => {} }, "write_html", {
      parentId: "frame",
      validateOnly: true,
      html: '<p style="font-size:24px">Preview only</p>',
    });
    return {
      result: JSON.parse(response.content[0].text),
      count: document.getIds().length,
      before,
      after: document.getSnapshot().revision,
    };
  });
  expect(result.result).toMatchObject({
    applied: false,
    nodeIds: [],
    summary: { layers: 1, textLayers: 1 },
  });
  expect(result.count).toBe(1);
  expect(result.after).toBe(result.before);
});

test("line breaks and side borders survive import without disconnected layers", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const path = "/src/lib/mcp/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);
    const lines = await importHtml("<p>Hello<br>world</p>", { x: 0, y: 0, width: 200 });
    const divider = await importHtml(
      '<div style="width:200px;height:40px;opacity:.3;border-bottom:1px solid #ddd"></div>',
      { x: 0, y: 0, width: 200 },
    );
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
    const image = await importHtml(
      `<img src="${png}" style="width:80px;height:80px;border-radius:20px;border:1px solid #ddd">`,
      { x: 0, y: 0, width: 200 },
    );
    return {
      text: lines[0].text,
      divider,
      image: image.find((node: { kind: string }) => node.kind === "image"),
    };
  });
  expect(result.text).toBe("Hello\nworld");
  expect(result.divider[0].opacity).toBe(0.3);
  expect(
    result.divider.find((node: { name: string }) => node.name === "Bottom border").parentId,
  ).toBe(result.divider[0].id);
  expect(result.image).toMatchObject({ x: 1, y: 1, width: 78, height: 78, cornerRadius: 19 });
});
