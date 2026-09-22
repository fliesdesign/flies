import { expect, test } from "@playwright/test";

const windowsAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

const macAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";

for (const platform of ["windows", "macos", "browser"] as const) {
  test.describe(platform, () => {
    test.use({ userAgent: platform === "macos" ? macAgent : windowsAgent });

    test("titlebar respects platform and leaves room for native controls", async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      if (platform !== "browser") {
        await page.addInitScript(() => {
          Reflect.set(window, "isTauri", true);
          Reflect.set(window, "menuCalls", 0);
          Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
          Reflect.set(window, "__TAURI_INTERNALS__", {
            metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
            transformCallback: () => 1,
            unregisterCallback: () => {},
            invoke: async (command: string) => {
              if (command === "mcp_next_request") return new Promise(() => {});

              if (command === "show_app_menu") {
                Reflect.set(window, "menuCalls", Reflect.get(window, "menuCalls") + 1);
                if (Reflect.get(window, "menuFail")) throw new Error("Menu unavailable");
              }

              return null;
            },
          });
        });
      }

      let signedIn = false;

      const account = {
        user: { id: "test", name: "Test", email: "test@example.invalid" },
        workspace: { id: "workspace", name: "My workspace" },
      };

      const file = {
        format: "flies",
        version: 1,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        name: "Glass preview",
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
        nodes: [],
      };

      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/me")
          return route.fulfill(
            signedIn ? { json: account } : { status: 401, json: { error: "Sign in" } },
          );
        if (path === "/api/files")
          return route.fulfill({
            json: {
              workspace: account.workspace,
              warnings: [],
              files: [{ ...file, preview: [], nodeCount: 0, archived: false }],
            },
          });
        if (path === `/api/files/${file.id}`) return route.fulfill({ json: file });
        if (path === "/api/sync/ticket") return route.fulfill({ json: { enabled: false } });

        return route.fulfill({ status: 404, json: { error: "Not found" } });
      });
      await page.goto("/files");
      const menu = page.getByRole("button", { name: "Application menu", exact: true });
      await expect(page.locator(".desktop-drag-region")).toHaveCount(
        platform === "browser" ? 0 : 1,
      );
      await expect(menu).toHaveCount(platform === "windows" ? 1 : 0);
      expect(await page.evaluate(() => getComputedStyle(document.body).paddingTop)).toBe(
        platform === "browser" ? "0px" : "36px",
      );

      if (platform === "windows") {
        await menu.click();
        await expect.poll(() => page.evaluate(() => Reflect.get(window, "menuCalls"))).toBe(1);
        await menu.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => page.evaluate(() => Reflect.get(window, "menuCalls"))).toBe(2);
        await page.evaluate(() => Reflect.set(window, "menuFail", true));
        await menu.click();
        await expect(page.getByRole("alert")).toContainText("Menu unavailable");
      }

      signedIn = true;
      await page.reload();
      await expect(page.locator(".workspace-tabs")).toHaveCount(platform === "browser" ? 0 : 1);
      await expect(page.locator(".library-sidebar")).toBeVisible();

      const expectPanelMaterial = async (selector: string) => {
        const panel = page.locator(selector);
        await expect(panel).toBeVisible();
        await expect(panel).toHaveCSS(
          "backdrop-filter",
          platform === "browser" ? "none" : "blur(24px) saturate(1.25)",
        );

        if (platform === "browser") {
          await expect(panel).toHaveCSS("background-color", "rgb(42, 42, 42)");
        } else {
          await expect(panel).toHaveCSS("background-color", /\/ 0\.55\)$/);
        }
      };

      await expectPanelMaterial(".library-sidebar");
      await expect(page.locator(".library-home")).toHaveCSS("background-color", "rgb(36, 36, 36)");

      if (platform !== "browser") {
        await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expectPanelMaterial(".workspace-tabs");
        await expect(page.locator(".desktop-drag-region")).toHaveCSS("backdrop-filter", "none");
        await expect(page.locator(".desktop-drag-region")).toHaveCSS(
          "background-color",
          "rgba(0, 0, 0, 0)",
        );
        await page.screenshot({ path: testInfo.outputPath(`${platform}-dashboard.png`) });
      }

      if (platform === "windows") {
        await page.setViewportSize({ width: 800, height: 600 });
        const tabs = page.locator(".workspace-tabs");
        await expect(tabs).toBeVisible();

        const bounds = await tabs.evaluate((element) => {
          const style = getComputedStyle(element);

          const controls = [...element.querySelectorAll("button")].map((button) =>
            button.getBoundingClientRect(),
          );

          return {
            left: style.paddingLeft,
            right: style.paddingRight,
            controls: controls.map(({ x, right }) => ({ x, right })),
          };
        });

        expect(bounds.left).toBe("44px");
        expect(bounds.right).toBe("148px");

        for (const control of bounds.controls) {
          expect(control.x).toBeGreaterThanOrEqual(40);
          expect(control.right).toBeLessThanOrEqual(800 - 138);
        }

        await menu.click();
        await expect.poll(() => page.evaluate(() => Reflect.get(window, "menuCalls"))).toBe(1);
        await page.screenshot({ path: testInfo.outputPath("windows-titlebar-layout.png") });
      }

      await page.setViewportSize({ width: 1280, height: 800 });
      await page.getByRole("button", { name: /Glass preview,/ }).click();
      await expectPanelMaterial(".canvas-layers");
      await expectPanelMaterial(".canvas-properties");
      await expect(page.locator(".design-canvas")).toHaveCSS("background-color", "rgb(36, 36, 36)");
      await expect(page.locator(".workspace-tabs")).toHaveCount(platform === "browser" ? 0 : 1);
      await page.screenshot({ path: testInfo.outputPath(`${platform}-canvas.png`) });

      expect(errors).toEqual([]);
    });
  });
}
