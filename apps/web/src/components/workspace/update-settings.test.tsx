/// <reference types="node" />

import assert from "node:assert/strict";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vite-plus/test";

import { DesktopUpdateBanner, UpdateSettings } from "./update-settings";

describe("update settings", () => {
  it("points browsers at the desktop app", () => {
    const markup = renderToStaticMarkup(<UpdateSettings desktop={false} />);
    assert.match(markup, />Updates</);
    assert.match(markup, /Updates are available in the desktop app/);
    assert.doesNotMatch(markup, /Check for updates/);
  });

  it("exposes a manual check on desktop", () => {
    const markup = renderToStaticMarkup(<UpdateSettings desktop />);
    assert.match(markup, />Updates</);
    assert.match(markup, /Check for updates/);
    assert.match(markup, /Check GitHub for a newer desktop build/);
  });

  it("hides the production update banner until a check finds a build", () => {
    const markup = renderToStaticMarkup(<DesktopUpdateBanner desktop />);
    assert.equal(markup, "");
  });
});
