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

      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/me")
          return route.fulfill(
            signedIn ? { json: account } : { status: 401, json: { error: "Sign in" } },
          );
        if (path === "/api/files")
          return route.fulfill({ json: { workspace: account.workspace, warnings: [], files: [] } });

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

      expect(errors).toEqual([]);
    });
  });
}
