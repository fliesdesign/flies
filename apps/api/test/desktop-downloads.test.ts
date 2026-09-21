import { describe, expect, it } from "bun:test";

import { desktopDownloadUrl } from "../src/desktop-downloads";

const base = "https://desktop.flies.design/releases/v0.2.4/";

const manifest = {
  platforms: {
    "darwin-aarch64": { url: `${base}Flies_0.2.4_aarch64.app.tar.gz` },
    "windows-x86_64": { url: `${base}Flies_0.2.4_x64-setup.exe` },
    "linux-x86_64": { url: `${base}Flies_0.2.4_amd64.AppImage` },
  },
};

describe("desktop downloads", () => {
  it("uses the Mac installer instead of the updater archive", () => {
    expect(desktopDownloadUrl("mac-arm", manifest)).toBe(`${base}Flies_0.2.4_aarch64.dmg`);
  });
  it("uses published Windows and Linux downloads", () => {
    expect(desktopDownloadUrl("windows-intel", manifest)).toBe(`${base}Flies_0.2.4_x64-setup.exe`);
    expect(desktopDownloadUrl("linux", manifest)).toBe(`${base}Flies_0.2.4_amd64.AppImage`);
  });
  it("rejects unavailable targets and external URLs", () => {
    expect(desktopDownloadUrl("mac-intel", manifest)).toBeNull();
    expect(desktopDownloadUrl("unknown", manifest)).toBeNull();
    expect(
      desktopDownloadUrl("linux", {
        platforms: { "linux-x86_64": { url: "https://example.com/installer" } },
      }),
    ).toBeNull();
  });
});
