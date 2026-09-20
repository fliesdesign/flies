import { invoke, isTauri } from "@tauri-apps/api/core";

import { CANVAS_CLIPBOARD_MIME, LEGACY_CANVAS_CLIPBOARD_MIME } from "./canvas-operations";

export type CanvasClipboard = {
  internal: string;
  html: string;
  text: string;
  images: File[];
};

export const usesNativeCanvasClipboard = () => isTauri() && /Mac/.test(navigator.userAgent);

/** Read all representations before choosing one; snapshots can include a plain-text fallback. */
export async function readCanvasClipboard(): Promise<CanvasClipboard> {
  if (usesNativeCanvasClipboard()) {
    const data = await invoke<{ html: string; text: string; imageBase64: string | null }>(
      "read_canvas_clipboard",
    );
    const images: File[] = [];
    if (data.imageBase64) {
      const bytes = Uint8Array.from(atob(data.imageBase64), (char) => char.charCodeAt(0));
      images.push(new File([bytes], "Clipboard image.png", { type: "image/png" }));
    }
    return { internal: "", html: data.html, text: data.text, images };
  }
  const clipboard = navigator.clipboard;
  if (clipboard?.read) {
    try {
      // Keep capture markup intact; the snapshot importer constructs its own passive tree.
      const read = clipboard.read.bind(clipboard) as (options?: {
        unsanitized: string[];
      }) => Promise<ClipboardItem[]>;
      const items = await read({ unsanitized: ["text/html"] });
      const contents = await Promise.all(
        items.map(async (item) => {
          const textFor = (type: string) =>
            item.types.includes(type)
              ? item.getType(type).then((blob) => blob.text())
              : Promise.resolve("");
          const imageType = item.types.find((type) => type.startsWith("image/"));
          const [internal, legacyInternal, html, text, image] = await Promise.all([
            textFor(CANVAS_CLIPBOARD_MIME),
            textFor(LEGACY_CANVAS_CLIPBOARD_MIME),
            textFor("text/html"),
            textFor("text/plain"),
            imageType
              ? item
                  .getType(imageType)
                  .then((blob) => new File([blob], "Clipboard image", { type: imageType }))
              : Promise.resolve(null),
          ]);
          return { internal: internal || legacyInternal, html, text, image };
        }),
      );
      return {
        internal: contents.find((item) => item.internal)?.internal ?? "",
        html: contents.find((item) => item.html)?.html ?? "",
        text: contents.find((item) => item.text)?.text ?? "",
        images: contents.flatMap((item) => (item.image ? [item.image] : [])),
      };
    } catch {
      // Some WebViews expose read() but only grant plain-text reads from a menu action.
    }
  }
  return { internal: "", html: "", text: await clipboard.readText(), images: [] };
}
