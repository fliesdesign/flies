import type { FillGradient, Filter } from "pixi.js";
import {
  AlphaFilter,
  CanvasTextMetrics,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
  WebGPURenderer,
} from "pixi.js";

import { agentActivity } from "../activity";
import { AnimationFrameBatch, type CanvasCamera } from "../canvas-camera";
import type {
  CanvasDocument,
  CanvasFrame,
  CanvasFrameNode,
  CanvasShadow,
  CanvasText,
} from "../canvas-document";
import { ensureCanvasFont, fontFamilyCss } from "../canvas-fonts";
import { viewportBounds } from "../canvas-spatial-index";
import { SVG_DATA_URL } from "../canvas-svg";
import { localTransform, worldBounds } from "../canvas-transform";
import { gpuGradient, destroyPaintFilter, gpuFilters, gpuBlend } from "./canvas-gpu-paint";
import { createShadowSprite } from "./canvas-gpu-shadows";
import { textRasterResolution } from "./canvas-text-raster";

type RendererOptions = {
  canvas: HTMLCanvasElement;
  document: CanvasDocument;
  camera: CanvasCamera;
  onError: (error: unknown) => void;
};

type Artwork = {
  outer: Container;
  body: Container;
  children: Container;
  decoration: Container;
  contentMask: Graphics;
  childrenMask: Graphics;
  frame: CanvasFrame;
  initialized: boolean;
  imageSource?: string;
  svgScale?: number;
  image?: HTMLImageElement;
  imageAbort?: AbortController;
  imageSprite?: Sprite;
  text?: Text;
  textRasterSize?: { width: number; height: number };
  outerShadow?: Sprite;
  innerShadow?: Sprite;
  opacityFilter?: AlphaFilter;
  paintFilters?: Filter[];
  gradient?: FillGradient;
  filterZoom?: number;
  compositing?: boolean;
  unsubscribe: () => void;
};

const DEFAULT_ARTBOARD_SHADOW: readonly CanvasShadow[] = [
  { offsetX: 0, offsetY: 2, blur: 8, spread: 0, color: "#0000001a" },
];

const EMPTY_SHADOWS: readonly CanvasShadow[] = [];
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i;

function isFrame(frame: CanvasFrame): frame is CanvasFrameNode {
  return !frame.kind || frame.kind === "frame";
}

function sameVisual(first: CanvasFrame, second: CanvasFrame) {
  if (
    first.kind !== second.kind ||
    first.width !== second.width ||
    first.height !== second.height ||
    JSON.stringify(first.gradient) !== JSON.stringify(second.gradient) ||
    first.cornerRadius !== second.cornerRadius
  )
    return false;

  switch (first.kind) {
    case "text":
      return (
        second.kind === "text" &&
        first.text === second.text &&
        first.fontFamily === second.fontFamily &&
        first.fontSize === second.fontSize &&
        first.fontWeight === second.fontWeight &&
        first.fontStyle === second.fontStyle &&
        first.lineHeight === second.lineHeight &&
        first.letterSpacing === second.letterSpacing &&
        first.textAlign === second.textAlign &&
        first.textDecoration === second.textDecoration &&
        first.color === second.color
      );
    case "svg":
    case "image":
      return second.kind === first.kind && first.src === second.src;
    case "pen":
      return (
        second.kind === "pen" &&
        first.points === second.points &&
        first.pathWidth === second.pathWidth &&
        first.pathHeight === second.pathHeight &&
        first.stroke === second.stroke &&
        first.strokeWidth === second.strokeWidth
      );
    case "group":
      return true;
    default:
      return (isFrame(second) || second.kind === "rectangle") && first.fill === second.fill;
  }
}

function sameAppearance(first: CanvasFrame, second: CanvasFrame) {
  return (
    first.kind === second.kind &&
    first.width === second.width &&
    first.height === second.height &&
    first.cornerRadius === second.cornerRadius &&
    first.borderWidth === second.borderWidth &&
    first.borderColor === second.borderColor &&
    first.shadows === second.shadows &&
    Boolean(first.parentId) === Boolean(second.parentId) &&
    (!isFrame(first) || (isFrame(second) && first.clipContent === second.clipContent))
  );
}

function shape(graphics: Graphics, frame: CanvasFrame) {
  return graphics.roundRect(
    0,
    0,
    frame.width,
    frame.height,
    Math.max(0, Math.min(frame.cornerRadius ?? 0, frame.width / 2, frame.height / 2)),
  );
}

function destroySprite(sprite: Sprite | undefined) {
  sprite?.destroy({ texture: true, textureSource: true });
}

function textStyle(frame: CanvasText) {
  return new TextStyle({
    fontFamily: frame.fontFamily ?? "Arial",
    fontSize: frame.fontSize,
    fontWeight: String(frame.fontWeight ?? 400) as "400" | "500" | "600" | "700",
    fontStyle: frame.fontStyle ?? "normal",
    fill: frame.color,
    lineHeight: frame.fontSize * (frame.lineHeight ?? 1.25),
    letterSpacing: frame.letterSpacing ?? 0,
    align: frame.textAlign ?? "left",
    wordWrap: true,
    // DOM widths include trailing letter spacing. Pixi adds spacing to its wrap
    // boundary, which otherwise wraps tightly measured negative-tracking text.
    wordWrapWidth: frame.width - Math.min(0, frame.letterSpacing ?? 0),
    breakWords: true,
    whiteSpace: "pre",
    trim: false,
  });
}

/** Retained artwork, explicit WebGPU, and no continuous ticker or DOM snapshots. */
export class CanvasGpuRenderer {
  private readonly world = new Container({
    isRenderGroup: true,
    eventMode: "none",
    interactiveChildren: false,
  });

  private readonly nodes = new Map<string, Artwork>();
  private readonly dirty = new Set<string>();
  private readonly batch = new AnimationFrameBatch(() => this.render());
  private readonly unsubscribers: (() => void)[] = [];
  private editingId: string | null = null;
  private readonly fades = new Map<string, number>();
  private lastActivityChange = "";
  private destroyed = false;
  private readonly fontLoads = new Map<string, string>();
  private readonly textBaselines = new Map<string, number>();
  private hierarchyDirty = true;
  private documentRenderPending = false;
  private lastWidth = 0;
  private lastHeight = 0;

  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly options: RendererOptions,
    private readonly resolution: number,
  ) {
    this.unsubscribers.push(
      options.camera.subscribe(this.renderCamera),
      agentActivity(options.document).subscribe(this.updateActivity),
      options.document.subscribe(() => {
        this.hierarchyDirty = true;
        this.requestDocumentRender();
      }),
    );
    void renderer.gpu.device.lost.then((reason) => {
      if (!this.destroyed) this.fail(new Error(`WebGPU device lost: ${reason.message}`));

      return undefined;
    });
    renderer.gpu.device.addEventListener("uncapturederror", this.handleDeviceError);
  }

  static async create(options: RendererOptions): Promise<CanvasGpuRenderer> {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("WebGPU is unavailable on this device.");
    const device = await adapter.requestDevice();
    const renderer = new WebGPURenderer();
    const resolution = Math.min(window.devicePixelRatio || 1, 2);
    let instance: CanvasGpuRenderer | undefined;

    try {
      await renderer.init({
        canvas: options.canvas,
        gpu: { adapter, device },
        width: Math.max(1, options.camera.getCurrent().size.x),
        height: Math.max(1, options.camera.getCurrent().size.y),
        resolution,
        autoDensity: true,
        antialias: true,
        backgroundAlpha: 0,
        clearBeforeRender: true,
        eventMode: "none",
        eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
        gcActive: false,
      });
      instance = new CanvasGpuRenderer(renderer, options, resolution);
      instance.render(true);

      return instance;
    } catch (error) {
      if (instance) instance.destroy();
      else {
        // A partially initialized renderer may not have all systems available yet.
        try {
          renderer.destroy(false);
        } catch {
          /* Keep the original initialization error. */
        }

        device.destroy();
      }

      throw error;
    }
  }

  private renderCamera = () => {
    if (this.destroyed) return;
    // Camera publication is already animation-frame batched. Draw alongside DOM chrome.
    this.batch.cancel();
    this.render();
  };

  private requestDocumentRender = () => {
    if (this.destroyed || this.documentRenderPending) return;
    this.documentRenderPending = true;
    // A transaction/preview installs every node before notifying subscribers. Collapse
    // its notifications without adding another frame after the pointer gesture's rAF.
    queueMicrotask(() => {
      this.documentRenderPending = false;
      if (this.destroyed || (!this.hierarchyDirty && this.dirty.size === 0)) return;
      this.batch.cancel();
      this.render();
    });
  };

  requestRender = () => {
    if (!this.destroyed) this.batch.schedule();
  };

  setEditingId(id: string | null) {
    if (id === this.editingId) return;
    if (this.editingId) this.dirty.add(this.editingId);
    this.editingId = id;
    if (id) this.dirty.add(id);
    this.requestDocumentRender();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.batch.cancel();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    const device = this.renderer.gpu.device;
    device.removeEventListener("uncapturederror", this.handleDeviceError);
    // Filters retain uniform-batch buffers. Release their bindings before the
    // renderer destroys those buffers (its pipes are torn down before systems).
    this.renderer.filter.destroy();
    // Detach nodes first: each owns its own resources, never its descendant nodes.
    for (const node of this.nodes.values()) node.outer.removeFromParent();
    for (const node of this.nodes.values()) this.destroyNode(node);
    this.nodes.clear();
    this.fontLoads.clear();
    this.textBaselines.clear();
    this.world.destroy();
    this.renderer.destroy(false);
    device.destroy();
  }

  private handleDeviceError = (event: GPUUncapturedErrorEvent) => {
    this.fail(new Error(event.error.message));
  };

  private fail(error: unknown) {
    if (this.destroyed) return;
    this.destroy();
    this.options.onError(error);
  }

  private updateActivity = () => {
    const activity = agentActivity(this.options.document).getSnapshot();
    if (!activity?.changedIds.length || Date.now() - activity.changedAt > 600) return;
    const change = `${activity.sequence}:${activity.changedAt}`;
    if (change === this.lastActivityChange) return;
    this.lastActivityChange = change;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const id of this.options.document.getRootIds(activity.changedIds)) {
      this.fades.set(id, performance.now());
    }

    this.requestRender();
  };

  private updateOpacity(node: Artwork, opacity: number) {
    if (!node.opacityFilter) return;
    node.opacityFilter.alpha = opacity;

    const enabled =
      opacity < 1 ||
      !node.frame.kind ||
      node.frame.kind === "frame" ||
      node.frame.kind === "group" ||
      Boolean(node.paintFilters?.length);

    if (enabled !== node.compositing) {
      const paint = node.paintFilters ?? [];
      const blend = node.frame.blendMode ?? "normal";
      node.outer.filters = enabled
        ? [
            ...paint.slice(0, blend === "normal" ? undefined : -1),
            node.opacityFilter,
            ...(blend === "normal" ? [] : paint.slice(-1)),
          ]
        : [];
      node.compositing = enabled;
    }
  }

  private updatePaint(node: Artwork, frame: CanvasFrame) {
    const zoom = this.options.camera.getCurrent().viewport.zoom;
    if (
      node.initialized &&
      node.filterZoom === zoom &&
      node.frame.filters === frame.filters &&
      node.frame.blendMode === frame.blendMode
    )
      return;
    node.outer.filters = [];
    node.paintFilters?.forEach(destroyPaintFilter);
    node.opacityFilter?.destroy();
    // Every isolated frame/group passes through this filter. Pixi defaults to
    // 1x with antialiasing off, which would flatten Retina artwork to low DPI.
    node.opacityFilter = new AlphaFilter({
      alpha: frame.opacity ?? 1,
      resolution: "inherit",
      antialias: "inherit",
    });
    node.paintFilters = gpuFilters(frame.filters, zoom);
    const blend = frame.blendMode ?? "normal";
    if (blend !== "normal") node.paintFilters.push(gpuBlend(blend));

    for (const filter of node.paintFilters) {
      filter.resolution = "inherit";
      filter.antialias = "inherit";
    }

    // Composite children as one isolated layer, apply appearance filters, opacity, then blending.
    node.outer.filters = [
      ...node.paintFilters.slice(0, blend === "normal" ? undefined : -1),
      node.opacityFilter,
      ...(blend === "normal" ? [] : node.paintFilters.slice(-1)),
    ];
    node.compositing = true;
    node.filterZoom = zoom;
  }

  private render(initial = false) {
    if (this.destroyed) return;

    try {
      if (this.hierarchyDirty) this.reconcile();

      for (const id of this.dirty) {
        const node = this.nodes.get(id);
        const frame = this.options.document.getFrame(id);
        if (node && frame) this.updateNode(node, frame);
      }

      this.dirty.clear();

      for (const [id, started] of this.fades) {
        const node = this.nodes.get(id);

        if (!node) {
          this.fades.delete(id);
          continue;
        }

        const progress = Math.min(1, (performance.now() - started) / 320);
        const multiplier = 0.25 + 0.75 * (1 - (1 - progress) ** 3);
        this.updateOpacity(node, (node.frame.opacity ?? 1) * multiplier);
        if (progress === 1) this.fades.delete(id);
      }

      const { viewport, size } = this.options.camera.getCurrent();

      const visible = viewportBounds(viewport, size, 32);

      for (const node of this.nodes.values()) {
        if (node.text && node.textRasterSize && !this.options.document.isHidden(node.frame.id)) {
          const resolution = textRasterResolution(
            node.textRasterSize.width,
            node.textRasterSize.height,
            this.resolution,
            viewport.zoom,
          );

          // Keep sharper textures when zooming out. Panning never recreates them,
          // and distant labels only upgrade when they enter the viewport.
          if (resolution > (node.text.resolution ?? 0)) {
            const bounds = worldBounds(this.options.document, node.frame);
            if (
              bounds.x + bounds.width >= visible.x &&
              bounds.y + bounds.height >= visible.y &&
              bounds.x <= visible.x + visible.width &&
              bounds.y <= visible.y + visible.height
            )
              node.text.resolution = resolution;
          }
        }

        if (node.frame.kind === "svg" && (node.svgScale ?? 0) < this.svgRasterScale(node.frame)) {
          this.updateBody(node, node.frame);
        }
      }

      const width = Math.max(1, size.x);
      const height = Math.max(1, size.y);

      if (width !== this.lastWidth || height !== this.lastHeight) {
        this.lastWidth = width;
        this.lastHeight = height;
        this.renderer.resize(width, height, this.resolution);
      }

      this.world.position.set(viewport.x, viewport.y);
      this.world.scale.set(viewport.zoom);
      for (const node of this.nodes.values())
        if (node.frame.filters?.blur && node.filterZoom !== viewport.zoom)
          this.updatePaint(node, node.frame);
      this.renderer.render({ container: this.world });
      if (this.fades.size) this.requestRender();
    } catch (error) {
      if (initial) throw error;
      this.fail(error);
    }
  }

  private reconcile() {
    this.hierarchyDirty = false;
    const ids = this.options.document.getIds();
    const membership = new Set(ids);

    for (const [id, node] of this.nodes) {
      if (!membership.has(id)) {
        node.outer.removeFromParent();
        // Surviving children may have been reparented in this transaction.
        node.children.removeChildren();
        this.destroyNode(node);
        this.nodes.delete(id);
        this.fontLoads.delete(id);
      }
    }

    for (const id of ids) {
      const frame = this.options.document.getFrame(id)!;
      let node = this.nodes.get(id);

      if (!node) {
        node = this.createNode(frame);
        this.nodes.set(id, node);
        this.dirty.add(id);
      }

      if (node.frame !== frame) this.dirty.add(id);
      const parent = frame.parentId ? this.nodes.get(frame.parentId)?.children : this.world;
      if (parent && node.outer.parent !== parent) parent.addChild(node.outer);
    }

    // Document ids are in paint order; sibling ordering changes need no resource rebuilds.
    const positions = new Map<Container, number>();

    for (const id of ids) {
      const node = this.nodes.get(id)!;
      const parent = node.outer.parent;
      if (!parent) continue;
      const index = positions.get(parent) ?? 0;
      if (parent.children[index] !== node.outer) parent.setChildIndex(node.outer, index);
      positions.set(parent, index + 1);
    }
  }

  private createNode(frame: CanvasFrame): Artwork {
    const outer = new Container({ eventMode: "none", interactiveChildren: false });
    const body = new Container();
    const children = new Container();
    const decoration = new Container();
    const contentMask = new Graphics();
    const childrenMask = new Graphics();
    outer.addChild(body, children, decoration, contentMask, childrenMask);

    const node: Artwork = {
      outer,
      body,
      children,
      decoration,
      contentMask,
      childrenMask,
      frame,
      initialized: false,
      unsubscribe: this.options.document.subscribeFrame(frame.id, () => {
        this.dirty.add(frame.id);
        // Child transforms are relative even though document bounds are world coordinates.
        for (const childId of this.options.document.getChildren(frame.id)) this.dirty.add(childId);
        this.requestDocumentRender();
      }),
    };

    return node;
  }

  private updateNode(node: Artwork, frame: CanvasFrame) {
    const parent = frame.parentId ? this.options.document.getFrame(frame.parentId) : undefined;
    const matrix = localTransform(frame, parent);
    node.outer.position.set(matrix.e, matrix.f);
    node.outer.rotation = ((frame.rotation ?? 0) * Math.PI) / 180;
    this.updatePaint(node, frame);
    node.outer.visible = !frame.hidden && (frame.opacity ?? 1) > 0;
    const previous = node.frame;
    node.frame = frame;
    this.updateOpacity(node, frame.opacity ?? 1);
    node.frame = previous;
    node.body.visible = frame.id !== this.editingId || frame.kind !== "text";
    if (!node.initialized || !sameVisual(node.frame, frame)) this.updateBody(node, frame);
    if (!node.initialized || !sameAppearance(node.frame, frame)) this.updateAppearance(node, frame);
    node.initialized = true;
    node.frame = frame;
  }

  private updateBody(node: Artwork, frame: CanvasFrame) {
    if (frame.kind === "image" && node.imageSource === frame.src) {
      if (node.imageSprite) {
        node.imageSprite.width = frame.width;
        node.imageSprite.height = frame.height;
      }

      return;
    }

    this.clearBody(node);

    if (isFrame(frame) || frame.kind === "rectangle") {
      const color = "fill" in frame ? (frame.fill ?? "#ffffff") : "#ffffff";
      if (frame.gradient) node.gradient = gpuGradient(frame.gradient, frame.width, frame.height);
      if (frame.gradient?.background)
        node.body.addChild(shape(new Graphics(), frame).fill(frame.gradient.background));
      node.body.addChild(shape(new Graphics(), frame).fill(node.gradient ?? color));
    } else if (frame.kind === "text") {
      this.addText(node, frame);
    } else if (frame.kind === "pen") {
      const pen = new Graphics();
      const first = frame.points[0];

      if (first && frame.points.length === 1) {
        pen.circle(first.x, first.y, frame.strokeWidth / 2).fill(frame.stroke);
      } else if (first) {
        pen.moveTo(first.x, first.y);

        for (let index = 1; index < frame.points.length; index++) {
          pen.lineTo(frame.points[index].x, frame.points[index].y);
        }

        pen.stroke({ color: frame.stroke, width: frame.strokeWidth, cap: "round", join: "round" });
      }

      pen.scale.set(frame.width / frame.pathWidth, frame.height / frame.pathHeight);
      node.body.addChild(pen);
    } else if (frame.kind === "image" || frame.kind === "svg") {
      this.addImage(node, frame);
    }
  }

  /** Match CSS line-box rounding and font ascent, including tight line heights.
   * Measure once per typography style, never on camera movement. */
  private textBaseline(frame: CanvasText) {
    const lineHeight = frame.fontSize * (frame.lineHeight ?? 1.25);
    const key = `${frame.fontFamily}:${frame.fontSize}:${frame.fontWeight}:${frame.fontStyle}:${lineHeight}`;
    const cached = this.textBaselines.get(key);
    if (cached !== undefined) return cached;
    const measurement = window.document.createElement("span");
    Object.assign(measurement.style, {
      position: "fixed",
      top: "0",
      left: "0",
      display: "block",
      visibility: "hidden",
      contain: "layout style",
      whiteSpace: "pre",
      padding: "0",
      margin: "0",
      border: "0",
      fontFamily: fontFamilyCss(frame.fontFamily),
      fontSize: `${frame.fontSize}px`,
      fontWeight: String(frame.fontWeight ?? 400),
      fontStyle: frame.fontStyle ?? "normal",
      lineHeight: `${lineHeight}px`,
    });
    const marker = window.document.createElement("span");
    Object.assign(marker.style, {
      display: "inline-block",
      width: "0",
      height: "0",
      verticalAlign: "baseline",
    });
    measurement.append("M", marker);
    window.document.body.append(measurement);
    const baseline = marker.getBoundingClientRect().top - measurement.getBoundingClientRect().top;
    measurement.remove();
    if (this.textBaselines.size >= 256)
      this.textBaselines.delete(this.textBaselines.keys().next().value!);
    this.textBaselines.set(key, baseline);

    return baseline;
  }

  private addText(node: Artwork, frame: CanvasText) {
    const fontKey = `${frame.fontFamily}:${frame.fontWeight}:${frame.fontStyle}:${frame.text}`;

    if (frame.fontFamily && this.fontLoads.get(frame.id) !== fontKey) {
      this.fontLoads.set(frame.id, fontKey);
      void ensureCanvasFont(frame)
        .then(() => {
          if (
            this.destroyed ||
            this.nodes.get(frame.id) !== node ||
            this.fontLoads.get(frame.id) !== fontKey
          )
            return false;
          CanvasTextMetrics.clearMetrics();
          this.textBaselines.clear();
          node.initialized = false;
          this.dirty.add(frame.id);
          this.requestDocumentRender();

          return true;
        })
        .catch(() => {
          /* The editor reports unavailable fonts and retains fallback artwork. */
        });
    }

    const style = textStyle(frame);
    const content = frame.text.replace(/\t/g, "    ");
    const metrics = CanvasTextMetrics.measureText(content, style);
    const textureWidth = Math.max(1, metrics.width);
    const textureHeight = Math.max(1, metrics.height);

    const resolution = textRasterResolution(textureWidth, textureHeight, this.resolution, 1);
    // Retained high-resolution glyphs need a filtered mip chain when zooming out;
    // bilinear sampling alone drops thin strokes and makes small labels shimmer.
    const text = new Text({ text: content, style, resolution, autoGenerateMipmaps: true });
    node.text = text;
    node.textRasterSize = { width: textureWidth, height: textureHeight };
    // Pixi aligns lines within the longest line; CSS aligns within the text node's full width.
    const alignment = frame.textAlign === "center" ? 0.5 : frame.textAlign === "right" ? 1 : 0;
    text.x = (frame.width - metrics.maxLineWidth) * alignment;
    const lineHeight = frame.fontSize * (frame.lineHeight ?? 1.25);
    const baseline = this.textBaseline(frame);

    const rasterBaseline =
      metrics.fontProperties.ascent +
      Math.max(0, (lineHeight - metrics.fontProperties.fontSize) / 2);

    text.y = baseline - rasterBaseline;
    node.body.addChild(text);

    if (frame.textDecoration && frame.textDecoration !== "none") {
      const lines = new Graphics();
      const ascent = metrics.fontProperties.ascent;
      const offset = frame.textDecoration === "underline" ? baseline + 1 : baseline - ascent * 0.35;
      metrics.lineWidths.forEach((width, index) => {
        lines.rect(
          (frame.width - width) * alignment,
          offset + index * lineHeight,
          width,
          Math.max(1, frame.fontSize / 16),
        );
      });
      lines.fill(frame.color);
      node.body.addChild(lines);
    }
  }

  private svgRasterScale(frame: CanvasFrame) {
    return Math.min(
      this.resolution * this.options.camera.getCurrent().viewport.zoom,
      4096 / Math.max(frame.width, frame.height),
      Math.sqrt(4_000_000 / (frame.width * frame.height)),
    );
  }

  private addImage(node: Artwork, frame: Extract<CanvasFrame, { kind: "image" | "svg" }>) {
    if (!(frame.kind === "svg" ? SVG_DATA_URL : RASTER_DATA_URL).test(frame.src))
      throw new Error("Canvas images must use embedded data URLs.");
    const image = new Image();
    if (frame.kind === "svg") node.svgScale = this.svgRasterScale(frame);
    node.image = image;
    node.imageSource = frame.src;
    const abort = new AbortController();
    node.imageAbort = abort;
    image.addEventListener(
      "load",
      () => {
        if (this.destroyed || node.image !== image) return;

        try {
          // Pixi's WebGPU uploader otherwise converts HTML images to canvas itself
          // and warns on every upload. Supply the supported resource directly.
          const raster = window.document.createElement("canvas");
          const scale = frame.kind === "svg" ? this.svgRasterScale(frame) : 1;
          raster.width =
            frame.kind === "svg" ? Math.max(1, Math.ceil(frame.width * scale)) : image.naturalWidth;
          raster.height =
            frame.kind === "svg"
              ? Math.max(1, Math.ceil(frame.height * scale))
              : image.naturalHeight;
          const context = raster.getContext("2d");
          if (!context) throw new Error("Unable to prepare canvas image texture.");
          context.drawImage(image, 0, 0, raster.width, raster.height);
          const texture = Texture.from(raster, true);
          const sprite = new Sprite(texture);
          const current = this.options.document.getFrame(frame.id);

          if (!current || current.kind !== frame.kind || current.src !== frame.src) {
            sprite.destroy({ texture: true, textureSource: true });

            return;
          }

          sprite.width = current.width;
          sprite.height = current.height;
          node.imageSprite = sprite;
          node.body.addChild(sprite);
          this.requestRender();
        } catch (error) {
          this.fail(error);
        }
      },
      { once: true, signal: abort.signal },
    );
    image.addEventListener(
      "error",
      () => {
        if (!this.destroyed && node.image === image)
          this.fail(new Error("Unable to decode canvas image."));
      },
      { once: true, signal: abort.signal },
    );
    image.src = frame.src;
  }

  private updateAppearance(node: Artwork, frame: CanvasFrame) {
    destroySprite(node.outerShadow);
    destroySprite(node.innerShadow);
    node.outerShadow = undefined;
    node.innerShadow = undefined;
    for (const child of node.decoration.removeChildren()) child.destroy();

    const shadows =
      frame.shadows ??
      (isFrame(frame) && !frame.parentId ? DEFAULT_ARTBOARD_SHADOW : EMPTY_SHADOWS);

    node.outerShadow = createShadowSprite(frame, shadows, false, this.resolution);
    if (node.outerShadow) node.outer.addChildAt(node.outerShadow, 0);
    node.innerShadow = createShadowSprite(frame, shadows, true, this.resolution);
    if (node.innerShadow) node.decoration.addChild(node.innerShadow);
    const borderWidth = frame.borderWidth ?? 0;

    if (borderWidth > 0) {
      const border = shape(new Graphics(), frame).stroke({
        width: borderWidth,
        color: frame.borderColor ?? "#000000",
        alignment: 1,
      });

      node.decoration.addChild(border);
    }

    node.contentMask.clear();
    if (frame.kind === "text" || frame.kind === "image" || frame.kind === "svg") {
      shape(node.contentMask, frame).fill("#fff");
      node.body.mask = node.contentMask;
    } else node.body.mask = null;
    node.childrenMask.clear();
    if (isFrame(frame) && frame.clipContent !== false) {
      shape(node.childrenMask, frame).fill("#fff");
      node.children.mask = node.childrenMask;
    } else node.children.mask = null;
  }

  private clearBody(node: Artwork) {
    node.gradient?.destroy();
    node.gradient = undefined;

    if (node.image) {
      node.imageAbort?.abort();
      node.imageAbort = undefined;
      node.image.src = "";
      node.image = undefined;
    }

    node.imageSource = undefined;
    node.text = undefined;
    node.textRasterSize = undefined;
    destroySprite(node.imageSprite);
    node.imageSprite = undefined;
    for (const child of node.body.removeChildren()) child.destroy();
  }

  private destroyNode(node: Artwork) {
    node.unsubscribe();
    this.clearBody(node);
    destroySprite(node.outerShadow);
    destroySprite(node.innerShadow);
    node.opacityFilter?.destroy();
    node.paintFilters?.forEach(destroyPaintFilter);
    node.outer.filters = [];
    node.children.removeChildren();
    node.outer.destroy({ children: true });
  }
}
