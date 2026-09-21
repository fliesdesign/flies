import { expect, test } from "@playwright/test";

test("canvas dragging keeps the active page's layers visible before and after a sync reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "dragStabilityFixture", fixture);
    const { controls } = fixture;
    controls.document.replaceAll([
      { id: "home", name: "Default", kind: "page", x: 0, y: 0, width: 0, height: 0 },
      { id: "drafts", name: "Drafts", kind: "page", x: 0, y: 0, width: 0, height: 0 },
      {
        id: "moving",
        name: "Moving",
        kind: "rectangle",
        parentId: "drafts",
        x: 350,
        y: 150,
        width: 100,
        height: 100,
        fill: "#3b82f6",
      },
    ]);
    controls.document.setActivePage("drafts");
    controls.setPanelsOpen(true);
  });

  const sidebar = page.getByRole("complementary", { name: "Design sidebar" });
  const layer = sidebar.getByRole("treeitem", { name: "Moving", exact: true });
  await expect(layer).toBeVisible();
  const bounds = (await page.getByRole("button", { name: "Moving, 100 by 100" }).boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 100, start.y + 100, { steps: 10 });
  await expect(layer).toBeVisible();
  await page.mouse.up();

  const state = await page.evaluate(() => {
    const { document } = Reflect.get(window, "dragStabilityFixture").controls;

    return { node: document.getFrame("moving"), roots: document.getChildren() };
  });

  expect(state.node).toMatchObject({ parentId: "drafts", x: 450, y: 250 });
  expect(state.roots).toEqual(["moving"]);
  await expect(layer).toBeVisible();

  await page.evaluate(async () => {
    const { document } = Reflect.get(window, "dragStabilityFixture").controls;
    const path = "/src/lib/files.ts";
    const { withPages } = await import(/* @vite-ignore */ path);
    const saved = withPages({ id: "drag-test", nodes: document.getCommittedFrames() });
    document.replaceAll(saved.nodes, document.getTheme(), true);
  });
  await expect(layer).toBeVisible();
  await page.evaluate(() => Reflect.get(window, "dragStabilityFixture").controls.document.undo());
  await expect(layer).toBeVisible();
  expect(
    await page.evaluate(() =>
      Reflect.get(window, "dragStabilityFixture").controls.document.getFrame("moving"),
    ),
  ).toMatchObject({ parentId: "drafts", x: 350, y: 150 });
});
