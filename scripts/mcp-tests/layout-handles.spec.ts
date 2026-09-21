import { expect, test, type Locator, type Page } from "@playwright/test";

async function mount(
  page: Page,
  options: { rotation?: number; zoom?: number; row?: boolean } = {},
) {
  await page.goto("/");
  await page.evaluate(async ({ rotation = 0, zoom = 1, row = false }) => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "spacingFixture", fixture);
    const { controls } = fixture;
    controls.document.addMany([
      {
        id: "layout",
        name: "Empty state",
        x: 160,
        y: 100,
        width: 480,
        height: 400,
        fill: "#212121",
        rotation,
        layout: {
          direction: row ? "row" : "column",
          gap: 24,
          padding: 32,
          align: "center",
          justify: "start",
        },
      },
      {
        id: "icon",
        name: "Icon",
        parentId: "layout",
        kind: "rectangle",
        x: 0,
        y: 0,
        width: 80,
        height: 80,
        fill: "#313131",
        cornerRadius: 20,
      },
      {
        id: "title",
        name: "Title",
        parentId: "layout",
        kind: "text",
        x: 0,
        y: 0,
        width: row ? 100 : 360,
        height: 38,
        text: "No API keys found",
        fontSize: 28,
        color: "#ededed",
        textAlign: "center",
      },
      {
        id: "description",
        name: "Description",
        parentId: "layout",
        kind: "text",
        x: 0,
        y: 0,
        width: row ? 100 : 400,
        height: 30,
        text: "Try adjusting your search or filters.",
        fontSize: 22,
        color: "#afafaf",
        textAlign: "center",
      },
    ]);
    controls.select("layout");
    controls.camera.setViewport({ x: zoom === 2 ? -250 : 0, y: zoom === 2 ? -180 : 0, zoom });
    controls.camera.flush();
    Reflect.set(window, "spacingCommits", []);
    controls.document.subscribeChanges(() =>
      Reflect.get(window, "spacingCommits").push(controls.document.getCommittedFrames()),
    );
  }, options);
  await expect(page.locator('[data-layout-handle="padding-top"]')).toBeVisible();
}

async function frame(page: Page, id = "layout") {
  return page.evaluate(
    (key) => Reflect.get(window, "spacingFixture").controls.document.getFrame(key),
    id,
  );
}

async function startDrag(page: Page, handle: Locator) {
  const box = (await handle.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  return start;
}

test("padding previews smoothly, commits once, persists and supports undo/cancel", async ({
  page,
}) => {
  await mount(page);
  const handle = page.locator('[data-layout-handle="padding-top"]');
  await handle.hover();
  await expect(page.locator(".canvas-layout-value")).toHaveText("32");
  await expect(page.locator("[data-layout-child]")).toHaveCount(3);
  const start = await startDrag(page, handle);
  await page.mouse.move(start.x, start.y + 20, { steps: 8 });
  await expect.poll(async () => (await frame(page)).layout.padding).toBe(52);
  expect((await frame(page, "icon")).y).toBe(152);
  expect(await page.evaluate(() => Reflect.get(window, "spacingCommits").length)).toBe(0);
  await page.mouse.up();
  expect(await page.evaluate(() => Reflect.get(window, "spacingCommits").length)).toBe(1);

  const saved = await page.evaluate(() =>
    JSON.parse(
      JSON.stringify(Reflect.get(window, "spacingFixture").controls.document.getCommittedFrames()),
    ),
  );

  expect(saved.find((node: { id: string }) => node.id === "layout").layout.padding).toBe(52);
  await page.keyboard.press("Meta+z");
  await expect.poll(async () => (await frame(page)).layout.padding).toBe(32);
  expect((await frame(page, "icon")).y).toBe(132);
  await page.keyboard.press("Meta+Shift+z");
  await expect.poll(async () => (await frame(page)).layout.padding).toBe(52);
  const second = await startDrag(page, handle);
  await page.mouse.move(second.x, second.y + 16);
  await expect.poll(async () => (await frame(page)).layout.padding).toBe(68);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await frame(page)).layout.padding).toBe(52);
  await expect(page.locator("[data-active-layout]")).toHaveCount(0);
});

test("gap handles edit layout with zoom-correct motion and keyboard steps", async ({ page }) => {
  await mount(page, { zoom: 2 });
  const gap = page.locator('[data-layout-handle="gap-icon-title"]');
  const start = await startDrag(page, gap);
  await page.mouse.move(start.x, start.y + 20, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await frame(page)).layout.gap).toBe(34);
  expect((await frame(page, "title")).y - ((await frame(page, "icon")).y + 80)).toBe(34);
  await gap.focus();
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(async () => (await frame(page)).layout.gap).toBe(44);
  expect((await frame(page)).x).toBe(160);
  expect((await frame(page)).y).toBe(100);
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await frame(page)).layout.gap).toBe(43);
});

test("rotated row spacing follows the container axis and pointer cancellation restores it", async ({
  page,
}) => {
  await mount(page, { rotation: 90, row: true });
  const gap = page.locator('[data-layout-handle="gap-icon-title"]');
  const start = await startDrag(page, gap);
  await page.mouse.move(start.x, start.y + 16);
  await expect.poll(async () => (await frame(page)).layout.gap).toBe(40);
  await page
    .locator("[data-snapshot-fixture] .design-canvas")
    .dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect.poll(async () => (await frame(page)).layout.gap).toBe(24);
  expect(await page.evaluate(() => Reflect.get(window, "spacingCommits").length)).toBe(0);
});

test("selection shows layout context and sizing badges; hand tool still pans over handles", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const { controls } = Reflect.get(window, "spacingFixture");
    controls.document.update({ ...controls.document.getFrame("layout"), heightSizing: "hug" });
  });
  await expect(page.locator("[data-snapshot-fixture] .canvas-dimensions")).toHaveText(
    "480 × Fit 260",
  );
  await page.evaluate(() => Reflect.get(window, "spacingFixture").controls.select("title"));
  await expect(page.locator("[data-layout-context]")).toHaveAttribute(
    "data-layout-context",
    "layout",
  );
  await expect(page.locator("[data-layout-handle]")).toHaveCount(0);
  await expect(page.locator("[data-layout-child]")).toHaveCount(3);
  await page.evaluate(() => Reflect.get(window, "spacingFixture").controls.select("layout"));
  const box = (await page.locator('[data-layout-handle="padding-top"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20);
  await page.mouse.up({ button: "middle" });
  expect(
    await page.evaluate(
      () => Reflect.get(window, "spacingFixture").controls.camera.getCurrent().viewport,
    ),
  ).toMatchObject({ x: 40, y: 20 });
  expect((await frame(page)).layout.padding).toBe(32);
});

test("layout chrome matches the reference with screen-sized controls", async ({ page }) => {
  await mount(page);
  await page.locator('[data-layout-handle="gap-icon-title"]').hover();
  await expect(page.locator(".canvas-layout-value")).toHaveText("24");
  await page.screenshot({ path: "/tmp/flies-layout-chrome.png" });
  const before = await page.locator('[data-layout-handle="padding-top"]').boundingBox();
  await page.evaluate(() => {
    const { camera } = Reflect.get(window, "spacingFixture").controls;
    camera.setViewport({ x: 0, y: 0, zoom: 0.5 });
    camera.flush();
  });
  const after = await page.locator('[data-layout-handle="padding-top"]').boundingBox();
  expect(after!.width).toBe(before!.width);
  expect(after!.height).toBe(before!.height);
});
