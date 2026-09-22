// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WorkspaceSwitcher } from "./workspace-switcher";

const mocks = vi.hoisted(() => ({ api: vi.fn(), switchWorkspace: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api }));
vi.mock("./workspace-members", () => ({ switchWorkspace: mocks.switchWorkspace }));

const workspace = { id: "workspace", name: "My workspace" };
let root: Root;
let element: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  mocks.api.mockResolvedValue({ workspaces: [workspace], invitations: [] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

async function openMenu(onSignOut: () => Promise<void>) {
  await act(async () =>
    root.render(
      <WorkspaceSwitcher workspace={workspace} onSettings={() => {}} onSignOut={onSignOut} />,
    ),
  );
  await act(async () => element.querySelector("button")!.click());
}

function item(label: string) {
  const match = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );

  expect(match, label).toBeTruthy();

  return match!;
}

it("keeps sign out available when workspaces cannot be loaded", async () => {
  mocks.api.mockRejectedValue(new Error("Offline"));
  const onSignOut = vi.fn().mockResolvedValue(undefined);
  await openMenu(onSignOut);
  await act(async () => item("Sign out").click());
  expect(onSignOut).toHaveBeenCalledTimes(1);
  expect(mocks.switchWorkspace).not.toHaveBeenCalled();
});

it("keeps the menu open and prevents repeated actions while signing out", async () => {
  let finish!: () => void;

  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const onSignOut = vi.fn().mockReturnValue(completion);
  await openMenu(onSignOut);
  await act(async () => item("Sign out").click());
  expect(item("Signing out…").getAttribute("aria-disabled")).toBe("true");
  expect(item("Settings").getAttribute("aria-disabled")).toBe("true");
  expect(item("My workspace").getAttribute("aria-disabled")).toBe("true");
  await act(async () => item("Signing out…").click());
  expect(onSignOut).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it("shows sign-out failures in the menu and allows retry", async () => {
  const onSignOut = vi.fn().mockRejectedValueOnce(new Error("Could not save pending edits."));
  onSignOut.mockResolvedValueOnce(undefined);
  await openMenu(onSignOut);
  await act(async () => item("Sign out").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save pending edits.",
  );
  await act(async () => item("Sign out").click());
  expect(onSignOut).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="alert"]')).toBeNull();
});
