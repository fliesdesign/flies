import {
  worldTransform,
  transformPoint,
  inverseMatrix,
  getClippingAncestors,
  type CanvasDocument,
  type CanvasFrame,
} from "@flies/canvas";

import { measureCanvasTextHeight } from "@/components/canvas/canvas-node-content";

export type HtmlWarning = {
  code: "text_overflow" | "clipped_text";
  nodeName: string;
  nodeId?: string;
  message: string;
  suggestion: string;
  requiredHeight?: number;
  ancestorName?: string;
  ancestorId?: string;
};

/** Diagnose the resulting native layers, including clips outside the imported subtree. */
export function htmlWarnings(
  document: CanvasDocument,
  nodes: readonly CanvasFrame[],
  validateOnly = false,
): HtmlWarning[] {
  const warnings: HtmlWarning[] = [];

  for (const node of nodes) {
    if (node.kind !== "text" || !node.text.trim() || document.isHidden(node.id)) continue;
    let ancestor: CanvasFrame | undefined = node;
    let transparent = false;

    while (ancestor) {
      if (ancestor.opacity === 0) {
        transparent = true;
        break;
      }

      ancestor = ancestor.parentId ? document.getFrame(ancestor.parentId) : undefined;
    }

    if (transparent) continue;
    const requiredHeight = measureCanvasTextHeight(node);

    const reference = {
      nodeName: node.name,
      ...(!validateOnly && { nodeId: node.id }),
    };

    // Browser/native measurements round fractional pixels differently.
    if (requiredHeight > node.height + 1) {
      warnings.push({
        ...reference,
        code: "text_overflow",
        requiredHeight,
        message: `Text in "${node.name}" needs ${requiredHeight}px height, but its native text box is ${Math.round(node.height * 100) / 100}px high. Some text may be cut off.`,
        suggestion:
          "Inspect with get_screenshot after applying. If the crop is unintended, increase the text height with update_node (at least requiredHeight) or reimport with enough space; then fit_node on its container if needed.",
      });
    }

    // Ignore unused height in a generously sized text box. Its own overflow is reported above.
    const visibleHeight = Math.min(node.height, requiredHeight);

    const matrix = worldTransform(document, node);

    const corners = [
      { x: 0, y: 0 },
      { x: node.width, y: 0 },
      { x: node.width, y: visibleHeight },
      { x: 0, y: visibleHeight },
    ].map((point) => transformPoint(matrix, point));

    const clippingParent = getClippingAncestors(document, node).find((parent) => {
      const inverse = inverseMatrix(worldTransform(document, parent));

      return corners.some((point) => {
        const local = transformPoint(inverse, point);

        return (
          local.x < -1 || local.y < -1 || local.x > parent.width + 1 || local.y > parent.height + 1
        );
      });
    });

    if (clippingParent) {
      warnings.push({
        ...reference,
        code: "clipped_text",
        ancestorName: clippingParent.name,
        ...(!validateOnly && { ancestorId: clippingParent.id }),
        message: `Text layer "${node.name}" extends beyond clipping frame "${clippingParent.name}" and may be cut off.`,
        suggestion:
          "Inspect with get_screenshot after applying. If the crop is unintended, resize the clipping frame with update_node or fit_node, move the text inside it, or set clipContent:false on the frame when overflow should remain visible.",
      });
    }
  }

  return warnings;
}
