import { CanvasDocument, type CanvasFrame } from "./canvas-document";

export const MAX_PROJECT_BYTES = 100 * 1024 * 1024;
export type CanvasProject = { name: string; nodes: CanvasFrame[] };

export function projectFilename(name: string, extension = "lra") {
  const safe = name
    .trim()
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\p{Cc}/gu, "-")
    .replace(/\.+$/, "")
    .slice(0, 120);
  return `${safe || "Untitled"}.${extension}`;
}

export function serializeCanvasProject(name: string, nodes: readonly CanvasFrame[]): string {
  return JSON.stringify({ type: "lra-design", version: 1, name: name.trim() || "Untitled", nodes });
}

/** Validate the complete file before replacing the current document. */
export function parseCanvasProject(source: string): CanvasProject {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("This file is not valid JSON. Open a Flies JSON project.");
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
    throw new Error(
      "This project format is not supported. Open a version 1 Flies JSON or .lra project.",
    );
  if (
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length > 1000 ||
    !("nodes" in value) ||
    !Array.isArray(value.nodes)
  )
    throw new Error("This project is incomplete. Its name or layers are missing.");
  try {
    const document = new CanvasDocument(value.nodes as CanvasFrame[]);
    return { name: value.name.trim() || "Untitled", nodes: document.getCommittedFrames() };
  } catch {
    throw new Error(
      "This project contains invalid layers or frame nesting. Your current canvas has been kept.",
    );
  }
}

export function downloadCanvasFile(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
