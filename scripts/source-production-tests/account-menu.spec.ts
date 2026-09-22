import { expect, test } from "@playwright/test";

test("account settings are removed and the workspace menu signs out with retry", async ({
  page,
}) => {
  const account = {
    user: { id: "account-menu-test", name: "Test", email: "test@example.invalid" },
    workspace: { id: "workspace", name: "My workspace" },
  };

  let logoutAttempts = 0;
  const accountRequests: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("flies:onboarding:v1:account-menu-test", JSON.stringify({ step: "done" }));
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: account });
    if (path === "/api/files")
      return route.fulfill({ json: { workspace: account.workspace, warnings: [], files: [] } });
    if (path === "/api/workspaces")
      return route.fulfill({ json: { workspaces: [account.workspace], invitations: [] } });
    if (path === "/api/billing")
      return route.fulfill({ json: { enabled: false, plan: null, limits: null } });
    if (path === "/api/sync/ticket") return route.fulfill({ json: { enabled: false } });
    if (path.startsWith("/api/account/")) accountRequests.push(path);

    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.route("**/auth/logout", async (route) => {
    expect(route.request().method()).toBe("POST");
    logoutAttempts++;

    return logoutAttempts === 1
      ? route.fulfill({ status: 503, json: { error: "Could not sign out. Please retry." } })
      : route.fulfill({ json: { ok: true } });
  });

  await page.goto("/settings#account");
  await expect(page.getByRole("tab", { name: "Account", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Appearance", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("heading", { name: "Make it yours" })).toBeVisible();
  await expect(page.getByText("Passkeys", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Two-factor authentication", { exact: true })).toHaveCount(0);
  expect(accountRequests).toEqual([]);

  await page.getByRole("button", { name: "Switch workspace: My workspace" }).click();
  await expect(page.getByRole("menuitem", { name: "Settings", exact: true })).toBeVisible();
  const signOut = page.getByRole("menuitem", { name: "Sign out", exact: true });
  await expect(signOut).toBeVisible();
  await page.screenshot({ path: "/tmp/flies-account-menu.png" });
  await signOut.click();
  await expect(page.getByRole("alert")).toHaveText("Could not sign out. Please retry.");
  await expect(signOut).toBeVisible();
  await signOut.click();
  await expect(page.getByRole("button", { name: "Sign in to Flies", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch workspace: My workspace" })).toHaveCount(0);
  expect(logoutAttempts).toBe(2);
});
