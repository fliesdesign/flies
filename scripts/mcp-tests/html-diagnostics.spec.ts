import { expect, test } from "@playwright/test";

test("HTML previews report short text and existing artboard clips without changing history", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts";
    const docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);

    const document = new CanvasDocument([
      { id: "artboard", name: "Mobile page", x: 100, y: 200, width: 200, height: 80 },
      {
        id: "original",
        parentId: "artboard",
        name: "Original section",
        x: 100,
        y: 200,
        width: 200,
        height: 80,
      },
    ]);

    const before = document.getSnapshot();
    const framesBefore = JSON.stringify(document.getFrames());
    const controls = { document, prepare: () => {} };

    const args = {
      parentId: "artboard",
      replace: true,
      y: 70,
      html: '<p data-name="Intro" style="width:180px;height:20px;font-size:16px;line-height:20px">This paragraph needs several lines to remain readable inside a narrow mobile layout.</p>',
    };

    const preview = JSON.parse(
      (await editorTool(controls, "write_html", { ...args, validateOnly: true })).content[0].text,
    );

    const afterPreview = document.getSnapshot();
    const framesAfterPreview = JSON.stringify(document.getFrames());
    const applied = JSON.parse((await editorTool(controls, "write_html", args)).content[0].text);
    const imported = applied.nodeIds.map((id: string) => document.getFrame(id));
    document.undo();

    return {
      preview,
      applied,
      imported,
      before,
      afterPreview,
      framesBefore,
      framesAfterPreview,
      framesAfterUndo: JSON.stringify(document.getFrames()),
    };
  });

  expect(result.preview.applied).toBe(false);
  expect(result.preview.nodeIds).toEqual([]);
  expect(result.preview.warnings.map((warning: { code: string }) => warning.code)).toEqual([
    "text_overflow",
    "clipped_text",
  ]);
  expect(result.preview.warnings[0]).toMatchObject({ nodeName: "Intro" });
  expect(result.preview.warnings[0].requiredHeight).toBeGreaterThan(20);
  expect(result.preview.warnings[1]).toMatchObject({ ancestorName: "Mobile page" });

  for (const warning of result.preview.warnings) {
    expect(warning).not.toHaveProperty("nodeId");
    expect(warning).not.toHaveProperty("ancestorId");
  }

  expect(result.afterPreview).toEqual(result.before);
  expect(result.framesAfterPreview).toBe(result.framesBefore);
  expect(result.framesAfterUndo).toBe(result.framesBefore);
  expect(result.applied.applied).toBe(true);
  expect(result.applied.warnings[0].nodeId).toBe(result.imported[0].id);
  expect(result.applied.warnings[1].ancestorId).toBe("artboard");
});

test("ordinary HTML typography does not produce clipping warnings", async ({ page }) => {
  await page.goto("/");

  const warnings = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts";
    const docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const document = new CanvasDocument();

    const response = await editorTool({ document, prepare: () => {} }, "write_html", {
      width: 400,
      html: '<section style="padding:24px"><h1 style="font-size:31px;line-height:1.2">A clear heading</h1><p style="font-size:16px;line-height:1.4">A short introduction that wraps naturally and retains all of its text.</p></section>',
    });

    return JSON.parse(response.content[0].text).warnings;
  });

  expect(warnings).toEqual([]);
});

test("isolated imports load native diagnostic fonts before committing", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts";
    const docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const canvas = new CanvasDocument();
    const controls = { document: canvas, prepare: () => {} };

    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async () =>
          ["Diagnostic Family", "Unavailable Diagnostic Family"].map((family) => ({
            family,
            postscriptName: "ArialMT",
            weight: 400,
            style: "normal",
          })),
      },
    });

    try {
      const applied = JSON.parse(
        (
          await editorTool(controls, "write_html", {
            width: 320,
            html: '<p class="w-full" style="font-family:Diagnostic Family;font-size:20px;line-height:1.4">Custom typography is measured with its actual native font.</p>',
          })
        ).content[0].text,
      );

      const loaded = [...document.fonts].some(
        (font) => font.family.includes("Diagnostic Family") && font.status === "loaded",
      );

      const before = canvas.getSnapshot();
      const framesBefore = JSON.stringify(canvas.getFrames());

      // The import iframe has its own FontFaceSet; only native diagnostic loading fails.
      Object.defineProperty(document.fonts, "load", {
        configurable: true,
        value: () => Promise.reject(new Error("Native font load failed")),
      });
      let failure = "";

      try {
        await editorTool(controls, "write_html", {
          width: 320,
          html: '<p class="w-full" style="font-family:Unavailable Diagnostic Family">Must not be committed</p>',
        });
      } catch (error) {
        failure = String(error);
      } finally {
        Reflect.deleteProperty(document.fonts, "load");
      }

      return {
        loaded,
        warnings: applied.warnings,
        failure,
        before,
        after: canvas.getSnapshot(),
        framesBefore,
        framesAfter: JSON.stringify(canvas.getFrames()),
      };
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      Reflect.deleteProperty(window, "isTauri");
    }
  });

  expect(result.loaded).toBe(true);
  expect(result.warnings).toEqual([]);
  expect(result.failure).toContain("Native font load failed");
  expect(result.after).toEqual(result.before);
  expect(result.framesAfter).toBe(result.framesBefore);
});
