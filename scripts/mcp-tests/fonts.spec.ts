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

test("Arial offers actual faces and Inter renders distinct light weights", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "fontFixture", fixture);
    fixture.controls.document.replaceAll([
      {
        id: "weight-text",
        name: "Weight sample",
        kind: "text",
        x: 350,
        y: 180,
        width: 500,
        height: 100,
        text: "Thin Light Regular",
        fontFamily: "Arial",
        fontWeight: 400,
        fontSize: 48,
        color: "#ffffff",
      },
    ]);
    fixture.controls.setPanelsOpen(true);
    fixture.controls.select("weight-text");
  });
  const weights = page.getByLabel("Font weight", { exact: true });
  await expect(weights.locator("option:not(:disabled)")).toHaveText(["Regular", "Bold"]);
  await expect(page.getByText(/For lighter weights, choose a font such as Inter/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("arial-weights.png") });
  await weights.selectOption("700");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, "fontFixture").controls.document.getFrame("weight-text").fontWeight,
      ),
    )
    .toBe(700);

  // Existing CSS/import weights are retained and explained, not silently rewritten.
  await page.evaluate(() =>
    Reflect.get(window, "fontFixture").controls.document.update({
      ...Reflect.get(window, "fontFixture").controls.document.getFrame("weight-text"),
      fontWeight: 300,
    }),
  );
  await expect(weights).toHaveValue("300");
  await expect(weights.locator('option[value="300"]')).toHaveAttribute("disabled", "");
  await expect(weights.locator('option[value="300"]')).toHaveText("Light (unavailable)");

  const family = page.getByRole("combobox", { name: "Font family", exact: true });
  await family.fill("Inter");
  await family.press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, "fontFixture").controls.document.getFrame("weight-text").fontFamily,
      ),
    )
    .toBe("Inter");
  await expect(weights.locator("option:not(:disabled)")).toHaveCount(9);
  await weights.selectOption("100");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          Reflect.get(window, "fontFixture").controls.document.getFrame("weight-text").fontWeight,
      ),
    )
    .toBe(100);
  await testInfo.attach("inter-thin.png", {
    body: await page.screenshot({ path: testInfo.outputPath("inter-thin.png") }),
    contentType: "image/png",
  });

  const ink = await page.evaluate(async () => {
    const module = "/packages/canvas/src/canvas-fonts.ts";
    const { ensureCanvasFont } = await import(/* @vite-ignore */ module);
    const values: number[] = [];

    for (const fontFamily of ["Arial", "Inter"]) {
      for (const fontWeight of [100, 300, 400]) {
        // eslint-disable-next-line no-await-in-loop -- Measure each loaded face.
        await ensureCanvasFont({ fontFamily, fontWeight });
        const canvas = document.createElement("canvas");
        canvas.width = 700;
        canvas.height = 100;
        const context = canvas.getContext("2d")!;
        context.font = `${fontWeight} 64px "${fontFamily}"`;
        context.fillText("Thin Light Regular", 0, 75);
        const pixels = context.getImageData(0, 0, 700, 100).data;
        let alpha = 0;
        for (let i = 3; i < pixels.length; i += 4) alpha += pixels[i];
        values.push(alpha);
      }
    }

    return values;
  });

  expect(ink[0]).toBe(ink[1]);
  expect(ink[1]).toBe(ink[2]);
  expect(ink[3]).toBeGreaterThan(0);
  expect(ink[3]).toBeLessThan(ink[4] * 0.8);
  expect(ink[4]).toBeLessThan(ink[5] * 0.9);
});
