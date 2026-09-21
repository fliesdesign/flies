import { expect, it } from "vite-plus/test";

import { detectDesktopPlatform } from "./get-desktop";

it.each([
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0, "mac"],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64)", 0, "windows"],
  ["Mozilla/5.0 (X11; Linux x86_64)", 0, "linux"],
  ["Mozilla/5.0 (Linux; Android 15)", 5, "all"],
  ["Mozilla/5.0 (iPhone; CPU iPhone OS)", 5, "all"],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5, "all"],
  ["Mozilla/5.0 (X11; CrOS x86_64)", 0, "all"],
  ["unknown", 0, "all"],
])("detects the download platform for %s", (agent, touchPoints, expected) => {
  expect(detectDesktopPlatform(agent, touchPoints)).toBe(expected);
});
