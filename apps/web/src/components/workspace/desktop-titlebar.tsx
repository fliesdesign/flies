import { invoke, isTauri } from "@tauri-apps/api/core";
import { MenuIcon } from "lucide-react";
import { useState } from "react";

import "./desktop-titlebar.css";

export function DesktopTitlebar() {
  const [error, setError] = useState("");
  const platform = document.documentElement.dataset.nativeTitlebar;
  if (!isTauri() || !platform) return null;

  async function openMenu() {
    setError("");

    try {
      await invoke("show_app_menu");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <>
      <div className="desktop-drag-region" data-tauri-drag-region aria-hidden="true" />
      {platform === "windows" && (
        <button
          type="button"
          className="desktop-menu-toggle"
          aria-label="Application menu"
          aria-haspopup="menu"
          title="Application menu"
          onClick={() => void openMenu()}
        >
          <MenuIcon size={16} aria-hidden="true" />
        </button>
      )}
      {error && (
        <p className="desktop-menu-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
