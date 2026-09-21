import { themeCss, type CanvasDocument } from "@flies/canvas";
import { validateSharedCss } from "@flies/html";
export { validateSharedCss } from "@flies/html";

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
