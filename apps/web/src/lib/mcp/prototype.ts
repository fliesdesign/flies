import { downloadCanvasFile } from "@flies/canvas";
import { compileTailwind } from "@flies/html/tailwind";

import "./prototype.css";

let current: HTMLDialogElement | undefined;

export function closePrototype() {
  current?.close();
  current?.remove();
  current = undefined;
}

/** Opaque-origin sandbox: prototype code cannot access the editor, Tauri or editor storage. */
export async function openPrototype(html: string, css: string, width: number, height: number) {
  if (new TextEncoder().encode(html).length > 500_000)
    throw new Error("Preview HTML is limited to 500KB.");
  const template = document.createElement("template");
  template.innerHTML = html;

  const tailwind = template.content.querySelector("[class]")
    ? await compileTailwind(template.content)
    : "";

  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

  const source = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{font:16px Arial}body{margin:0}${tailwind}${css.replace(/<\/style/gi, "<\\/style")}</style></head><body>${html}</body></html>`;
  closePrototype();
  const dialog = document.createElement("dialog");
  dialog.className = "mcp-prototype";
  dialog.setAttribute("aria-label", "Interactive preview");
  const header = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "Interactive preview";
  const dimensions = document.createElement("span");
  dimensions.textContent = `${width} × ${height}`;
  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download HTML";
  download.addEventListener("click", () =>
    downloadCanvasFile(new Blob([source], { type: "text/html" }), "prototype.html"),
  );
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close preview";
  close.addEventListener("click", closePrototype);
  header.append(title, dimensions, download, close);
  const scroll = document.createElement("div");
  scroll.className = "mcp-prototype-viewport";
  const iframe = document.createElement("iframe");
  iframe.title = "Interactive HTML prototype";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = "no-referrer";
  iframe.width = String(width);
  iframe.height = String(height);
  iframe.srcdoc = source;
  scroll.append(iframe);
  dialog.append(header, scroll);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (current === dialog) current = undefined;
  });
  document.body.append(dialog);
  current = dialog;
  dialog.showModal();
  close.focus();
}
