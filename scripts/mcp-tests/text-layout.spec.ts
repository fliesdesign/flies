import { expect, test, type Page } from "@playwright/test";

async function compareTextLayout(page: Page, source: string) {
  await page.goto("/");

  return page.evaluate(async (html) => {
    const htmlPath = "/packages/html/src/html.ts";
    const fixturePath = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const { importHtmlFragment, sanitizeHtml } = await import(/* @vite-ignore */ htmlPath);
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ fixturePath);
    const expected: { x: number; y: number; width: number; height: number }[] = [];

    const glyphRects = (text: Node) => {
      const rects: typeof expected = [];
      const range = text.ownerDocument!.createRange();
      let offset = 0;

      for (const glyph of text.textContent ?? "") {
        if (!/\s/.test(glyph)) {
          range.setStart(text, offset);
          range.setEnd(text, offset + glyph.length);
          const rect = range.getBoundingClientRect();
          if (rect.width)
            rects.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
        }

        offset += glyph.length;
      }

      return rects;
    };

    const nodes = await importHtmlFragment(sanitizeHtml(html), {
      x: 100,
      y: 50,
      width: 700,
      prepare: async (layout: HTMLElement) => {
        await layout.ownerDocument.fonts.ready;
        const origin = layout.getBoundingClientRect();
        const walker = layout.ownerDocument.createTreeWalker(layout, NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();

        while (text) {
          if (text.textContent?.trim()) {
            for (const rect of glyphRects(text)) {
              if (rect.width)
                expected.push({
                  x: 100 + rect.x - origin.x,
                  y: 50 + rect.y - origin.y,
                  width: rect.width,
                  height: rect.height,
                });
            }
          }

          text = walker.nextNode();
        }
      },
    });

    const { controls } = await mountSnapshotFixture();
    controls.document.addMany(nodes);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const actual: typeof expected = [];

    for (const node of nodes) {
      if (node.kind !== "text") continue;
      const element = document.querySelector(`[data-frame-id="${node.id}"] .canvas-text-content`)!;

      for (const rect of glyphRects(element.firstChild!)) {
        if (rect.width)
          actual.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }

    return { expected, actual, nodes };
  }, source);
}

function expectMatchingGlyphBounds(result: Awaited<ReturnType<typeof compareTextLayout>>) {
  expect(result.actual).toHaveLength(result.expected.length);

  for (let i = 0; i < result.expected.length; i++) {
    for (const axis of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(result.actual[i][axis] - result.expected[i][axis]),
        `run ${i} ${axis}`,
      ).toBeLessThanOrEqual(0.02);
  }
}

test("normal leading preserves heading baselines and centers normal, flex and grid button labels", async ({
  page,
}) => {
  const result = await compareTextLayout(
    page,
    '<main style="width:700px;height:420px;background:white;color:black;font-family:Arial">' +
      '<h2 data-name="Heading" style="font-size:32px;line-height:normal">Typography gyp ÅÉ</h2>' +
      '<button data-name="Normal button" style="width:220px;height:64px;background:#eee;font-size:20px;line-height:normal">Continue gyp</button>' +
      '<button data-name="Flex button" style="display:flex;align-items:center;justify-content:center;width:220px;height:64px;background:#eee;font-size:20px;line-height:normal">Continue gyp</button>' +
      '<button data-name="Grid button" style="display:grid;place-items:center;width:220px;height:64px;background:#eee;font-size:20px;line-height:normal"><span>Continue gyp</span></button>' +
      "</main>",
  );

  expectMatchingGlyphBounds(result);
  const heading = result.nodes.find((node: { name: string }) => node.name === "Heading");
  expect(heading.fontSize * heading.lineHeight).toBe(heading.height);

  for (const name of ["Normal button", "Flex button", "Grid button"]) {
    const button = result.nodes.find((node: { name: string }) => node.name === name);
    expect(button).toMatchObject({ width: 220, height: 64 });
  }

  await page.screenshot({ path: "/tmp/flies-text-layout-centered.png" });
});

test("wrapped button labels keep every line and explicit alignment with tight or spaced typography", async ({
  page,
}) => {
  const result = await compareTextLayout(
    page,
    '<main style="width:700px;height:560px;background:white;color:black;font-family:Arial">' +
      '<button data-name="Wrapped button" style="width:130px;height:110px;background:#eee;font-size:20px;line-height:normal">Continue to account settings</button>' +
      '<button style="display:flex;justify-content:flex-start;align-items:flex-start;width:380px;height:70px;padding:11px 23px;background:#eee;font-size:24px;line-height:1.15;letter-spacing:-1.2px">Left aligned label</button>' +
      '<button style="display:grid;place-items:end;width:380px;height:80px;padding:7px 19px;background:#eee;font-size:18px;line-height:1.6;letter-spacing:1.5px"><span>Bottom right label</span></button>' +
      '<p style="font-size:22px;line-height:normal;width:160px">Several lines of normal text gyp ÅÉ</p>' +
      '<div style="display:flex;font-size:20px;line-height:1.25"><span>&nbsp;Indented&nbsp;</span><strong>Bold</strong></div>' +
      "</main>",
  );

  expectMatchingGlyphBounds(result);
  expect(result.nodes.some((node: { text?: string }) => node.text === "\u00a0Indented\u00a0")).toBe(
    true,
  );
  const button = result.nodes.find((node: { name: string }) => node.name === "Wrapped button");

  const lines = result.nodes.filter(
    (node: { kind: string; parentId: string }) =>
      node.kind === "text" && node.parentId === button.id,
  );

  expect(lines.length).toBeGreaterThan(1);

  for (const line of lines) {
    expect(line.y).toBeGreaterThanOrEqual(button.y);
    expect(line.y + line.height).toBeLessThanOrEqual(button.y + button.height);
  }
});

test("authored line heights and clipping remain unchanged", async ({ page }) => {
  const result = await compareTextLayout(
    page,
    '<main style="width:700px;height:300px;background:white;color:black;font-family:Arial">' +
      '<div data-name="Clipped copy" style="width:170px;height:40px;overflow:hidden;background:#eee"><p style="font-size:20px;line-height:24px">Copy intentionally clipped by the frame height.</p></div>' +
      '<button data-name="Tight button" style="display:flex;align-items:center;justify-content:center;width:220px;height:64px;font-size:30px;line-height:24px;background:#eee">ÅÉ gyp</button>' +
      "</main>",
  );

  expectMatchingGlyphBounds(result);
  const clip = result.nodes.find((node: { name: string }) => node.name === "Clipped copy");
  expect(clip).toMatchObject({ height: 40, clipContent: true });

  const text = result.nodes.find(
    (node: { kind: string; parentId: string }) => node.kind === "text" && node.parentId === clip.id,
  );

  expect(text.lineHeight).toBe(1.2);
  expect(text.height).toBeGreaterThan(40);
  const tight = result.nodes.find((node: { text: string }) => node.text === "ÅÉ gyp");
  expect(tight).toMatchObject({ fontSize: 30, lineHeight: 0.8, height: 24 });
});
