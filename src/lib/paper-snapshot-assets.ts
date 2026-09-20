import { invoke, isTauri } from "@tauri-apps/api/core";

import { readCanvasImage } from "./canvas-image";

const MAX_BYTES = 5_000_000;
const RASTER_TYPE = /^image\/(?:png|jpeg|gif|webp|avif)$/i;

/** Capture remote artwork once, so saved documents never depend on the original site's images. */
export async function loadSnapshotImage(source: string): Promise<string> {
  const url = new URL(source);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /^(?:localhost|.*\.(?:localhost|local|internal)|[\d.]+|\[.*\])$/i.test(url.hostname)
  )
    throw new Error("Snapshot images must use a public HTTP or HTTPS URL.");
  if (isTauri()) return invoke<string>("read_snapshot_image", { url: url.href });

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url.href, {
      signal: controller.signal,
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
    });
    const type = response.headers.get("content-type")?.split(";")[0].trim() ?? "";
    if (!response.ok || !RASTER_TYPE.test(type) || !response.body)
      throw new Error("The snapshot image could not be downloaded.");
    if (Number(response.headers.get("content-length")) > MAX_BYTES)
      throw new Error("Snapshot images must be smaller than 5MB.");
    const reader = response.body.getReader();
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        // Read incrementally so a missing or inaccurate Content-Length cannot bypass the limit.
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("Snapshot images must be smaller than 5MB.");
        chunks.push(new Uint8Array(value));
      }
    } finally {
      controller.abort();
      reader.releaseLock();
    }
    const image = await readCanvasImage(new File(chunks, "Snapshot image", { type }));
    return image.src;
  } finally {
    controller.abort();
    window.clearTimeout(timer);
  }
}
