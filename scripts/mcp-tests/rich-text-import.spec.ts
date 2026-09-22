import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/__rich_text_import", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("/__rich_text_import");
});

test("inline formatting remains one editable text layer with safe links and matching wrapping", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const htmlPath = "/packages/html/src/html.ts";
    const canvasPath = "/packages/canvas/src/index.ts";
    const { importHtml } = await import(/* @vite-ignore */ htmlPath);

    const { CanvasDocument, appendCanvasText, fontFamilyCss } = await import(
      /* @vite-ignore */ canvasPath
    );

    const markup =
      '<p style="font:16px/1.25 Arial;width:240px;color:#121212">  Hello <strong>brave <em>new</em></strong> world. <a href="https://example.com/design" style="color:#2255cc;text-decoration:underline">Read more</a> 👋 and keep every word together while this paragraph wraps.</p>';

    const nodes = await importHtml(markup, { x: 0, y: 0, width: 240 });
    const doc = new CanvasDocument(nodes);
    const frame = doc.getFrames()[0];
    const source = document.createElement("div");
    source.innerHTML = markup;
    source.querySelector("p")!.style.margin = "0";
    document.body.append(source);
    const rendered = document.createElement("div");
    Object.assign(rendered.style, {
      width: `${frame.width}px`,
      fontFamily: fontFamilyCss(frame.fontFamily),
      fontSize: `${frame.fontSize}px`,
      fontWeight: frame.fontWeight,
      lineHeight: frame.lineHeight,
      whiteSpace: "pre-wrap",
      overflowWrap: "break-word",
      color: frame.color,
      marginTop: "40px",
    });
    appendCanvasText(rendered, frame);
    document.body.append(rendered);

    const heightDelta = Math.abs(
      rendered.getBoundingClientRect().height - source.getBoundingClientRect().height,
    );

    return { nodes: doc.getFrames(), heightDelta };
  });

  expect(result.nodes).toHaveLength(1);
  const node = result.nodes[0];
  expect(node.text).toBe(
    "Hello brave new world. Read more 👋 and keep every word together while this paragraph wraps.",
  );
  expect(node.textRuns).toContainEqual({ start: 6, end: 12, fontWeight: 700 });
  expect(node.textRuns).toContainEqual({
    start: 12,
    end: 15,
    fontWeight: 700,
    fontStyle: "italic",
  });
  expect(node.textRuns).toContainEqual({
    start: 23,
    end: 32,
    color: "#2255ccff",
    textDecoration: "underline",
    href: "https://example.com/design",
  });
  expect(result.heightDelta).toBeLessThanOrEqual(1);
  await test.info().attach("original-and-editable-rich-text", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("inline whitespace, line breaks, and safe link metadata survive import", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const path = "/packages/html/src/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);

    const normal = await importHtml(
      "<p>  Hello <strong> brave \n </strong> world<br><em>Again</em> </p>",
      { x: 0, y: 0, width: 300 },
    );

    const pre = await importHtml(
      '<p style="white-space:pre-wrap"> A <strong> B\n C </strong> D </p>',
      { x: 0, y: 0, width: 300 },
    );

    const unsafe = await importHtml(
      '<p><a href="javascript:alert(1)">No script</a> <a href="mailto:hello@example.com">Email</a></p>',
      { x: 0, y: 0, width: 300 },
    );

    const capitalized = await importHtml(
      '<p style="text-transform:capitalize">he<strong>llo</strong> wo<em>rld</em></p>',
      { x: 0, y: 0, width: 300 },
    );

    return { normal, pre, unsafe, capitalized };
  });

  expect(result.normal).toHaveLength(1);
  expect(result.normal[0].text).toBe("Hello brave world\nAgain");
  expect(result.pre).toHaveLength(1);
  expect(result.pre[0].text).toBe(" A  B\n C  D ");
  expect(result.unsafe).toHaveLength(1);
  expect(result.unsafe[0].textRuns).toEqual([
    { start: 10, end: 15, href: "mailto:hello@example.com" },
  ]);
  expect(result.capitalized[0].text).toBe("Hello World");
});

test("positioned and independently decorated inline children retain measured layout layers", async ({
  page,
}) => {
  const counts = await page.evaluate(async () => {
    const path = "/packages/html/src/html.ts";
    const { importHtml } = await import(/* @vite-ignore */ path);

    const positioned = await importHtml(
      '<p>Normal <span style="position:relative;left:20px">shifted</span></p>',
      { x: 0, y: 0, width: 300 },
    );

    const decorated = await importHtml(
      '<p>Normal <span style="background:#ffff00">highlight</span></p>',
      { x: 0, y: 0, width: 300 },
    );

    const flex = await importHtml(
      '<div style="display:flex;gap:20px"><span>Left</span><strong>Right</strong></div>',
      { x: 0, y: 0, width: 300 },
    );

    return [positioned, decorated, flex].map(
      (nodes: { kind: string }[]) => nodes.filter((node) => node.kind === "text").length,
    );
  });

  expect(counts).toEqual([2, 2, 2]);
});
