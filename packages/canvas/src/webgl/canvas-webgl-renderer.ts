import { Firefly, parseColor, type Texture, type Filter } from "@flies/firefly";

import { agentActivity } from "../activity";
import { AnimationFrameBatch, type CanvasCamera } from "../canvas-camera";
import type { CanvasDocument, CanvasFrame } from "../canvas-document";
import { isCanvasRoot } from "../canvas-pages";
import { CANVAS_BLEND_MODES, CANVAS_FILTERS, canvasFilterOrder } from "../canvas-paint";
import { IDENTITY, localTransform, multiplyMatrix, type CanvasMatrix } from "../canvas-transform";
import { nodeRasterBounds, rasterizeNode } from "./canvas-raster";

type Options = {
  canvas: HTMLCanvasElement;
  document: CanvasDocument;
  camera: CanvasCamera;
  onError: (error: unknown) => void;
};
type Raster = Awaited<ReturnType<typeof rasterizeNode>>;
type Entry = {
  frame: CanvasFrame;
  root?: boolean;
  version: number;
  scale: number;
  body?: Texture;
  decoration?: Texture;
  bounds?: Omit<Raster, "body" | "decoration">;
  pending?: Promise<void>;
  unsubscribe: () => void;
  lastUsed: number;
};
const textureBudget = 128 * 1024 * 1024;

const transformFields = new Set([
  "x",
  "y",
  "rotation",
  "opacity",
  "filters",
  "blendMode",
  "parentId",
  "id",
  "name",
  "hidden",
  "locked",
  "layout",
  "widthSizing",
  "heightSizing",
  "tokenBindings",
  "htmlStyles",
]);

function sameRasterPaint(first: CanvasFrame, second: CanvasFrame) {
  if (first === second) return true;
  const before = first as unknown as Record<string, unknown>;
  const after = second as unknown as Record<string, unknown>;

  for (const key in before) {
    if (!transformFields.has(key) && before[key] !== after[key]) return false;
  }

  for (const key in after) {
    if (!transformFields.has(key) && before[key] !== after[key]) return false;
  }

  return true;
}

/** Firefly adapter: document state remains authoritative, GPU resources are disposable caches. */
export class CanvasWebglRenderer {
  private readonly device: Firefly;
  private readonly entries = new Map<string, Entry>();
  private readonly unsubscribers: (() => void)[] = [];
  private readonly batch = new AnimationFrameBatch(() => this.safeRender());
  private editingId: string | null = null;
  private disposed = false;
  private renderCount = 0;
  private renderMs = 0;
  private documentPending = false;
  private readonly fades = new Map<string, number>();
  private lastActivity = "";
  private extentDirty = true;
  private cachedExtent = 0;
  private readonly colors = new Map<string, ReturnType<typeof parseColor>>();

  private constructor(private readonly options: Options) {
    this.device = new Firefly(options.canvas, (error) => this.fail(error));
    this.syncEntries();
    this.unsubscribers.push(
      options.document.subscribe(() => {
        this.syncEntries();
        this.requestRender();

        return undefined;
      }),
      options.document.subscribeActivePage(() => {
        this.syncEntries();
        this.requestRender();

        return undefined;
      }),
      options.camera.subscribe(() => {
        this.batch.cancel();
        this.safeRender();
      }),
      agentActivity(options.document).subscribe(this.updateActivity),
    );
  }

  static async create(options: Options) {
    const instance = new CanvasWebglRenderer(options);

    try {
      instance.render();
      await instance.whenReady();
      options.canvas.dataset.renderer = "webgl2";

      return instance;
    } catch (error) {
      instance.destroy();
      throw error;
    }
  }

  async whenReady() {
    // Resources can change while fonts and images load. Resolve only a complete current frame.
    while (!this.disposed) {
      const pending = [...this.entries.values()].flatMap((entry) =>
        entry.pending ? [entry.pending] : [],
      );

      if (!pending.length) break;
      // Each generation discovers resources from the latest live document.
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all(pending);
      this.render();
    }
  }

  getStats() {
    return {
      renderCount: this.renderCount,
      renderMs: this.renderMs,
      drawCalls: this.device.drawCalls,
      textureUploads: this.device.textureUploads,
      textureBytes: this.device.textureBytes,
      pendingResources: [...this.entries.values()].filter((entry) => entry.pending).length,
      rasters: [...this.entries].flatMap(([id, entry]) =>
        entry.body
          ? [
              {
                id,
                resolution: entry.body.width / (entry.bounds?.width || entry.body.width),
                width: entry.body.width,
                height: entry.body.height,
                version: entry.version,
              },
            ]
          : [],
      ),
    };
  }

  setEditingId(id: string | null) {
    if (id === this.editingId) return;
    this.editingId = id;
    this.requestRender();
  }

  requestRender = () => {
    if (!this.disposed) this.batch.schedule();
  };

  private requestDocumentRender = () => {
    if (this.disposed || this.documentPending) return;
    this.documentPending = true;
    queueMicrotask(() => {
      this.documentPending = false;
      if (this.disposed) return;
      this.batch.cancel();
      this.safeRender();
    });
  };

  private updateActivity = () => {
    const activity = agentActivity(this.options.document).getSnapshot();
    if (!activity?.changedIds.length || Date.now() - activity.changedAt > 600) return;
    const key = `${activity.sequence}:${activity.changedAt}`;
    if (key === this.lastActivity || window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    this.lastActivity = key;
    for (const id of this.options.document.getRootIds(activity.changedIds))
      this.fades.set(id, performance.now());
    this.requestRender();
  };

  private syncEntries() {
    this.extentDirty = true;
    const ids = new Set(this.options.document.getSceneIds());

    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) {
        entry.unsubscribe();
        this.releaseRaster(entry);
        this.entries.delete(id);
      }
    }

    for (const id of ids) {
      if (this.entries.has(id)) continue;
      const frame = this.options.document.getFrame(id)!;
      this.entries.set(id, {
        frame,
        version: 0,
        scale: 0,
        lastUsed: 0,
        unsubscribe: this.options.document.subscribeFrame(id, () => {
          const current = this.options.document.getFrame(id);
          const entry = this.entries.get(id);
          if (
            entry &&
            (current?.filters !== entry.frame.filters || current?.parentId !== entry.frame.parentId)
          )
            this.extentDirty = true;
          this.requestDocumentRender();
        }),
      });
    }
  }

  private safeRender() {
    if (this.disposed) return;

    try {
      this.render();
    } catch (error) {
      this.fail(error);
    }
  }

  private render() {
    if (this.disposed) return;
    const started = performance.now();
    const { viewport, size } = this.options.camera.getCurrent();
    const ratio = window.devicePixelRatio || 1;
    this.device.resize(size.x, size.y, ratio, Math.ceil(this.effectExtent() * viewport.zoom));
    this.device.begin();
    this.renderCount++;

    const camera: CanvasMatrix = {
      a: viewport.zoom,
      b: 0,
      c: 0,
      d: viewport.zoom,
      e: viewport.x + this.device.effectPadding,
      f: viewport.y + this.device.effectPadding,
    };

    for (const id of this.options.document.getChildren())
      this.paintNode(id, IDENTITY, camera, viewport.zoom * ratio);
    this.device.present();
    this.trimCache();
    this.renderMs = performance.now() - started;
    this.options.canvas.dataset.renderCount = String(this.renderCount);
    this.options.canvas.dataset.pendingResources = String(
      [...this.entries.values()].filter((entry) => entry.pending).length,
    );
  }

  private paintNode(id: string, parentMatrix: CanvasMatrix, camera: CanvasMatrix, scale: number) {
    const document = this.options.document;
    const frame = document.getFrame(id);
    const entry = this.entries.get(id);
    if (!frame || !entry || frame.hidden || frame.kind === "page") return;
    const parent = frame.parentId ? document.getFrame(frame.parentId) : undefined;

    const matrix = multiplyMatrix(
      parentMatrix,
      localTransform(frame, parent?.kind === "page" ? undefined : parent),
    );

    const screen = multiplyMatrix(camera, matrix);
    const children = document.getChildren(id);
    const clips = (!frame.kind || frame.kind === "frame") && frame.clipContent !== false;
    const root = isCanvasRoot(document, frame);
    const rect = { x: 0, y: 0, width: frame.width, height: frame.height };
    const visible = this.visible(frame, screen, root);
    if (!visible && (clips || !children.length)) return;
    entry.lastUsed = this.renderCount;

    const filters: Filter[] = frame.filters
      ? canvasFilterOrder(frame.filters).flatMap((kind) => {
          const amount = frame.filters?.[kind];

          return amount === undefined || amount === CANVAS_FILTERS[kind].initial
            ? []
            : [{ kind, amount }];
        })
      : [];

    let opacity = frame.opacity ?? 1;
    const fade = this.fades.get(id);

    if (fade !== undefined) {
      const progress = Math.min(1, (performance.now() - fade) / 450);
      opacity *= 0.45 + 0.55 * (1 - (1 - progress) ** 3);
      if (progress === 1) this.fades.delete(id);
      else this.requestRender();
    }

    if (opacity <= 0) return;
    const blend = CANVAS_BLEND_MODES.indexOf(frame.blendMode ?? "normal");

    const isolatesBlend = children.some((childId) => {
      const child = document.getFrame(childId);

      return child?.blendMode && child.blendMode !== "normal";
    });

    const simple =
      (frame.kind === "rectangle" || frame.kind === "frame" || !frame.kind) &&
      !frame.gradient &&
      !frame.borderWidth &&
      !frame.shadows?.length &&
      !(root && frame.kind !== "rectangle" && frame.shadows === undefined);

    const empty = frame.kind === "group" && !frame.borderWidth && !frame.shadows?.length;
    if (empty && entry.body) this.releaseRaster(entry);

    const leafOpacity =
      !children.length && !frame.borderWidth && !frame.shadows?.some((shadow) => shadow.inset);

    const composite =
      (opacity < 1 && !leafOpacity) || blend > 0 || filters.length > 0 || isolatesBlend;

    const destination = this.device.getTarget();
    let layer = composite ? this.device.acquire() : undefined;

    if (layer) {
      this.device.target(layer);
      this.device.clear();
    }

    if (visible && !empty) {
      if (simple) {
        if (entry.body) this.releaseRaster(entry);
        const fill = frame.fill ?? "#ffffff";
        let color = this.colors.get(fill);

        if (!color) {
          color = parseColor(fill);
          this.colors.set(fill, color);
        }

        this.device.rect(rect, screen, color, frame.cornerRadius, layer ? 1 : opacity);
      } else {
        this.prepareRaster(entry, frame, scale, root);
        if (entry.body && entry.bounds && id !== this.editingId)
          this.device.image(entry.body, entry.bounds, screen, layer ? 1 : opacity);
      }
    }

    if (clips && children.length) this.device.clip(rect, screen, frame.cornerRadius ?? 0, true);
    for (const childId of children) this.paintNode(childId, matrix, camera, scale);
    if (clips && children.length) this.device.clip(rect, screen, frame.cornerRadius ?? 0, false);
    if (!simple && !empty && visible && entry.decoration && entry.bounds)
      this.device.image(entry.decoration, entry.bounds, screen);

    if (layer) {
      if (filters.length) layer = this.device.filter(layer, filters, camera.a);
      this.device.target(destination.surface, destination.depth);
      this.device.composite(layer, opacity, Math.max(0, blend));
      this.device.release(layer);
    }
  }

  /** Include all nested filter tails in the offscreen working area before cropping to the viewport. */
  private effectExtent() {
    if (!this.extentDirty) return this.cachedExtent;
    const document = this.options.document;
    const extents = new Map<string, number>();

    const extent = (frame: CanvasFrame): number => {
      const cached = extents.get(frame.id);
      if (cached !== undefined) return cached;
      const parent = frame.parentId ? document.getFrame(frame.parentId) : undefined;
      const value = (frame.filters?.blur ?? 0) * 3 + (parent ? extent(parent) : 0);
      extents.set(frame.id, value);

      return value;
    };

    let maximum = 0;

    for (const id of this.entries.keys()) {
      const frame = document.getFrame(id);
      if (frame) maximum = Math.max(maximum, extent(frame));
    }

    this.extentDirty = false;
    this.cachedExtent = maximum;

    return maximum;
  }

  private visible(frame: CanvasFrame, m: CanvasMatrix, root: boolean) {
    const bounds = nodeRasterBounds(frame, root);
    const padding = 2;

    const points = [
      [bounds.x - padding, bounds.y - padding],
      [bounds.x + bounds.width + padding, bounds.y - padding],
      [bounds.x - padding, bounds.y + bounds.height + padding],
      [bounds.x + bounds.width + padding, bounds.y + bounds.height + padding],
    ];

    const xs = points.map(([x, y]) => m.a * x + m.c * y + m.e);
    const ys = points.map(([x, y]) => m.b * x + m.d * y + m.f);
    const { size } = this.options.camera.getCurrent();
    const overscan = this.device.effectPadding * 2;

    return (
      Math.max(...xs) >= 0 &&
      Math.max(...ys) >= 0 &&
      Math.min(...xs) <= size.x + overscan &&
      Math.min(...ys) <= size.y + overscan
    );
  }

  private prepareRaster(entry: Entry, frame: CanvasFrame, scale: number, root: boolean) {
    const desired = Math.min(
      16,
      2 ** (Math.ceil(Math.log2(Math.max(frame.kind === "text" ? 0.5 : 0.125, scale)) * 2) / 2),
    );

    // Position-only gestures reuse immutable paint values without copying embedded image data.
    if (
      entry.body &&
      entry.root === root &&
      entry.scale >= desired &&
      sameRasterPaint(entry.frame, frame)
    ) {
      entry.frame = frame;

      return;
    }

    if (entry.pending) return;
    entry.pending = rasterizeNode(frame, desired, root)
      .then((raster) => {
        if (this.disposed || this.entries.get(frame.id) !== entry) return;
        this.releaseRaster(entry);
        entry.body = this.device.texture(raster.body);
        if (raster.decoration) entry.decoration = this.device.texture(raster.decoration);
        entry.bounds = { x: raster.x, y: raster.y, width: raster.width, height: raster.height };
        entry.frame = frame;
        entry.root = root;
        entry.scale = desired;
        entry.version++;
        entry.pending = undefined;
        this.requestRender();

        return undefined;
      })
      .catch((error) => {
        entry.pending = undefined;
        this.fail(error);
      });
  }

  private releaseRaster(entry: Entry) {
    if (entry.body) this.device.deleteTexture(entry.body);
    if (entry.decoration) this.device.deleteTexture(entry.decoration);
    entry.body = undefined;
    entry.decoration = undefined;
    entry.root = undefined;
  }

  private trimCache() {
    if (this.device.textureBytes <= textureBudget) return;

    // Sorting a new owned array supports the editor's ES2020 webviews.
    const cold = [...this.entries.values()]
      .filter((entry) => entry.body && entry.lastUsed !== this.renderCount)
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((a, b) => a.lastUsed - b.lastUsed);

    for (const entry of cold) {
      this.releaseRaster(entry);
      if (this.device.textureBytes <= textureBudget) break;
    }
  }

  private fail(error: unknown) {
    if (this.disposed) return;
    this.destroy();
    this.options.onError(error);
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.batch.cancel();
    this.unsubscribers.forEach((unsubscribe) => unsubscribe());
    for (const entry of this.entries.values()) entry.unsubscribe();
    this.entries.clear();
    this.device.destroy();
  }
}
