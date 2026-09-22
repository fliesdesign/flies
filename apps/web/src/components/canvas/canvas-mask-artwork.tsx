import {
  filterCss,
  rasterizeCanvasMask,
  EMPTY_CANVAS_MASK,
  useCanvasFrame,
  type CanvasCamera,
  type CanvasDocument,
  type CanvasFrame,
} from "@flies/canvas";
import {
  useCallback,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

const transparentMask = EMPTY_CANVAS_MASK as CSSProperties;

function MaskedArtwork({
  document,
  camera,
  frame,
  children,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  frame: CanvasFrame;
  children: ReactNode;
}) {
  const source = useCanvasFrame(document, frame.maskId ?? null);
  const zoom = useSyncExternalStore(camera.subscribe, () => camera.getSnapshot().viewport.zoom);
  const [mask, setMask] = useState<CSSProperties>(transparentMask);
  useEffect(() => {
    let active = true;

    if (!source || source.hidden) {
      return;
    }

    const target = document.getFrame(frame.id)!;
    void rasterizeCanvasMask(target, source, zoom * devicePixelRatio)
      .then((style) => {
        if (active) setMask(style as CSSProperties);
      })
      .catch(() => {
        if (active) setMask(transparentMask);
      });

    return () => {
      active = false;
    };
  }, [document, frame, source, zoom]);

  return (
    <div
      className="canvas-mask-artwork"
      style={{
        ...(!source || source.hidden ? transparentMask : mask),
        filter: filterCss(frame.filters),
      }}
    >
      {children}
    </div>
  );
}

export function CanvasMaskArtwork({
  document,
  camera,
  frame,
  editing,
  children,
}: {
  document: CanvasDocument;
  camera: CanvasCamera;
  frame: CanvasFrame;
  editing: boolean;
  children: ReactNode;
}) {
  const subscribe = useCallback(
    (listener: () => void) => document.subscribeFrame(frame.id, listener),
    [document, frame.id],
  );

  const source = useSyncExternalStore(
    subscribe,
    () => document.isMaskSource(frame.id),
    () => false,
  );

  if (source && !editing)
    return (
      <div className="canvas-mask-artwork" style={{ opacity: 0 }}>
        {children}
      </div>
    );
  if (frame.maskId)
    return (
      <MaskedArtwork document={document} camera={camera} frame={frame}>
        {children}
      </MaskedArtwork>
    );

  return (
    <div className="canvas-mask-artwork" style={{ filter: filterCss(frame.filters) }}>
      {children}
    </div>
  );
}
