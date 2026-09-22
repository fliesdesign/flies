import { expect, test, type Page } from "@playwright/test";

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

async function mount(page: Page, firefly = false) {
  await page.goto("/");
  await page.evaluate(async (enabled) => {
    const harness = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const engine = "/@fs/Users/lassevestergaard/Dev/flies/packages/canvas/src/index.ts";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ harness);
    const fixture = await mountSnapshotFixture();
    Reflect.set(window, "richFixture", fixture);
    const { setCanvasInspection } = await import(/* @vite-ignore */ engine);
    setCanvasInspection(!enabled);
    fixture.controls.document.replaceAll([
      { id: "board", name: "Typography", x: 250, y: 100, width: 650, height: 400, fill: "#fff" },
      {
        id: "text",
        name: "Rich headline",
        kind: "text",
        parentId: "board",
        x: 310,
        y: 160,
        width: 460,
        height: 80,
        text: "Hello canvas",
        fontSize: 40,
        color: "#161616",
      },
    ]);
  }, firefly);
}

async function selectWord(page: Page) {
  await page.locator(".canvas-text-editor").evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 12);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

for (const backend of ["DOM", "Firefly"]) {
  test(`${backend} rich text formatting preserves selection, local undo, document undo and reopen`, async ({
    page,
  }, info) => {
    await mount(page, backend === "Firefly");
    const canvas = page.getByRole("application", { name: "Design canvas", exact: true });
    await canvas.dblclick({ position: { x: 410, y: 190 } });
    const editor = page.getByRole("textbox", { name: "Edit Rich headline" });
    await expect(editor).toBeVisible();
    await selectWord(page);
    await page.getByRole("button", { name: "Bold selection" }).click();
    await expect(editor.locator('span[style*="700"]')).toHaveText("canvas");
    await editor.press("ControlOrMeta+z");
    await expect(editor.locator('span[style*="700"]')).toHaveCount(0);
    await editor.press("ControlOrMeta+Shift+z");
    await expect(editor.locator('span[style*="700"]')).toHaveText("canvas");
    await page.getByRole("button", { name: "Link", exact: true }).click();
    await page.getByRole("textbox", { name: "Selection link" }).fill("https://flies.design");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await editor.press("ControlOrMeta+Enter");
    await expect(editor).toHaveCount(0);

    const runs = await page.evaluate(
      () => Reflect.get(window, "richFixture").controls.document.getFrame("text").textRuns,
    );

    expect(runs).toEqual([{ start: 6, end: 12, fontWeight: 700, href: "https://flies.design" }]);
    await page.evaluate(() => Reflect.get(window, "richFixture").controls.document.undo());
    expect(
      await page.evaluate(
        () => Reflect.get(window, "richFixture").controls.document.getFrame("text").textRuns,
      ),
    ).toBeUndefined();
    await page.evaluate(() => Reflect.get(window, "richFixture").controls.document.redo());
    await canvas.dblclick({ position: { x: 410, y: 190 } });
    await expect(editor.locator('span[style*="700"]')).toHaveText("canvas");
    await editor.press("Escape");
    await page.evaluate(() => Reflect.get(window, "richFixture").controls.setPanelsOpen(true));

    for (const zoom of [0.55, 1, 2]) {
      await page.evaluate((value) => {
        const camera = Reflect.get(window, "richFixture").controls.camera;
        camera.setViewport({ x: 250 - 250 * value, y: 80 - 100 * value, zoom: value });
        camera.flush();
      }, zoom);
      await page.screenshot({ path: info.outputPath(`rich-${backend}-${zoom}.png`) });
    }
  });
}

test("PNG and CSS exports include cropped images and alpha masks without mask-source artwork", async ({
  page,
}) => {
  await mount(page);

  const result = await page.evaluate(async () => {
    const engine = "/@fs/Users/lassevestergaard/Dev/flies/packages/canvas/src/index.ts";

    const pngPath = "/src/components/canvas/canvas-export.tsx",
      codePath = "/src/lib/canvas-code-export.ts";

    const { CanvasDocument } = await import(/* @vite-ignore */ engine);
    const { exportCanvasPng } = await import(/* @vite-ignore */ pngPath);
    const { exportCanvasCodeWithAssets } = await import(/* @vite-ignore */ codePath);
    const image = document.createElement("canvas");
    image.width = 100;
    image.height = 100;
    const ctx = image.getContext("2d")!;
    ctx.fillStyle = "red";
    ctx.fillRect(0, 0, 50, 100);
    ctx.fillStyle = "blue";
    ctx.fillRect(50, 0, 50, 100);

    const nodes = [
      {
        id: "photo",
        name: "Photo",
        kind: "image",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        src: image.toDataURL(),
        crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
        maskId: "mask",
      },
      {
        id: "mask",
        name: "Mask",
        kind: "rectangle",
        x: 0,
        y: 0,
        width: 50,
        height: 100,
        fill: "#ffffff",
      },
    ];

    const doc = new CanvasDocument(nodes);
    const blob = await exportCanvasPng(doc.getFrames(), ["photo"]);
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const context = canvas.getContext("2d")!;
    context.drawImage(bitmap, 0, 0);
    const code = await exportCanvasCodeWithAssets(nodes, ["photo"], "CSS");

    return {
      left: [...context.getImageData(25, 50, 1, 1).data],
      right: [...context.getImageData(75, 50, 1, 1).data],
      code,
    };
  });

  expect(result.left).toEqual([0, 0, 255, 255]);
  expect(result.right[3]).toBe(0);
  expect(result.code).toContain("mask-image:");
  expect(result.code).toContain("200%");
});

test("rich-text HTML export preserves exact whitespace, wrapping and link appearance", async ({
  page,
}) => {
  await mount(page);

  const result = await page.evaluate(async () => {
    const codePath = "/src/lib/canvas-code-export.ts";
    const { exportCanvasCode } = await import(/* @vite-ignore */ codePath);

    const nodes = [
      {
        id: "text",
        name: "Text",
        kind: "text",
        x: 0,
        y: 0,
        width: 400,
        height: 100,
        text: "Hello canvas\nA linked word",
        fontSize: 24,
        color: "#161616",
        textRuns: [
          { start: 6, end: 12, fontWeight: 700 },
          { start: 15, end: 21, href: "https://flies.design" },
        ],
      },
    ];

    const container = document.createElement("div");
    container.innerHTML = exportCanvasCode(nodes, ["text"], "CSS");
    document.body.append(container);
    const content = container.querySelector("span")!;
    const link = container.querySelector("a")!;

    const result = {
      text: content.textContent,
      color: getComputedStyle(link).color,
      decoration: getComputedStyle(link).textDecorationLine,
      height: content.scrollHeight,
    };

    container.remove();

    return result;
  });

  expect(result.text).toBe("Hello canvas\nA linked word");
  expect(result.color).toBe("rgb(22, 22, 22)");
  expect(result.decoration).toBe("none");
  expect(result.height).toBeLessThanOrEqual(100);
});
