import { themeCss, type CanvasDocument } from "@flies/canvas";

export function validateSharedCss(value: unknown): string {
  if (typeof value !== "string" || value.length > 50_000)
    throw new Error("css must be a string of at most 50,000 characters.");
  if (/url\s*\(|\\|@import|@font-face|expression\s*\(|<\/style/i.test(value))
    throw new Error("Shared CSS must be self-contained. Use named fonts and embedded image nodes.");
  return value;
}

/** Nearest frame wins through the CSS cascade; metadata survives saves, copies and undo. */
export function inheritedStyles(document: CanvasDocument, nodeId?: string): string {
  const sheets: string[] = [];
  let node = nodeId ? document.getFrame(nodeId) : undefined;
  while (node) {
    if ((!node.kind || node.kind === "frame") && node.htmlStyles)
      sheets.unshift(validateSharedCss(node.htmlStyles));
    node = node.parentId ? document.getFrame(node.parentId) : undefined;
  }
  return [document.getTheme().tokens.length ? themeCss(document.getTheme()) : "", ...sheets].join(
    "\n",
  );
}
