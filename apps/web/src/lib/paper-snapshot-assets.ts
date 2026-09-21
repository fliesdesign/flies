import { loadRemoteImage, publicImageUrl } from "@flies/html";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Capture remote artwork once, so saved documents never depend on the original site's images. */
export async function loadSnapshotImage(source: string): Promise<string> {
  const url = publicImageUrl(source);
  if (!url) throw new Error("Snapshot images must use a public HTTP or HTTPS URL.");
  // The desktop shell downloads without CORS and checks the resolved address.
  if (isTauri()) return invoke<string>("read_snapshot_image", { url });

  return loadRemoteImage(url);
}
