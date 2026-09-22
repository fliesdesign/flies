// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { WorkspaceSettings } from "./workspace-settings";

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("./appearance-settings", () => ({ AppearanceSettings: () => null }));
vi.mock("./update-settings", () => ({ UpdateSettings: () => null }));
vi.mock("./workspace-billing", () => ({ BillingSettings: () => <div>Web billing controls</div> }));
vi.mock("./workspace-members", () => ({ WorkspaceMembers: () => <div>Web member controls</div> }));
let root: Root;
let element: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  mocks.openUrl.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  window.location.hash = "";
});

it.each([false, true])("opens appearance for old account links (desktop: %s)", async (desktop) => {
  window.location.hash = "account";
  await act(async () => root.render(<WorkspaceSettings desktop={desktop} fileCount={0} />));
  expect(element.textContent).toContain("Make it yours");
  expect([...element.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual([
    "Appearance",
    "Billing",
    "Members",
    "Updates",
  ]);
});

it.each(["billing", "members"])(
  "opens %s on the web instead of showing desktop controls",
  async (section) => {
    window.location.hash = section;
    await act(async () => root.render(<WorkspaceSettings desktop fileCount={0} />));
    expect(element.textContent).not.toContain("Web billing controls");
    expect(element.textContent).not.toContain("Web member controls");

    const button = [...element.querySelectorAll("button")].find(
      (item) => item.textContent === "Manage on the web",
    );

    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(mocks.openUrl).toHaveBeenCalledWith(`https://app.flies.design/settings#${section}`);
  },
);

it.each([
  ["billing", "Web billing controls"],
  ["members", "Web member controls"],
])("keeps web %s controls available", async (section, label) => {
  window.location.hash = section;
  await act(async () => root.render(<WorkspaceSettings desktop={false} fileCount={0} />));
  expect(element.textContent).toContain(label);
  expect(element.textContent).not.toContain("Manage on the web");
});
