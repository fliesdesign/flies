import { gunzipSync, strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { CanvasDocument, type CanvasFrame } from "./canvas-document";
import { EMPTY_THEME, type CanvasTheme } from "./canvas-theme";

export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export type CanvasProject = { name: string; nodes: CanvasFrame[]; theme: CanvasTheme };

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|avif|svg\+xml));base64,([a-z\d+/]+={0,2})$/i;
const IMAGE_PATH = /^images\/[a-z\d._-]+$/i;
const MIME_EXT: Record<string, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};
const EXT_MIME: Record<string, string> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export function projectFilename(name: string, extension = "zip") {
  const safe = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\p{Cc}/gu, "-")
    .replace(/\.+$/, "")
    .slice(0, 120);
  return `${safe || "Untitled"}.${extension}`;
}

export function serializeCanvasProject(
  name: string,
  nodes: readonly CanvasFrame[],
  theme: CanvasTheme = EMPTY_THEME,
): string {
  return JSON.stringify({
    format: "flies",
    version: 1,
    name: name.trim() || "Untitled",
    nodes,
    theme,
  });
}

/** Validate the complete file before replacing the current document. */
export function parseCanvasProject(source: string): CanvasProject {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("This file is not valid JSON. Open a Flies JSON or ZIP project.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !(
      ("type" in value && value.type === "lra-design") ||
      ("format" in value && value.format === "flies")
    ) ||
    !("version" in value) ||
    value.version !== 1
  )
    throw new Error("This project format is not supported. Open a Flies JSON or ZIP project.");
  if (
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length > 1000 ||
    !("nodes" in value) ||
    !Array.isArray(value.nodes)
  )
    throw new Error("This project is incomplete. Its name or layers are missing.");
  try {
    const document = new CanvasDocument(
      value.nodes as CanvasFrame[],
      "theme" in value ? (value.theme as CanvasTheme) : EMPTY_THEME,
    );
    return {
      name: value.name.trim() || "Untitled",
      nodes: document.getCommittedFrames(),
      theme: document.getTheme(),
    };
  } catch {
    throw new Error(
      "This project contains invalid layers or frame nesting. Your current canvas has been kept.",
    );
  }
}

export function packCanvasProject(
  name: string,
  nodes: readonly CanvasFrame[],
  theme: CanvasTheme = EMPTY_THEME,
): Uint8Array {
  const files: Record<string, [Uint8Array, { level: 0 | 9 }]> = {};
  const reused = new Map<string, string>();
  const taken = new Set<string>();
  const packed = nodes.map((node) => {
    if (node.kind !== "image" && node.kind !== "svg") return node;
    const parsed = DATA_URL.exec(node.src);
    if (!parsed) return node;
    const existing = reused.get(node.src);
    if (existing) return { ...node, src: existing };
    const ext = MIME_EXT[parsed[1].toLowerCase()] ?? "png";
    const base = node.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "image";
    let path = `images/${base}.${ext}`;
    for (let n = 2; taken.has(path); n++) path = `images/${base}-${n}.${ext}`;
    taken.add(path);
    reused.set(node.src, path);
    files[path] = [base64ToBytes(parsed[2]), { level: node.kind === "svg" ? 9 : 0 }];
    return { ...node, src: path };
  });
  files["document.json"] = [strToU8(serializeCanvasProject(name, packed, theme)), { level: 9 }];
  const zipped = zipSync(files, { level: 9 });
  if (zipped.byteLength > MAX_PROJECT_BYTES)
    throw new Error("This project is larger than 100 MB. Remove images or layers before saving.");
  return zipped;
}

export function unpackCanvasProject(source: Uint8Array | string): CanvasProject {
  if (typeof source === "string") return parseCanvasProject(source);
  if (source.byteLength > MAX_PROJECT_BYTES)
    throw new Error("This project is larger than 100 MB. Open a smaller project.");
  if (source.length >= 2 && source[0] === 0x50 && source[1] === 0x4b) return unpackZip(source);
  if (source.length >= 2 && source[0] === 0x1f && source[1] === 0x8b) {
    return parseCanvasProject(strFromU8(gunzipSync(source)));
  }
  return parseCanvasProject(strFromU8(source));
}

export function downloadCanvasFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function unpackZip(bytes: Uint8Array): CanvasProject {
  const files = unzipSync(bytes, {
    filter: (file) => {
      const name = file.name.replace(/\\/g, "/").replace(/^\.\//, "");
      return name === "document.json" || name === "flies.json" || IMAGE_PATH.test(name);
    },
  });
  const document = files["document.json"] ?? files["flies.json"] ?? files["./document.json"];
  if (!document) throw new Error("This ZIP is missing document.json.");
  let value: unknown;
  try {
    value = JSON.parse(strFromU8(document));
  } catch {
    throw new Error("This ZIP is not a valid Flies project.");
  }
  if (!value || typeof value !== "object" || !("nodes" in value) || !Array.isArray(value.nodes)) {
    throw new Error("This ZIP is missing project layers.");
  }
  const nodes = value.nodes.map((node) => {
    if (
      !node ||
      typeof node !== "object" ||
      !("kind" in node) ||
      (node.kind !== "image" && node.kind !== "svg")
    ) {
      return node;
    }
    const image = node as CanvasFrame & { src?: string };
    const src = image.src ?? "";
    if (src.startsWith("data:")) return node;
    const path = src.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!IMAGE_PATH.test(path)) {
      throw new Error("This ZIP contains an invalid image path.");
    }
    const file = files[path];
    if (!file) throw new Error("This ZIP is missing an image.");
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime) throw new Error("This ZIP contains an unsupported image.");
    return { ...image, src: `data:${mime};base64,${bytesToBase64(file)}` };
  });
  return parseCanvasProject(JSON.stringify({ ...value, nodes }));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
