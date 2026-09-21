// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { AccountPasskeys } from "./account-passkeys";

const mocks = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("@/lib/api", () => ({ signIn: mocks.signIn }));

let root: Root;
let element: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  mocks.signIn.mockResolvedValue(undefined);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

it("starts AuthKit sign-in so a passkey can be added", async () => {
  await act(async () => root.render(<AccountPasskeys />));
  expect(element.textContent).toContain("Passkeys");
  expect(element.textContent).toContain("Face ID");

  const add = [...element.querySelectorAll("button")].find(
    (item) => item.textContent === "Add a passkey",
  );

  expect(add).toBeTruthy();
  await act(async () => add!.click());
  expect(mocks.signIn).toHaveBeenCalledWith(false, {
    returnTo: "/settings#account",
    passkey: true,
  });
});
