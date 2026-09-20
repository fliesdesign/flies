import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  formatUpdateError,
  shouldAutoCheckUpdates,
  updateDownloadLabel,
  updateProgressPercent,
  updateStatusText,
} from "./updates";

describe("desktop updates", () => {
  it("auto-checks only the production desktop app", () => {
    assert.equal(shouldAutoCheckUpdates(true, true), true);
    assert.equal(shouldAutoCheckUpdates(true, false), false);
    assert.equal(shouldAutoCheckUpdates(false, true), false);
  });

  it("formats download progress and status copy", () => {
    assert.equal(updateProgressPercent(0, 0), null);
    assert.equal(updateProgressPercent(50, 100), 50);
    assert.equal(updateDownloadLabel(0, 0), "Downloading update…");
    assert.equal(updateDownloadLabel(50, 100), "Downloading update… 50%");
    assert.equal(updateStatusText({ kind: "idle" }), "Check GitHub for a newer desktop build.");
    assert.equal(updateStatusText({ kind: "current" }), "You are on the latest version.");
    assert.equal(
      updateStatusText({ kind: "available", version: "0.2.0", notes: "" }),
      "Flies 0.2.0 is available.",
    );
  });

  it("strips empty and prefixed updater errors", () => {
    assert.equal(formatUpdateError(""), "Could not check for updates.");
    assert.equal(formatUpdateError(new Error("Error: network")), "network");
  });
});
