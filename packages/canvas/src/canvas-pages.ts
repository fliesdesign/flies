import type { CanvasDocument, CanvasFrame, CanvasPage } from "./canvas-document";

export const DEFAULT_PAGE_NAME = "Default";

/** Pages hold no geometry; neutral bounds keep every descendant's world transform intact. */
export function canvasPage(name: string, id: string = crypto.randomUUID()): CanvasPage {
  return { id, name, kind: "page", x: 0, y: 0, width: 0, height: 0 };
}

/** The lowest free "Page N", so names the user chose never push the counter forward. */
export function nextPageName(frames: readonly CanvasFrame[], base = "Page"): string {
  const taken = new Set(
    frames.filter((frame) => frame.kind === "page").map((frame) => frame.name.trim()),
  );

  for (let index = 1; ; index++) {
    const name = `${base} ${index}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Give a document exactly one root level of pages. Documents saved before pages existed have
 * artwork at the root, which moves into a first page; nodes orphaned by a concurrently deleted
 * page are adopted by the first page rather than disappearing from every canvas.
 */
export function ensureCanvasPages(
  frames: readonly CanvasFrame[],
  name = DEFAULT_PAGE_NAME,
  idFactory: () => string = () => crypto.randomUUID(),
): CanvasFrame[] {
  const pages = frames.filter((frame) => frame.kind === "page");
  const strays = frames.filter((frame) => frame.kind !== "page" && frame.parentId === undefined);
  if (pages.length && !strays.length) return [...frames];
  const home = pages[0] ?? canvasPage(name, idFactory());
  const adopted = new Set(strays.map((frame) => frame.id));

  const rest = frames.map((frame) =>
    adopted.has(frame.id) ? ({ ...frame, parentId: home.id } as CanvasFrame) : frame,
  );

  return pages.length ? rest : [home, ...rest];
}

/**
 * True when a node sits directly on the canvas being edited, which is where artboard
 * labels and the default artboard shadow belong. The page node is not a visible parent.
 */
export function isCanvasRoot(document: CanvasDocument, frame: CanvasFrame): boolean {
  return frame.parentId === undefined || frame.parentId === document.getActivePageId();
}
