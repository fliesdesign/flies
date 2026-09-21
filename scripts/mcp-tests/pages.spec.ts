import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const { mountSnapshotFixture } = await import(/* @vite-ignore */ path);
    const fixture = await mountSnapshotFixture();
    Reflect.set(window, "pagesFixture", fixture);
    const { controls } = fixture;
    const frame = { name: "Frame", x: 300, y: 100, width: 400, height: 300 };

    controls.document.replaceAll([
      { id: "home", name: "Default", kind: "page", x: 0, y: 0, width: 0, height: 0 },
      { ...frame, id: "hero", name: "Hero", parentId: "home" },
      { ...frame, id: "card", name: "Card", parentId: "hero", kind: "rectangle", fill: "#ffffff" },
      { id: "drafts", name: "Drafts", kind: "page", x: 0, y: 0, width: 0, height: 0 },
      { ...frame, id: "sketch", name: "Sketch", parentId: "drafts", x: 900 },
    ]);

    controls.setPanelsOpen(true);
  });

  return page.getByRole("complementary", { name: "Design sidebar" });
}

const pageTabs = (sidebar: ReturnType<Page["getByRole"]>) =>
  sidebar.getByRole("tablist", { name: "Pages" }).getByRole("tab");

const frameOf = (page: Page, id: string) =>
  page.evaluate(
    (nodeId) => Reflect.get(window, "pagesFixture").controls.document.getFrame(nodeId),
    id,
  );

test("each page lists its own layers and switching swaps the canvas", async ({ page }) => {
  const sidebar = await mount(page);
  const pages = pageTabs(sidebar);
  await expect(pages).toHaveText(["Default", "Drafts"]);
  await expect(pages.nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("treeitem")).toHaveText(["Hero"]);

  await pages.nth(1).click();
  await expect(pages.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(sidebar.getByRole("treeitem")).toHaveText(["Sketch"]);
  // The page node itself is never a layer row.
  await expect(sidebar.getByRole("treeitem", { name: "Drafts" })).toHaveCount(0);
});

test("dragging a layer onto another page moves its subtree and keeps world coordinates", async ({
  page,
}) => {
  const sidebar = await mount(page);
  const layer = sidebar.getByRole("treeitem", { name: "Hero", exact: true });
  const drafts = pageTabs(sidebar).filter({ hasText: "Drafts" });
  const from = (await layer.boundingBox())!;
  const to = (await drafts.boundingBox())!;

  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  // Past the drag threshold first, so the press is not read as a click.
  await page.mouse.move(from.x + 60, from.y + from.height / 2 - 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(drafts).toHaveAttribute("data-drop-target", "true");
  await expect(sidebar.getByText("To Drafts")).toBeVisible();
  await page.mouse.up();

  await expect(sidebar.getByRole("treeitem")).toHaveCount(0);
  expect(await frameOf(page, "hero")).toMatchObject({ parentId: "drafts", x: 300, y: 100 });
  // Descendants travel with their root and keep their own parent.
  expect(await frameOf(page, "card")).toMatchObject({ parentId: "hero", x: 300, y: 100 });

  await drafts.click();
  await expect(sidebar.getByRole("treeitem")).toHaveText(["Hero", "Sketch"]);
});

test("a drag that ends on the page being edited falls back to the layer tree", async ({ page }) => {
  const sidebar = await mount(page);
  const layer = sidebar.getByRole("treeitem", { name: "Hero", exact: true });
  const current = pageTabs(sidebar).filter({ hasText: "Default" });
  const from = (await layer.boundingBox())!;
  const to = (await current.boundingBox())!;

  await page.mouse.move(from.x + 60, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2 - 20, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(current).not.toHaveAttribute("data-drop-target", "true");
  await page.mouse.up();

  expect(await frameOf(page, "hero")).toMatchObject({ parentId: "home" });
  await expect(sidebar.getByRole("treeitem")).toHaveText(["Hero"]);
});

test("adding and deleting pages keeps one canvas and its layers", async ({ page }) => {
  const sidebar = await mount(page);
  await sidebar.getByRole("button", { name: "Add page" }).click();
  await expect(pageTabs(sidebar)).toHaveText(["Default", "Drafts", "Page 1"]);
  await expect(pageTabs(sidebar).filter({ hasText: "Page 1" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // A new page starts empty; the other canvases are untouched.
  await expect(sidebar.getByRole("treeitem")).toHaveCount(0);
  await pageTabs(sidebar).filter({ hasText: "Default" }).click();
  await expect(sidebar.getByRole("treeitem")).toHaveText(["Hero"]);

  const removed = await page.evaluate(() => {
    const doc = Reflect.get(window, "pagesFixture").controls.document;
    Reflect.get(window, "pagesFixture").controls.removePage("drafts");

    return { pages: doc.getPageIds(), sketch: doc.getFrame("sketch") };
  });

  expect(removed.pages).toHaveLength(2);
  expect(removed.sketch).toBeUndefined();
});
