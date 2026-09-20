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
import { createShadowSprite } from "./canvas-gpu-shadows";

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
  image?: HTMLImageElement;
  imageAbort?: AbortController;
  imageSprite?: Sprite;
  outerShadow?: Sprite;
  innerShadow?: Sprite;
  opacityFilter?: AlphaFilter;
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
    case "image":
      return second.kind === "image" && first.src === second.src;
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
    wordWrapWidth: frame.width,
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
    // Detach nodes first: each owns its own resources, never its descendant nodes.
    for (const node of this.nodes.values()) node.outer.removeFromParent();
    for (const node of this.nodes.values()) this.destroyNode(node);
    this.nodes.clear();
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
    if (opacity < 1 && opacity > 0) {
      if (!node.opacityFilter) {
        node.opacityFilter = new AlphaFilter();
        node.outer.filters = [node.opacityFilter];
      }
      node.opacityFilter.alpha = opacity;
    } else if (node.opacityFilter) {
      node.outer.filters = [];
      node.opacityFilter.destroy();
      node.opacityFilter = undefined;
    }
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
      const width = Math.max(1, size.x);
      const height = Math.max(1, size.y);
      if (width !== this.lastWidth || height !== this.lastHeight) {
        this.lastWidth = width;
        this.lastHeight = height;
        this.renderer.resize(width, height, this.resolution);
      }
      this.world.position.set(viewport.x, viewport.y);
      this.world.scale.set(viewport.zoom);
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
    node.outer.position.set(frame.x - (parent?.x ?? 0), frame.y - (parent?.y ?? 0));
    node.outer.visible = !frame.hidden && (frame.opacity ?? 1) > 0;
    this.updateOpacity(node, frame.opacity ?? 1);
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
      node.body.addChild(shape(new Graphics(), frame).fill(color));
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
    } else if (frame.kind === "image") {
      this.addImage(node, frame);
    }
  }

  private addText(node: Artwork, frame: CanvasText) {
    const style = textStyle(frame);
    const content = frame.text.replace(/\t/g, "    ");
    const metrics = CanvasTextMetrics.measureText(content, style);
    const textureWidth = Math.max(1, metrics.width);
    const textureHeight = Math.max(1, metrics.height);
    const resolution = Math.min(
      this.resolution,
      4096 / textureWidth,
      4096 / textureHeight,
      Math.sqrt(8_000_000 / (textureWidth * textureHeight)),
    );
    const text = new Text({ text: content, style, resolution });
    // Pixi aligns lines within the longest line; CSS aligns within the text node's full width.
    const alignment = frame.textAlign === "center" ? 0.5 : frame.textAlign === "right" ? 1 : 0;
    text.x = (frame.width - metrics.maxLineWidth) * alignment;
    node.body.addChild(text);
    if (frame.textDecoration && frame.textDecoration !== "none") {
      const lines = new Graphics();
      const lineHeight = frame.fontSize * (frame.lineHeight ?? 1.25);
      const ascent = metrics.fontProperties.ascent;
      const lineOffset = (lineHeight - metrics.fontProperties.fontSize) / 2;
      const baseline = lineOffset + ascent;
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

  private addImage(node: Artwork, frame: Extract<CanvasFrame, { kind: "image" }>) {
    if (!RASTER_DATA_URL.test(frame.src))
      throw new Error("Canvas images must be embedded raster images.");
    const image = new Image();
    node.image = image;
    node.imageSource = frame.src;
    const abort = new AbortController();
    node.imageAbort = abort;
    image.addEventListener(
      "load",
      () => {
        if (this.destroyed || node.image !== image) return;
        try {
          const texture = Texture.from(image, true);
          const sprite = new Sprite(texture);
          const current = this.options.document.getFrame(frame.id);
          if (!current || current.kind !== "image" || current.src !== frame.src) {
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
    if (frame.kind === "text" || frame.kind === "image") {
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
    if (node.image) {
      node.imageAbort?.abort();
      node.imageAbort = undefined;
      node.image.src = "";
      node.image = undefined;
    }
    node.imageSource = undefined;
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
    node.outer.filters = [];
    node.children.removeChildren();
    node.outer.destroy({ children: true });
  }
}
