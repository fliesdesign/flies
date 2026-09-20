import { expect, test, type Page } from "@playwright/test";

const html =
  '<meta charset="utf-8"><x-paper-html><div style="width:240px;height:80px;background:white"><p>Native snapshot</p></div></x-paper-html>';
const surface = "[data-snapshot-fixture] .design-canvas";

async function mountDesktopClipboard(page: Page, fail = false) {
  await page.goto("/");
  await page.evaluate(
    async ({ html: clipboardHtml, fail: shouldFail }) => {
      const harnessPath = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
      const { mountSnapshotFixture } = await import(/* @vite-ignore */ harnessPath);
      Reflect.set(window, "snapshotFixture", await mountSnapshotFixture());
      const mocksPath = "/node_modules/@tauri-apps/api/mocks.js";
      const { mockIPC } = await import(/* @vite-ignore */ mocksPath);
      Reflect.set(window, "isTauri", true);
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
      Reflect.set(window, "nativeClipboardReads", 0);
      Reflect.set(window, "webClipboardReads", 0);
      for (const method of ["read", "readText"]) {
        Object.defineProperty(navigator.clipboard, method, {
          configurable: true,
          value: () => {
            Reflect.set(window, "webClipboardReads", Reflect.get(window, "webClipboardReads") + 1);
            throw new Error("WKWebView clipboard access must not be used");
          },
        });
      }
      mockIPC(async (command: string) => {
        if (command !== "read_canvas_clipboard") throw new Error(`Unexpected command: ${command}`);
        Reflect.set(
          window,
          "nativeClipboardReads",
          Reflect.get(window, "nativeClipboardReads") + 1,
        );
        await new Promise((resolve) => setTimeout(resolve, 40));
        if (shouldFail) throw new Error("Clipboard is unavailable");
        return { html: clipboardHtml, text: "Wrong plain fallback", imageBase64: null };
      });
    },
    { html, fail },
  );
}

async function importedRoot(page: Page) {
  return page.evaluate(
    () => Reflect.get(window, "snapshotFixture").controls.document.getFrames()[0],
  );
}

test("desktop context-menu Paste bypasses WebKit and imports native HTML at the menu point", async ({
  page,
}) => {
  await mountDesktopClipboard(page);
  await page.locator(surface).click({ button: "right", position: { x: 320, y: 220 } });
  await page.getByRole("menuitem", { name: /^Paste\s+⌘/ }).click();
  await expect
    .poll(() => importedRoot(page))
    .toMatchObject({ name: "Paper snapshot", x: 320, y: 220 });
  expect(await page.evaluate(() => Reflect.get(window, "nativeClipboardReads"))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "webClipboardReads"))).toBe(0);
});

test("desktop Cmd+V reads native HTML once and centers it, with normal undo", async ({ page }) => {
  await mountDesktopClipboard(page);
  await page.locator(surface).focus();
  await page.keyboard.press("Meta+v");
  await expect.poll(() => importedRoot(page)).toMatchObject({ name: "Paper snapshot" });
  const size = await page.evaluate(
    () => Reflect.get(window, "snapshotFixture").controls.camera.getCurrent().size,
  );
  expect(await importedRoot(page)).toMatchObject({ x: size.x / 2 - 120, y: size.y / 2 - 40 });
  expect(await page.evaluate(() => Reflect.get(window, "nativeClipboardReads"))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, "webClipboardReads"))).toBe(0);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => importedRoot(page)).toBeUndefined();
});

test("an empty native paste event reads the pasteboard and overlapping events do not duplicate content", async ({
  page,
}) => {
  await mountDesktopClipboard(page);
  await page.locator(surface).evaluate((element) => {
    for (let index = 0; index < 2; index++) {
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      element.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error("Native paste must be handled");
    }
  });
  await expect.poll(() => importedRoot(page)).toMatchObject({ name: "Paper snapshot" });
  expect(await page.evaluate(() => Reflect.get(window, "nativeClipboardReads"))).toBe(1);
  expect(
    await page.evaluate(
      () => Reflect.get(window, "snapshotFixture").controls.document.getChildren().length,
    ),
  ).toBe(1);
});

test("native clipboard failure is visible and does not change the document", async ({ page }) => {
  await mountDesktopClipboard(page, true);
  await page.locator(surface).focus();
  await page.keyboard.press("Meta+v");
  await expect(page.locator("[data-snapshot-fixture] .canvas-notice")).toContainText(
    "Clipboard is unavailable",
  );
  expect(await importedRoot(page)).toBeUndefined();
  expect(await page.evaluate(() => Reflect.get(window, "webClipboardReads"))).toBe(0);
});

test("native clipboard handling leaves text-field paste to the text editor", async ({ page }) => {
  await mountDesktopClipboard(page);
  await page.locator(surface).evaluate((element) => {
    const input = document.createElement("input");
    element.append(input);
    const key = new KeyboardEvent("keydown", {
      key: "v",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(key);
    const paste = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    if (key.defaultPrevented || paste.defaultPrevented)
      throw new Error("Text paste was intercepted");
    input.remove();
  });
  expect(await page.evaluate(() => Reflect.get(window, "nativeClipboardReads"))).toBe(0);
});
