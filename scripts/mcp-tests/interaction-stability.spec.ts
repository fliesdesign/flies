import { expect, test, type Page } from "@playwright/test";

async function mount(page: Page, zoom = 1) {
  await page.goto("/");
  await page.evaluate(async (scale) => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    const fixture = await (await import(/* @vite-ignore */ path)).mountSnapshotFixture();
    Reflect.set(window, "interactionFixture", fixture);
    fixture.controls.document.add({
      id: "moving",
      name: "Moving",
      kind: "rectangle",
      x: 100,
      y: 100,
      width: 100,
      height: 100,
      fill: "#3b82f6",
    });
    fixture.controls.camera.setViewport({
      x: scale === 1 ? 0 : -200,
      y: scale === 1 ? 0 : -200,
      zoom: scale,
    });
    fixture.controls.camera.flush();
  }, zoom);
  await expect(
    page.locator('[data-snapshot-fixture] [data-frame-id="moving"]').first(),
  ).toBeVisible();
}

async function node(page: Page) {
  return page.evaluate(() =>
    Reflect.get(window, "interactionFixture").controls.document.getFrame("moving"),
  );
}

async function history(page: Page, action: "undo" | "redo") {
  await page.evaluate(
    (operation) => Reflect.get(window, "interactionFixture").controls.document[operation](),
    action,
  );
}

test("selection ignores click jitter and high-zoom dragging keeps subpixel motion and one undo", async ({
  page,
}) => {
  await mount(page, 4);
  await page.mouse.move(300, 300);
  await page.mouse.down();
  await page.mouse.move(302, 300);
  expect((await node(page)).x).toBe(100);
  await page.mouse.move(304, 300);
  await expect.poll(async () => (await node(page)).x).toBe(101);
  await page.mouse.move(305, 300);
  await expect.poll(async () => (await node(page)).x).toBe(101.25);
  await page.mouse.up();
  await history(page, "undo");
  expect((await node(page)).x).toBe(100);
  await history(page, "redo");
  expect((await node(page)).x).toBe(101.25);

  await page.mouse.move(310, 300);
  await page.mouse.down();
  await page.mouse.move(350, 300);
  await expect.poll(async () => (await node(page)).x).toBe(111.25);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await node(page)).x).toBe(101.25);
  await history(page, "undo");
  expect((await node(page)).x).toBe(100);
});

test("shift holds the chosen movement axis until released", async ({ page }) => {
  await mount(page);
  await page.mouse.move(140, 140);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(180, 150);
  await expect.poll(async () => (await node(page)).x).toBe(140);
  await page.mouse.move(175, 205);
  await expect.poll(async () => (await node(page)).x).toBe(135);
  expect((await node(page)).y).toBe(100);
  await page.keyboard.up("Shift");
  await page.mouse.move(175, 206);
  await expect.poll(async () => (await node(page)).y).toBe(166);
  await page.keyboard.down("Shift");
  await page.mouse.move(175, 210);
  await expect.poll(async () => (await node(page)).y).toBe(170);
  expect((await node(page)).x).toBe(100);
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await history(page, "undo");
  expect(await node(page)).toMatchObject({ x: 100, y: 100 });
});

test("resize at high zoom follows one screen pixel without jumping a world pixel", async ({
  page,
}) => {
  await mount(page, 4);
  await page.mouse.click(300, 300);
  const handle = page.getByRole("button", { name: "Resize Moving from right", exact: true });
  const bounds = (await handle.boundingBox())!;
  const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 4, start.y);
  await expect.poll(async () => (await node(page)).width).toBe(101);
  await page.mouse.move(start.x + 5, start.y);
  await expect.poll(async () => (await node(page)).width).toBe(101.25);
  await page.mouse.up();
  await history(page, "undo");
  expect((await node(page)).width).toBe(100);
});
