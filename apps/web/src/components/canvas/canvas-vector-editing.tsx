import {
  fitCanvasVectorNode,
  multiplyMatrix,
  updateCanvasVector,
  useCanvasFrame,
  worldTransform,
  type CanvasCamera,
  type CanvasDocument,
} from "@flies/canvas";
import { useSyncExternalStore } from "react";

import { CanvasVectorEditor } from "./canvas-vector-editor";

export function CanvasVectorEditing({
  document,
  camera,
  id,
  onClose,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  id: string;
  onClose: () => void;
}) {
  const node = useCanvasFrame(document, id);
  const { viewport } = useSyncExternalStore(camera.subscribe, camera.getSnapshot);
  if (node?.kind !== "svg" || !node.vector) return null;

  const transform = multiplyMatrix(
    { a: viewport.zoom, b: 0, c: 0, d: viewport.zoom, e: viewport.x, f: viewport.y },
    worldTransform(document, node),
  );

  return (
    <CanvasVectorEditor
      key={id}
      node={{ ...node, vector: node.vector }}
      transform={transform}
      onPreviewStart={() => document.beginGesture(id)}
      onPreview={(vector) => document.preview(updateCanvasVector(node, vector))}
      onPreviewEnd={(cancel) => {
        const current = document.getFrame(id);
        document.endGesture(
          cancel,
          !cancel && current?.kind === "svg" && current.vector
            ? [fitCanvasVectorNode(current, current.vector)]
            : [],
        );
      }}
      onCommit={(vector) => document.update(fitCanvasVectorNode(node, vector))}
      onClose={onClose}
    />
  );
}
