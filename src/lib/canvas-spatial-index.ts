import type { FrameRect, Point, Viewport } from "./canvas-geometry";

type IndexedFrame = FrameRect & { id: string };
type Bounds = { left: number; top: number; right: number; bottom: number };
type CellRange = Bounds & { count: number };
type Entry = { bounds: Bounds; cells: string[] | null };

const CELL_SIZE = 1024;
const MAX_FRAME_CELLS = 64;
const MAX_QUERY_CELLS = 4096;

function boundsOf(rect: FrameRect): Bounds {
  return {
    left: Math.min(rect.x, rect.x + rect.width),
    top: Math.min(rect.y, rect.y + rect.height),
    right: Math.max(rect.x, rect.x + rect.width),
    bottom: Math.max(rect.y, rect.y + rect.height),
  };
}

function intersects(a: Bounds, b: Bounds) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function cellRange(bounds: Bounds): CellRange {
  const left = Math.floor(bounds.left / CELL_SIZE);
  const top = Math.floor(bounds.top / CELL_SIZE);
  const right = Math.floor(bounds.right / CELL_SIZE);
  const bottom = Math.floor(bounds.bottom / CELL_SIZE);
  const safe = [left, top, right, bottom].every(Number.isSafeInteger);

  return {
    left,
    top,
    right,
    bottom,
    count: safe ? (right - left + 1) * (bottom - top + 1) : Infinity,
  };
}

/** World-space viewport bounds with a constant screen-space mounting buffer. */
export function viewportBounds(viewport: Viewport, size: Point, overscanPixels = 200): FrameRect {
  const overscan = Math.max(0, overscanPixels);

  return {
    x: (-viewport.x - overscan) / viewport.zoom,
    y: (-viewport.y - overscan) / viewport.zoom,
    width: (size.x + overscan * 2) / viewport.zoom,
    height: (size.y + overscan * 2) / viewport.zoom,
  };
}

/**
 * A world-space spatial hash. Ordinary queries visit nearby cells only; oversized
 * frames use a separate set so one large frame cannot allocate millions of cells.
 * Results include touching edges, are deduplicated, and have no z-order guarantee.
 */
export class CanvasSpatialIndex {
  private readonly entries = new Map<string, Entry>();
  private readonly cells = new Map<string, Set<string>>();
  private readonly oversized = new Set<string>();

  constructor(initial: readonly IndexedFrame[] = []) {
    for (const frame of initial) this.upsert(frame);
  }

  upsert(frame: IndexedFrame) {
    this.remove(frame.id);

    const bounds = boundsOf(frame);
    const range = cellRange(bounds);

    if (range.count > MAX_FRAME_CELLS) {
      this.entries.set(frame.id, { bounds, cells: null });
      this.oversized.add(frame.id);
      return;
    }

    const keys: string[] = [];
    for (let y = range.top; y <= range.bottom; y++) {
      for (let x = range.left; x <= range.right; x++) {
        const key = `${x},${y}`;
        let cell = this.cells.get(key);
        if (!cell) {
          cell = new Set();
          this.cells.set(key, cell);
        }
        cell.add(frame.id);
        keys.push(key);
      }
    }
    this.entries.set(frame.id, { bounds, cells: keys });
  }

  remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;

    if (entry.cells) {
      for (const key of entry.cells) {
        const cell = this.cells.get(key);
        cell?.delete(id);
        if (cell?.size === 0) this.cells.delete(key);
      }
    } else {
      this.oversized.delete(id);
    }
    this.entries.delete(id);
  }

  query(rect: FrameRect): string[] {
    if (this.entries.size === 0) return [];

    const bounds = boundsOf(rect);
    const range = cellRange(bounds);
    const matches: string[] = [];

    // A very distant zoom must not iterate an effectively unbounded cell grid.
    // Scanning entries is also cheaper when most queried cells would be empty.
    if (range.count > Math.min(MAX_QUERY_CELLS, this.cells.size)) {
      for (const [id, entry] of this.entries) {
        if (intersects(bounds, entry.bounds)) matches.push(id);
      }
      return matches;
    }

    const candidates = new Set(this.oversized);
    for (let y = range.top; y <= range.bottom; y++) {
      for (let x = range.left; x <= range.right; x++) {
        const cell = this.cells.get(`${x},${y}`);
        if (cell) for (const id of cell) candidates.add(id);
      }
    }

    for (const id of candidates) {
      const entry = this.entries.get(id);
      if (entry && intersects(bounds, entry.bounds)) matches.push(id);
    }
    return matches;
  }
}
