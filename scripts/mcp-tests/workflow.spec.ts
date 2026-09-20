import { expect, test } from "@playwright/test";

test("saved CSS carries typography, colors and variables across incremental imports", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts";
    const documentPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);

    const scene = new CanvasDocument([
      { id: "board", name: "Board", x: 0, y: 0, width: 600, height: 800 },
    ]);

    const controls = { document: scene, prepare() {}, select() {} };
    await editorTool(controls, "set_styles", {
      nodeId: "board",
      css: ":root { --space:24px; font-family:Georgia; font-size:20px; color:#123456; } .section { padding:var(--space); }",
    });
    await editorTool(controls, "write_html", {
      parentId: "board",
      html: '<section data-name="One" class="section" style="width:600px;height:120px">First section</section>',
    });
    // A separate document simulates reopening the persisted file.
    const reopened = new CanvasDocument(JSON.parse(JSON.stringify(scene.getFrames())));
    const again = { ...controls, document: reopened };
    await editorTool(again, "write_html", {
      parentId: "board",
      y: 120,
      html: '<section data-name="Two" class="section" style="width:600px;height:120px"><p style="margin-left:var(--space)">Second section</p></section>',
    });
    const texts = reopened.getFrames().filter((node: { kind: string }) => node.kind === "text");
    await editorTool(again, "fit_node", { nodeId: "board", axis: "height", padding: 24 });
    const fitted = reopened.getFrame("board");
    await editorTool(again, "write_html", {
      targetId: "board",
      html: '<main data-name="Board" style="width:600px;height:264px"></main>',
    });

    return { texts, board: fitted, replacementStyles: reopened.getFrame("board").htmlStyles };
  });

  expect(result.texts).toHaveLength(2);
  for (const text of result.texts)
    expect(text).toMatchObject({ fontFamily: "Georgia", fontSize: 20, color: "#123456ff" });
  expect(result.texts[0].x).toBe(24);
  expect(result.texts[1].x).toBe(48);
  expect(result.board).toMatchObject({ height: 264, clipContent: true });
  expect(result.replacementStyles).toContain("--space:24px");
});

test("interactive preview supports hover, motion and scripts without editor or network access", async ({
  page,
}) => {
  const escapedRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("preview-test.invalid")) escapedRequests.push(request.url());
  });
  await page.goto("/");
  await page.evaluate(async () => {
    const module = "/src/lib/mcp/editor.ts";
    const docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ module);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const scene = new CanvasDocument([]);
    await editorTool({ document: scene, prepare() {} }, "preview_html", {
      width: 480,
      height: 320,
      html: `<style>@keyframes pulse{to{opacity:.4}}button{background:linear-gradient(red,blue);color:white;padding:20px}button:hover{color:rgb(0,255,0)}.motion{animation:pulse 1s infinite alternate}</style><button onclick="this.textContent='Clicked'">Try me</button><p class="motion">Animated</p><output id="isolation"></output><script>try{parent.document.body.dataset.escaped='yes';document.querySelector('output').textContent='escaped'}catch{document.querySelector('output').textContent='isolated'}fetch('https://preview-test.invalid/data').catch(()=>{})</script>`,
    });
  });
  const frame = page.frameLocator('iframe[title="Interactive HTML prototype"]');
  await expect(frame.locator("#isolation")).toHaveText("isolated");
  await expect(frame.locator("button")).toHaveCSS("background-image", /linear-gradient/);
  await frame.locator("button").hover();
  await expect(frame.locator("button")).toHaveCSS("color", "rgb(0, 255, 0)");
  await expect(frame.locator(".motion")).toHaveCSS("animation-name", "pulse");
  await frame.locator("button").click();
  await expect(frame.locator("button")).toHaveText("Clicked");
  expect(escapedRequests).toEqual([]);
  expect(await page.locator("body").getAttribute("data-escaped")).toBeNull();
  await page.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Interactive preview" })).toHaveCount(0);
});
