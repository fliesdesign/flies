// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AccountMfa } from "./account-mfa";

const mocks = vi.hoisted(() => ({ api: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: mocks.api, post: mocks.post }));

let root: Root;
let element: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  mocks.api.mockResolvedValue({ enrolled: false });
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

async function mount() {
  await act(async () => root.render(<AccountMfa />));
}

async function click(text: string) {
  const button = [...document.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );

  expect(button, text).toBeTruthy();
  await act(async () => button!.click());
}

it("starts authenticator enrollment from account settings", async () => {
  mocks.post.mockResolvedValue({
    factorId: "auth_factor_01TEST",
    challengeId: "auth_challenge_01TEST",
    qrCode: "data:image/png;base64,AQID",
    secret: "JBSWY3DPEHPK3PXP",
    uri: "otpauth://totp/Flies:test@example.com",
  });
  await mount();
  expect(element.textContent).toContain("Two-factor authentication");
  expect(element.textContent).toContain("Off");
  await click("Add authenticator app");
  expect(mocks.post).toHaveBeenCalledWith("/api/account/mfa", {});
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain("Add an authenticator app");
    expect(document.body.textContent).toContain("JBSWY3DPEHPK3PXP");
  });
  expect(document.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AQID");
});

it("turns off an enrolled authenticator after confirmation", async () => {
  mocks.api.mockResolvedValue({ enrolled: true, factorId: "auth_factor_01TEST" });
  mocks.post.mockResolvedValue({ enrolled: false });
  await mount();
  expect(element.textContent).toContain("On");
  await click("Turn off");
  expect(document.body.textContent).toContain("Turn off two-factor authentication?");

  const confirm = document.querySelector('[data-slot="alert-dialog-action"]');

  expect(confirm).toBeTruthy();
  await act(async () => (confirm as HTMLButtonElement).click());
  expect(mocks.post).toHaveBeenCalledWith("/api/account/mfa/remove", {});
});
