import { expect, test } from "@playwright/test";

test("editable SVG conversion preserves viewBox alignment and uniform stroke transforms", async ({
  page,
}) => {
  await page.route("**/__vector_conversion", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__vector_conversion");

  const result = await page.evaluate(async () => {
    const path = "/packages/canvas/src/canvas-vector.ts";
    const { readEditableCanvasSvg, canvasVectorSource } = await import(/* @vite-ignore */ path);

    const source =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="10 20 100 100"><rect x="20" y="30" width="80" height="80" fill="#ff0000"/></svg>';

    const vector = readEditableCanvasSvg(source);

    // oxlint-disable-next-line unicorn/consistent-function-scoping -- The browser evaluation cannot close over Node helpers.
    const pixels = async (src: string) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 200;
      canvas.height = 100;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0, 200, 100);

      return ctx.getImageData(0, 0, 200, 100).data;
    };

    const original = await pixels(`data:image/svg+xml;base64,${btoa(source)}`);
    const editable = await pixels(canvasVectorSource(vector));

    const stroke = readEditableCanvasSvg(
      '<svg width="100" height="100" viewBox="0 0 100 100"><g transform="translate(10 5) scale(2)"><path d="M0 0 L20 20" fill="none" stroke="#000000" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></g></svg>',
    );

    const rejected = [
      '<svg width="100" height="100"><path d="M0 0 L20 20" fill="none" stroke="#000" stroke-linecap="square"/></svg>',
      '<svg width="100" height="100"><path transform="scale(2 1)" d="M0 0 L20 20" fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      '<svg width="100" height="100"><rect width="30" height="30" fill="#000" stroke="#fff" stroke-dasharray="2 2"/></svg>',
    ].map((svg) => {
      try {
        readEditableCanvasSvg(svg);

        return false;
      } catch {
        return true;
      }
    });

    return {
      width: vector.viewWidth,
      height: vector.viewHeight,
      first: vector.contours[0].anchors[0],
      pixelsChanged: original.reduce(
        (count, value, index) => count + Number(value !== editable[index]),
        0,
      ),
      stroke,
      rejected,
    };
  });

  expect(result).toMatchObject({
    width: 200,
    height: 100,
    first: { x: 60, y: 10 },
    pixelsChanged: 0,
  });
  expect(result.stroke.strokeWidth).toBe(6);
  expect(result.stroke.contours[0].anchors).toEqual([
    { x: 10, y: 5 },
    { x: 50, y: 45 },
  ]);
  expect(result.rejected).toEqual([true, true, true]);
});
