import { test, expect } from "@playwright/test";

test("web workspace routes support direct files, navigation, history, and errors without tabs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  const doc = {
    format: "flies",
    version: 1,
    id,
    name: "Route design",
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    nodes: [],
  };

  const account = {
    user: { id: "test", name: "Test", email: "test@example.invalid" },
    workspace: { id: "workspace", name: "My workspace" },
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: account });
    if (path === "/api/files")
      return route.fulfill({
        json: {
          workspace: account.workspace,
          warnings: [],
          files: [{ ...doc, preview: [], nodeCount: 0, archived: false }],
        },
      });
    if (path === `/api/files/${id}`) return route.fulfill({ json: doc });

    return route.fulfill({ status: 404, json: { error: "File not found" } });
  });
  await page.goto(`http://127.0.0.1:1431/files/${id}`);
  await expect(page.getByRole("button", { name: "Project menu", exact: true })).toBeVisible();
  await expect(page.locator(".workspace-tabs")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Project menu", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Project menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "All files", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:1431/files");
  await expect(page.getByRole("heading", { name: "Files", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch workspace: My workspace" }).click();
  await expect(
    page.getByRole("menuitem", { name: "My workspace Current workspace" }),
  ).toHaveAttribute("aria-current", "true");
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:1431/settings");
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:1431/settings");
  await page.getByRole("button", { name: "Recents", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:1431/recents");
  await page.goBack();
  await expect(page).toHaveURL("http://127.0.0.1:1431/settings");
  await page.goForward();
  await expect(page).toHaveURL("http://127.0.0.1:1431/recents");
  await page.getByRole("button", { name: /Route design,/ }).click();
  await expect(page).toHaveURL(`http://127.0.0.1:1431/files/${id}`);
  await page.goto("http://127.0.0.1:1431/files/01ARZ3NDEKTSV4RRFFQ69G5FAA");
  await expect(page.getByRole("alert")).toContainText("File not found");
  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:1431/files");
  expect(errors).toEqual([]);
});
