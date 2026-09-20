import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  DEFAULT_APPEARANCE,
  DEFAULT_UI_COLORS,
  adjustUiColor,
  applyAppearance,
  isDefaultAppearance,
  normalizeAppearance,
  parseUiHex,
  resolvedUiColors,
} from "./appearance";

describe("appearance", () => {
  it("parses hex colors and leaves 0/0 adjustments unchanged", () => {
    assert.equal(parseUiHex("#abc"), "#aabbcc");
    assert.equal(parseUiHex("0C0C0C"), "#0c0c0c");
    assert.equal(parseUiHex("#e05252ff"), null);
    assert.equal(adjustUiColor("#0c0c0c", 0, 0), "#0c0c0c");
    assert.equal(adjustUiColor("#ececec", 0, 0), "#ececec");
  });

  it("brightens toward white and darkens toward black", () => {
    const lifted = adjustUiColor("#0c0c0c", 50, 0);
    const dimmed = adjustUiColor("#ececec", -50, 0);
    assert.ok(lifted > "#0c0c0c");
    assert.ok(lifted < "#ffffff");
    assert.ok(dimmed < "#ececec");
    assert.ok(dimmed > "#000000");
  });

  it("increases contrast away from mid-gray", () => {
    assert.ok(adjustUiColor("#404040", 0, 50) < "#404040");
    assert.ok(adjustUiColor("#c0c0c0", 0, 50) > "#c0c0c0");
    assert.equal(adjustUiColor("#808080", 0, -50), "#808080");
  });

  it("drops invalid tokens and default-equal custom colors", () => {
    const appearance = normalizeAppearance({
      brightness: 90,
      contrast: -12.4,
      colors: {
        background: "#111",
        foreground: DEFAULT_UI_COLORS.foreground,
        nope: "#ff0000",
        destructive: "red",
      },
    });
    assert.equal(appearance.brightness, 50);
    assert.equal(appearance.contrast, -12);
    assert.deepEqual(appearance.colors, { background: "#111111" });
    assert.equal(isDefaultAppearance(DEFAULT_APPEARANCE), true);
  });

  it("resolves and applies transformed CSS variables", () => {
    const appearance = normalizeAppearance({
      brightness: 10,
      colors: { background: "#101010" },
    });
    const colors = resolvedUiColors(appearance);
    assert.equal(colors.background, adjustUiColor("#101010", 10, 0));
    assert.equal(colors.foreground, adjustUiColor(DEFAULT_UI_COLORS.foreground, 10, 0));
    const set = new Map<string, string>();
    applyAppearance(appearance, {
      style: {
        setProperty: (name, value) => set.set(name, value),
        removeProperty: (name) => set.delete(name),
      },
    });
    assert.equal(set.get("--background"), colors.background);
    applyAppearance(DEFAULT_APPEARANCE, {
      style: {
        setProperty: (name, value) => set.set(name, value),
        removeProperty: (name) => set.delete(name),
      },
    });
    assert.equal(set.size, 0);
  });
});
