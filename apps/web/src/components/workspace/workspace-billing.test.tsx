// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceBilling } from "./workspace-billing";

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn(), openUrl: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api, post: mocks.post }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));

const free = {
  enabled: true,
  plan: "free",
  limits: { designFiles: 5, imageUploadBytes: 30_000_000, mcpCallsPerWeek: 300 },
};

const pro = { ...free, plan: "pro", limits: { ...free.limits, designFiles: 250 } };
let root: Root;
let element: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  mocks.api.mockResolvedValue(free);
  mocks.post.mockResolvedValue({ url: "https://polar.sh/checkout/test" });
  mocks.openUrl.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

async function mount() {
  await act(async () => root.render(<WorkspaceBilling desktop />));
}

async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );

  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}

describe("workspace billing UI", () => {
  it("hides billing when the server disables it", async () => {
    mocks.api.mockResolvedValue({ enabled: false, plan: null, limits: null });
    await mount();
    expect(element.textContent).toBe("");
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("opens a one-user checkout in the desktop browser and refreshes on return", async () => {
    await mount();
    await click("Upgrade to Pro");
    expect(document.body.textContent).toContain("$12");
    expect(document.body.textContent).toContain("coming soon");
    await click("Continue to checkout");
    expect(mocks.post).toHaveBeenCalledWith("/api/billing/checkout", { seats: 1 });
    expect(mocks.openUrl).toHaveBeenCalledWith("https://polar.sh/checkout/test");
    mocks.post.mockResolvedValue(pro);
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(mocks.post).toHaveBeenCalledWith("/api/billing/refresh", {});
    expect(document.body.textContent).toContain("Your Pro plan is active");
    expect(document.body.textContent).toContain("Open billing portal");
  });
  it("opens subscription management for Pro users", async () => {
    mocks.api.mockResolvedValue(pro);
    await mount();
    await click("Manage subscription");
    await click("Open billing portal");
    expect(mocks.post).toHaveBeenCalledWith("/api/billing/portal", {});
    expect(mocks.post).not.toHaveBeenCalledWith("/api/billing/checkout", expect.anything());
  });
  it("shows checkout failures and allows retry without claiming an upgrade", async () => {
    await mount();
    await click("Upgrade to Pro");
    mocks.post.mockRejectedValueOnce(new Error("Billing service unavailable"));
    await click("Continue to checkout");
    expect(document.body.textContent).toContain("Billing service unavailable");
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(element.textContent).toContain("Free plan");
    await click("Continue to checkout");
    expect(mocks.openUrl).toHaveBeenCalledTimes(1);
  });
  it("shows a retry when the plan cannot load", async () => {
    mocks.api.mockRejectedValueOnce(new Error("Network unavailable"));
    await mount();
    expect(element.textContent).toContain("Billing unavailable");
    await click("Retry billing");
    expect(element.textContent).toContain("Upgrade to Pro");
  });
  it("keeps Free until the server confirms payment", async () => {
    await mount();
    await click("Upgrade to Pro");
    await click("Continue to checkout");
    mocks.post.mockResolvedValue(free);
    await click("Refresh plan");
    expect(document.body.textContent).toContain("Your plan is still Free");
    expect(document.body.textContent).not.toContain("Your Pro plan is active");
  });
});
