import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountSnapshotFixture();
    Reflect.set(window, "layerExpansionFixture", fixture);
    const { controls } = fixture;
    const frame = { name: "Frame", x: 300, y: 100, width: 400, height: 300 };
    controls.document.replaceAll([
      { ...frame, id: "first", name: "First page" },
      { ...frame, id: "section", name: "Section", parentId: "first" },
      {
        ...frame,
        id: "leaf",
        name: "Leaf",
        parentId: "section",
        kind: "rectangle",
        fill: "#ffffff",
      },
      { ...frame, id: "second", name: "Second page", x: 800 },
      { ...frame, id: "second-section", name: "Second section", parentId: "second", x: 800 },
      {
        ...frame,
        id: "second-leaf",
        name: "Second leaf",
        parentId: "second-section",
        x: 800,
        kind: "rectangle",
        fill: "#ffffff",
      },
    ]);
    controls.setPanelsOpen(true);
  });

  return page.getByRole("complementary", { name: "Design sidebar" });
}

test("new trees start collapsed and MCP edits preserve collapsed branches across sidebar remounts", async ({
  page,
}) => {
  const sidebar = await mount(page);
  await expect(sidebar.getByRole("treeitem")).toHaveCount(2);
  const first = sidebar.getByRole("treeitem", { name: "First page", exact: true });
  const second = sidebar.getByRole("treeitem", { name: "Second page", exact: true });
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await first.getByRole("button", { name: "Expand First page" }).click();
  const section = sidebar.getByRole("treeitem", { name: "Section", exact: true });
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("treeitem", { name: "Leaf", exact: true })).toHaveCount(0);
  await section.getByRole("button", { name: "Expand Section" }).click();
  await sidebar.getByRole("treeitem", { name: "Leaf", exact: true }).click();
  await first.getByRole("button", { name: "Collapse First page" }).click();

  await page.evaluate(async () => {
    const path = "/src/lib/mcp/editor.ts";
    const { editorTool } = await import(/* @vite-ignore */ path);
    const { controls } = Reflect.get(window, "layerExpansionFixture");
    await editorTool(controls, "update_node", { nodeId: "first", properties: { fill: "#abcdef" } });
    await editorTool(controls, "write_html", {
      parentId: "first",
      html: '<section data-name="New section" style="width:180px;height:120px"><div data-name="New child" style="width:80px;height:60px;background:#abcdef"></div></section>',
    });
    await editorTool(controls, "write_html", {
      html: '<section data-name="Imported page" style="width:180px;height:120px"><div data-name="Imported child" style="width:80px;height:60px;background:#abcdef"></div></section>',
    });
  });
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  const imported = sidebar.getByRole("treeitem", { name: "Imported page", exact: true });
  await expect(imported).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.getByRole("treeitem")).toHaveCount(3);
  await page.evaluate(() => Reflect.get(window, "layerExpansionFixture").controls.document.undo());
  await expect(sidebar.getByRole("treeitem")).toHaveCount(2);
  await page.evaluate(() => Reflect.get(window, "layerExpansionFixture").controls.document.redo());
  await expect(sidebar.getByRole("treeitem")).toHaveCount(3);
  await expect(imported).toHaveAttribute("aria-expanded", "false");

  await second.getByRole("button", { name: "Expand Second page" }).click();
  await sidebar.getByRole("button", { name: "Hide layers" }).click();
  await page.getByRole("button", { name: "Show layers" }).click();
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(imported).toHaveAttribute("aria-expanded", "false");
  await expect(
    sidebar.getByRole("treeitem", { name: "Second section", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
});

test("selection reveals only its new ancestor path and keyboard expansion stays explicit", async ({
  page,
}) => {
  const sidebar = await mount(page);
  const first = sidebar.getByRole("treeitem", { name: "First page", exact: true });
  const second = sidebar.getByRole("treeitem", { name: "Second page", exact: true });
  await page.evaluate(() => Reflect.get(window, "layerExpansionFixture").controls.select("leaf"));
  await expect(sidebar.getByRole("treeitem", { name: "Leaf", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await first.getByRole("button", { name: "Collapse First page" }).click();
  await second.click({ modifiers: ["Meta"] });
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  await second.press("ArrowRight");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await second.press("ArrowRight");
  const section = sidebar.getByRole("treeitem", { name: "Second section", exact: true });
  await expect(section).toBeFocused();
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await section.press("ArrowRight");
  await expect(section).toHaveAttribute("aria-expanded", "true");
  await section.press("ArrowRight");
  const leaf = sidebar.getByRole("treeitem", { name: "Second leaf", exact: true });
  await expect(leaf).toBeFocused();
  await leaf.press("Enter");
  await expect(leaf).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await leaf.press("ArrowLeft");
  await expect(section).toBeFocused();
  await section.press("ArrowLeft");
  await expect(section).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
});
