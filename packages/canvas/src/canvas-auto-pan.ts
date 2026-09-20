import { screenToWorld, type Point, type Viewport } from "./canvas-geometry";

const EDGE_SIZE = 48;
const MAX_SPEED = 720;

/** Screen pixels per second; the quadratic ramp keeps entering the edge zone gentle. */
export function edgePanVelocity(point: Point, size: Point): Point {
  const axis = (position: number, length: number) => {
    const edge = Math.min(EDGE_SIZE, length / 2);
    if (edge <= 0) return 0;
    if (position < edge) return MAX_SPEED * Math.min(1, (edge - position) / edge) ** 2;
    if (position > length - edge)
      return -MAX_SPEED * Math.min(1, (position - length + edge) / edge) ** 2;
    return 0;
  };
  const velocity = { x: axis(point.x, size.x), y: axis(point.y, size.y) };
  const magnitude = Math.hypot(velocity.x, velocity.y);
  if (magnitude > MAX_SPEED) {
    velocity.x *= MAX_SPEED / magnitude;
    velocity.y *= MAX_SPEED / magnitude;
  }
  return velocity;
}

/** The start remains in world coordinates while the camera moves underneath a captured pointer. */
export function pointerWorldDelta(start: Point, point: Point, viewport: Viewport): Point {
  const current = screenToWorld(point, viewport);
  return { x: current.x - start.x, y: current.y - start.y };
}

export class CanvasAutoPan {
  private pending: number | null = null;
  private lastTime: number | null = null;
  private velocity: Point = { x: 0, y: 0 };
  private onPan: ((delta: Point) => void) | undefined;

  constructor(
    private readonly request: (callback: FrameRequestCallback) => number = (callback) =>
      requestAnimationFrame(callback),
    private readonly cancel: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  update(point: Point, size: Point, onPan: (delta: Point) => void) {
    this.velocity = edgePanVelocity(point, size);
    this.onPan = onPan;
    if (!this.velocity.x && !this.velocity.y) {
      this.stop();
      return;
    }
    if (this.pending === null) this.pending = this.request(this.tick);
  }

  stop = () => {
    if (this.pending !== null) this.cancel(this.pending);
    this.pending = null;
    this.lastTime = null;
    this.onPan = undefined;
  };

  private tick = (time: number) => {
    this.pending = null;
    // A suspended tab must not turn a long pause into a large camera jump.
    const elapsed = this.lastTime === null ? 0 : Math.min(32, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    this.onPan?.({
      x: (this.velocity.x * elapsed) / 1000,
      y: (this.velocity.y * elapsed) / 1000,
    });
    if (this.onPan) this.pending = this.request(this.tick);
  };
}
