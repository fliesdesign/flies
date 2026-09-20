import { expect, test, type Locator, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/gpu-tests/gpu-harness.tsx";
    const { mountGpuFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountGpuFixture();
    Reflect.set(window, "themeFixture", fixture);
    fixture.controls.setPanelsOpen(true);
    fixture.controls.select("red");
  });
}

async function addToken(page: Page, sidebar: Locator, type: string) {
  await sidebar.getByRole("button", { name: "Add token" }).click();
  const item = page.getByRole("menuitem", { name: type, exact: true });
  await expect(item).toBeVisible();
  await item.evaluate((node) => (node as HTMLElement).click());
}

test("left Design/Theme tabs expose editable tokens in color, font and spacing pickers", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mount(page);
  const sidebar = page.getByRole("complementary", { name: "Design sidebar" });
  const properties = page.getByRole("complementary", { name: "Properties panel" });
  expect((await sidebar.boundingBox())!.x).toBe(0);
  await expect(sidebar.getByRole("tab", { name: "Design", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(sidebar.getByRole("treeitem", { name: "Red", exact: true })).toBeVisible();
  await expect(properties.getByRole("tab")).toHaveCount(0);
  await sidebar.getByRole("tab", { name: "Theme", exact: true }).click();
  await expect(sidebar.getByRole("tree", { name: "Layers" })).toBeHidden();
  await expect(sidebar.getByRole("button", { name: "Use starter theme" })).toBeVisible();
  await sidebar.getByRole("button", { name: "Add token" }).click();
  await Promise.all(
    [
      "Color",
      "Radius",
      "Spacing",
      "Container",
      "Breakpoint",
      "Font family",
      "Font weight",
      "Font size",
      "Line height",
      "Letter spacing",
    ].map((type) => expect(page.getByRole("menuitem", { name: type, exact: true })).toBeVisible()),
  );
  await page.keyboard.press("Escape");
  await addToken(page, sidebar, "Color");
  await sidebar.getByLabel("Token name color-1", { exact: true }).fill("Brand");
  await sidebar.getByLabel("Token name color-1", { exact: true }).press("Enter");
  await sidebar.getByLabel("Token value color-1", { exact: true }).fill("#123456");
  await sidebar.getByLabel("Token value color-1", { exact: true }).press("Enter");
  await properties.getByRole("button", { name: "Fill color picker" }).click();
  await page
    .getByRole("combobox", { name: "Fill color token", exact: true })
    .selectOption("color-1");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("red").fill,
      ),
    )
    .toBe("#123456");
  await sidebar.getByLabel("Token value color-1", { exact: true }).fill("#654321");
  await sidebar.getByLabel("Token value color-1", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("red").fill,
      ),
    )
    .toBe("#654321");

  await addToken(page, sidebar, "Font family");
  await sidebar.getByLabel("Token value font-1", { exact: true }).fill("Georgia");
  await sidebar.getByLabel("Token value font-1", { exact: true }).press("Enter");
  await page.evaluate(() => Reflect.get(window, "themeFixture").controls.select("text"));
  await properties
    .getByRole("combobox", { name: "Font family token", exact: true })
    .selectOption("font-1");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("text").fontFamily,
      ),
    )
    .toBe("Georgia");
  await sidebar.getByLabel("Token value font-1", { exact: true }).fill("Arial");
  await sidebar.getByLabel("Token value font-1", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("text").fontFamily,
      ),
    )
    .toBe("Arial");

  await addToken(page, sidebar, "Font weight");
  await sidebar.getByLabel("Token value weight-1", { exact: true }).fill("700");
  await sidebar.getByLabel("Token value weight-1", { exact: true }).press("Enter");
  await properties
    .getByRole("combobox", { name: "Font weight token", exact: true })
    .selectOption("weight-1");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("text").fontWeight,
      ),
    )
    .toBe(700);

  await addToken(page, sidebar, "Spacing");
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "themeFixture");
    const board = controls.document.getFrame("board");
    controls.document.update({
      ...board,
      layout: { direction: "column", gap: 8, padding: 8, align: "start", justify: "start" },
    });
    controls.select("board");
  });
  await properties
    .getByRole("combobox", { name: "Layout gap token", exact: true })
    .selectOption("spacing-1");
  await sidebar.getByLabel("Token value spacing-1", { exact: true }).fill("32");
  await sidebar.getByLabel("Token value spacing-1", { exact: true }).press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, "themeFixture").controls.document.getFrame("board").layout.gap,
      ),
    )
    .toBe(32);
  await testInfo.attach("left-theme-sidebar.png", {
    body: await page.screenshot({ path: testInfo.outputPath("left-theme-sidebar.png") }),
    contentType: "image/png",
  });

  const fieldsFit = await properties
    .locator(".canvas-property-field:has(.canvas-token-select)")
    .evaluateAll((fields) =>
      fields.every((field) => {
        const bounds = field.getBoundingClientRect();

        return [...field.querySelectorAll("input, select")].every((control) => {
          const child = control.getBoundingClientRect();

          return (
            child.height > 0 &&
            child.top >= bounds.top &&
            child.bottom <= bounds.bottom &&
            child.left >= bounds.left &&
            child.right <= bounds.right
          );
        });
      }),
    );

  expect(fieldsFit).toBe(true);

  await sidebar.getByRole("tab", { name: "Design", exact: true }).click();
  await expect(sidebar.getByRole("treeitem", { name: "Red", exact: true })).toBeVisible();
  await sidebar.getByRole("treeitem", { name: "Red", exact: true }).click();
  await expect(properties.getByRole("button", { name: "Fill color picker" })).toBeVisible();
  await sidebar.getByRole("tab", { name: "Theme", exact: true }).click();
  await sidebar.getByRole("button", { name: "Delete token Brand", exact: true }).click();

  const deleted = await page.evaluate(() =>
    Reflect.get(window, "themeFixture").controls.document.getFrame("red"),
  );

  expect(deleted.fill).toBe("#654321");
  expect(deleted.tokenBindings).toBeUndefined();
  expect(errors).toEqual([]);
});

test("MCP theme tools update linked layers, inherit CSS variables, persist and undo atomically", async ({
  page,
}) => {
  await page.goto("/");

  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts";
    const documentPath = "/packages/canvas/src/canvas-document.ts";
    const projectPath = "/packages/canvas/src/canvas-project.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ documentPath);
    const { packCanvasProject, unpackCanvasProject } = await import(/* @vite-ignore */ projectPath);

    const doc = new CanvasDocument([
      { id: "board", name: "Board", x: 0, y: 0, width: 600, height: 400 },
    ]);

    const controls = { document: doc, prepare() {}, select() {} };

    const tokens = [
      { id: "brand", name: "Brand", type: "color", value: "#123456" },
      { id: "body", name: "Body", type: "fontFamily", value: "Georgia" },
      { id: "space", name: "Space", type: "spacing", value: 24 },
      { id: "heading", name: "Heading", type: "fontSize", value: 48 },
    ];

    await editorTool(controls, "set_theme", { tokens });
    await editorTool(controls, "write_html", {
      parentId: "board",
      html: '<section style="width:600px;height:180px;padding:var(--space);color:var(--brand);font-family:var(--body)"><p>Token text</p></section>',
    });
    const text = doc.getFrames().find((node: { kind: string }) => node.kind === "text");
    const imported = { color: text.color, fontFamily: text.fontFamily, x: text.x };
    await editorTool(controls, "apply_tokens", {
      nodeIds: [text.id],
      bindings: { color: "brand", fontFamily: "body", fontSize: "heading" },
    });
    const bound = doc.getFrame(text.id);
    const before = JSON.stringify({ nodes: doc.getFrames(), theme: doc.getTheme() });
    let rejected = false;

    try {
      await editorTool(controls, "apply_tokens", {
        nodeIds: [text.id, "board"],
        bindings: { fontFamily: "body" },
      });
    } catch {
      rejected = true;
    }

    const unchanged = before === JSON.stringify({ nodes: doc.getFrames(), theme: doc.getTheme() });
    await editorTool(controls, "set_theme", { tokens: [{ ...tokens[0], value: "#fedcba" }] });
    const updated = doc.getFrame(text.id);
    const count = doc.getTheme().tokens.length;
    doc.undo();
    const undone = doc.getFrame(text.id);
    doc.redo();
    const info = JSON.parse((await editorTool(controls, "get_theme", {})).content[0].text);

    const project = unpackCanvasProject(
      packCanvasProject("Theme", doc.getFrames(), doc.getTheme()),
    );

    const reopened = new CanvasDocument(project.nodes, project.theme);
    await editorTool({ ...controls, document: reopened }, "set_theme", {
      tokens: [{ ...tokens[0], value: "#abcdef" }],
    });
    await editorTool(controls, "apply_tokens", { nodeIds: [text.id], bindings: { fill: null } });
    await editorTool(controls, "set_theme", { tokens: [{ ...tokens[0], value: "#ffffff" }] });

    return {
      imported,
      bound,
      rejected,
      unchanged,
      updated,
      undone,
      info,
      count,
      reopened: reopened.getFrame(text.id),
      detached: doc.getFrame(text.id),
    };
  });

  expect(result.imported).toEqual({ color: "#123456ff", fontFamily: "Georgia", x: 24 });
  expect(result.bound).toMatchObject({
    fontSize: 48,
    tokenBindings: { fill: "brand", fontFamily: "body", fontSize: "heading" },
  });
  expect(result.bound.height).toBeGreaterThan(48);
  expect(result.rejected).toBe(true);
  expect(result.unchanged).toBe(true);
  expect(result.count).toBe(4);
  expect(result.updated.color).toBe("#fedcba");
  expect(result.undone.color).toBe("#123456");
  expect(result.info.cssVariables).toContainEqual({ id: "brand", variable: "--brand", uses: 1 });
  expect(result.reopened.color).toBe("#abcdef");
  expect(result.detached.color).toBe("#fedcba");
  expect(result.detached.tokenBindings.fill).toBeUndefined();
});
