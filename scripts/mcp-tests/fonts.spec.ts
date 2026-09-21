import { expect, test } from "@playwright/test";

test("Google fonts load before HTML measurement and PNG export", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const fontModule = "/packages/canvas/src/canvas-fonts.ts";
    const htmlModule = "/packages/html/src/html.ts";
    const exportModule = "/src/components/canvas/canvas-export.tsx";
    const { ensureCanvasFonts, listCanvasFonts } = await import(/* @vite-ignore */ fontModule);
    const { importHtml } = await import(/* @vite-ignore */ htmlModule);
    const { exportCanvasPng } = await import(/* @vite-ignore */ exportModule);

    const nodes = await importHtml(
      '<div style="width:400px;height:180px;background:white"><p style="font-family:Space Grotesk;font-weight:300;font-size:32px">Loaded type Æøå</p></div>',
      { x: 0, y: 0, width: 400 },
    );

    await ensureCanvasFonts(nodes);
    const text = nodes.find((node: { kind: string }) => node.kind === "text");
    const png = await exportCanvasPng(nodes, [nodes[0].id]);

    return {
      family: text.fontFamily,
      weight: text.fontWeight,
      loaded: document.fonts.check('300 32px "Space Grotesk"', "Loaded type Æøå"),
      faces: [...document.fonts].filter(
        (font) => font.family.includes("Space Grotesk") && font.status === "loaded",
      ).length,
      pngSize: png.size,
      catalog: await listCanvasFonts(),
    };
  });

  expect(result.family).toBe("Space Grotesk");
  expect(result.weight).toBe(300);
  expect(result.loaded).toBe(true);
  expect(result.faces).toBeGreaterThan(0);
  expect(result.pngSize).toBeGreaterThan(1000);
  expect(result.catalog).toContain("Inter");
});

test("missing Google font reports a useful error and can retry", async ({ page }) => {
  let attempts = 0;
  await page.route("https://fonts.googleapis.com/**", (route) => {
    attempts++;

    return route.fulfill({ status: 400, body: "Missing font" });
  });
  await page.goto("/");

  const errors = await page.evaluate(async () => {
    const module = "/packages/canvas/src/canvas-fonts.ts";
    const { ensureCanvasFont } = await import(/* @vite-ignore */ module);
    const failures: string[] = [];

    for (let i = 0; i < 2; i++) {
      try {
        // eslint-disable-next-line no-await-in-loop -- Verify a retry after the previous failure.
        await ensureCanvasFont({ fontFamily: "Missing Example Font" });
      } catch (error) {
        failures.push(String(error));
      }
    }

    return failures;
  });

  expect(attempts).toBe(2);
  expect(errors).toHaveLength(2);
  expect(errors[0]).toContain("not available locally or on Google Fonts");
});

test("desktop catalog uses installed faces without fetching Google", async ({ page }) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    Object.defineProperty(window, "isTauri", { configurable: true, value: true });
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {
        invoke: async () => [
          { family: "Local Test Family", postscriptName: "ArialMT", weight: 400, style: "normal" },
        ],
      },
    });

    try {
      const module = "/packages/canvas/src/canvas-fonts.ts";
      const { ensureCanvasFont, listCanvasFonts } = await import(/* @vite-ignore */ module);
      await ensureCanvasFont({ fontFamily: "Local Test Family", text: "Local text" });

      return {
        catalog: await listCanvasFonts(),
        loaded: [...document.fonts].some(
          (font) => font.family.includes("Local Test Family") && font.status === "loaded",
        ),
      };
    } finally {
      Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
      Reflect.deleteProperty(window, "isTauri");
    }
  });

  expect(result.catalog).toContain("Local Test Family");
  expect(result.loaded).toBe(true);
});
