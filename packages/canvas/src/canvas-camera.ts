import type { Point, Viewport } from "./canvas-geometry";

/** Coalesce high-frequency input and flush the final sample before committing a gesture. */
export class AnimationFrameBatch {
  private pending: number | null = null;

  constructor(
    private readonly run: () => void,
    private readonly request: (callback: FrameRequestCallback) => number = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancelRequest: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  schedule = () => {
    if (this.pending !== null) return;
    this.pending = this.request(() => {
      this.pending = null;
      this.run();
    });
  };

  flush = () => {
    if (this.pending === null) return;
    this.cancel();
    this.run();
  };

  cancel = () => {
    if (this.pending !== null) this.cancelRequest(this.pending);
    this.pending = null;
  };
}

/** Retain only the latest input, without closing over mutable React refs. */
export class LatestValueFrameBatch<T> {
  private latest: T | undefined;
  private hasValue = false;
  private readonly batch: AnimationFrameBatch;

  constructor(
    run: (value: T) => void,
    request?: (callback: FrameRequestCallback) => number,
    cancelRequest?: (id: number) => void,
  ) {
    this.batch = new AnimationFrameBatch(
      () => {
        if (!this.hasValue) return;
        const value = this.latest as T;
        this.latest = undefined;
        this.hasValue = false;
        run(value);
      },
      request,
      cancelRequest,
    );
  }

  schedule = (value: T) => {
    this.latest = value;
    this.hasValue = true;
    this.batch.schedule();
  };

  flush = () => this.batch.flush();

  cancel = () => {
    this.batch.cancel();
    this.latest = undefined;
    this.hasValue = false;
  };
}

export type CameraSnapshot = { viewport: Viewport; size: Point };

export class CanvasCamera {
  private current: CameraSnapshot = { viewport: { x: 0, y: 0, zoom: 1 }, size: { x: 0, y: 0 } };
  private published = this.current;
  private readonly listeners = new Set<() => void>();
  private readonly batch = new AnimationFrameBatch(() => {
    this.published = this.current;
    this.listeners.forEach((listener) => listener());
  });

  getCurrent = () => this.current;
  getSnapshot = () => this.published;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setViewport = (viewport: Viewport) => {
    const before = this.current.viewport;
    if (before.x === viewport.x && before.y === viewport.y && before.zoom === viewport.zoom) return;
    this.current = { ...this.current, viewport };
    this.batch.schedule();
  };

  setSize = (size: Point) => {
    if (size.x === this.current.size.x && size.y === this.current.size.y) return;
    this.current = { ...this.current, size };
    this.batch.schedule();
  };

  flush = () => this.batch.flush();
  cancel = () => this.batch.cancel();
}
