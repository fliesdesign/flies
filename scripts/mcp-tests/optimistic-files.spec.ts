import type { CanvasFrame } from "@flies/canvas";
import { expect, test, type Page, type Route } from "@playwright/test";

import type { DesignFile } from "../../apps/web/src/lib/files";

async function workspace(page: Page, desktop = false) {
  await page.addInitScript((isDesktop) => {
    localStorage.setItem("flies:onboarding:v1:optimistic-test", JSON.stringify({ step: "done" }));
    if (!isDesktop) return;
    Reflect.set(window, "isTauri", true);
    Reflect.set(window, "__TAURI_EVENT_PLUGIN_INTERNALS__", { unregisterListener: () => {} });
    Reflect.set(window, "__TAURI_INTERNALS__", {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke: async (command: string) => {
        if (command === "mcp_next_request") return new Promise(() => {});

        return null;
      },
    });
  }, desktop);

  const account = {
    user: { id: "optimistic-test", name: "Test", email: "test@example.invalid" },
    workspace: { id: "workspace", name: "My workspace" },
  };

  const requests: { route: Route; body: Pick<DesignFile, "name" | "nodes" | "theme"> }[] = [];
  const files = new Map<string, DesignFile>();
  const ticketIds: string[] = [];

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: account });
    if (path === "/api/billing") return route.fulfill({ json: { enabled: false } });

    if (path === "/api/sync/ticket") {
      ticketIds.push(route.request().postDataJSON().fileId);

      return route.fulfill({ json: { enabled: false } });
    }

    if (path === "/api/files") {
      if (route.request().method() === "POST") {
        requests.push({ route, body: route.request().postDataJSON() });

        return;
      }

      return route.fulfill({
        json: {
          workspace: account.workspace,
          warnings: [],
          files: [...files.values()].map((file) => ({
            id: file.id,
            name: file.name,
            createdAt: file.createdAt,
            updatedAt: file.updatedAt,
            preview: [],
            nodeCount: file.nodes.length,
            archived: false,
          })),
        },
      });
    }

    const id = path.split("/")[3];
    const file = files.get(id);

    if (file && path.endsWith("/revisions")) {
      const updated = { ...file, ...route.request().postDataJSON(), revision: file.revision + 1 };
      files.set(id, updated);

      return route.fulfill({ json: updated });
    }

    if (file) return route.fulfill({ json: file });

    return route.fulfill({ status: 404, json: { error: "File not found" } });
  });
  await page.goto("/files");
  await expect(page.locator(".library-home")).toBeVisible();

  async function finish(index = 0) {
    const request = requests[index];
    const id = `01ARZ3NDEKTSV4RRFFQ69G5FA${index}`;

    const file: DesignFile = {
      format: "flies",
      version: 1,
      id,
      ...request.body,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      revision: 0,
    };

    files.set(id, file);
    await request.route.fulfill({ json: file });

    return id;
  }

  return { requests, files, ticketIds, finish };
}

async function createFromLibrary(page: Page) {
  await page
    .locator(".library-home")
    .getByRole("button", { name: "New file", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("First idea");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("application", { name: "Design canvas" })).toBeVisible();
}

async function draw(page: Page) {
  await page.getByRole("button", { name: "Frame (F)", exact: true }).click();
  const canvas = page.getByRole("application", { name: "Design canvas" });
  const bounds = (await canvas.boundingBox())!;
  await page.mouse.move(bounds.x + 150, bounds.y + 170);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 350, bounds.y + 310, { steps: 8 });
  await page.mouse.up();
}

const hasFrame = (nodes: CanvasFrame[] = []) => nodes.some((node) => node.kind === "frame");

test("library creation opens an editable canvas before the response and preserves it on save", async ({
  page,
}) => {
  const state = await workspace(page);
  await createFromLibrary(page);
  await expect.poll(() => state.requests.length).toBe(1);
  await expect(page).toHaveURL(/\/files\/draft-/);
  await expect(page.locator(".workspace-tabs")).toHaveCount(0);
  const canvas = await page.getByRole("application", { name: "Design canvas" }).elementHandle();
  await draw(page);
  expect(state.files.size).toBe(0);
  expect(state.ticketIds).toEqual([]);
  const id = await state.finish();
  await expect(page).toHaveURL(new RegExp(`/files/${id}$`));
  await expect.poll(() => hasFrame(state.files.get(id)?.nodes)).toBe(true);
  expect(await canvas!.evaluate((element) => element.isConnected)).toBe(true);
  expect(state.ticketIds).toEqual([id]);
  await page.getByRole("application", { name: "Design canvas" }).focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => hasFrame(state.files.get(id)?.nodes)).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("button", { name: /First idea,/ })).toBeVisible();
});

test("failed creation retains the canvas and saves early edits after retry", async ({ page }) => {
  const state = await workspace(page);
  await createFromLibrary(page);
  await draw(page);
  await expect.poll(() => state.requests.length).toBe(1);
  await state.requests[0].route.fulfill({ status: 503, json: { error: "Workspace unavailable" } });
  await expect(page.getByRole("alert")).toContainText("Could not create file");
  await expect(page.getByRole("application", { name: "Design canvas" })).toBeVisible();
  expect(state.ticketIds).toEqual([]);
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(2);
  const id = await state.finish(1);
  await expect(page).toHaveURL(new RegExp(`/files/${id}$`));
  await expect.poll(() => hasFrame(state.files.get(id)?.nodes)).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("desktop plus adds tabs immediately and out-of-order responses preserve the active tab", async ({
  page,
}) => {
  const state = await workspace(page, true);
  const tabs = page.locator(".workspace-tabs");
  await tabs.getByRole("button", { name: "New file", exact: true }).click();
  await expect(tabs.locator(".workspace-tab-group")).toHaveCount(1);
  await expect(page.getByRole("application", { name: "Design canvas" })).toBeVisible();
  await expect.poll(() => state.requests.length).toBe(1);
  await tabs.getByRole("button", { name: "New file", exact: true }).click();
  await expect(tabs.locator(".workspace-tab-group")).toHaveCount(2);
  await expect.poll(() => state.requests.length).toBe(2);
  const secondId = await state.finish(1);
  await expect(page).toHaveURL(new RegExp(`/files/${secondId}$`));
  const firstId = await state.finish();
  await expect.poll(() => state.ticketIds.includes(firstId)).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/files/${secondId}$`));
  await expect(tabs.locator(".workspace-tab-group").nth(1)).toHaveAttribute("data-active", "true");
  await expect(tabs.locator(".workspace-tab-group")).toHaveCount(2);
  await tabs
    .locator(".workspace-tab-group")
    .first()
    .getByRole("button", { name: "Untitled", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/files/${firstId}$`));
});

test("closing a pending desktop tab finishes its save without leaving a stale tab", async ({
  page,
}) => {
  const state = await workspace(page, true);
  const tabs = page.locator(".workspace-tabs");
  await tabs.getByRole("button", { name: "New file", exact: true }).click();
  await expect.poll(() => state.requests.length).toBe(1);
  await tabs.getByRole("button", { name: "Close Untitled", exact: true }).click();
  await expect(tabs.locator(".workspace-tab-group")).toHaveCount(1);
  await state.finish();
  await expect(tabs.locator(".workspace-tab-group")).toHaveCount(0);
  await expect(page).toHaveURL(/\/files$/);
  await expect(page.getByRole("button", { name: /Untitled,/ })).toBeVisible();
  expect(state.requests).toHaveLength(1);
});
