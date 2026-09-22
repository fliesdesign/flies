import { CanvasDocument, type CanvasFrame } from "@flies/canvas";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { draftFile, type DesignFile } from "./files";
import { RealtimeFile } from "./realtime";

const mocks = vi.hoisted(() => ({ post: vi.fn(), saveFile: vi.fn() }));
vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  post: mocks.post,
}));
vi.mock("./files", async (original) => ({
  ...(await original<typeof import("./files")>()),
  saveFile: mocks.saveFile,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve, reject };
}

let unbind: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({ enabled: false });
  mocks.saveFile.mockImplementation(async (file: DesignFile, nodes: CanvasFrame[]) => ({
    ...file,
    nodes,
    revision: file.revision + 1,
  }));
});
afterEach(() => {
  unbind?.();
  vi.useRealTimers();
});

function setup(create: () => Promise<DesignFile>, draft = draftFile("First idea")) {
  const document = new CanvasDocument(draft.nodes, draft.theme);
  const controls = { document, hasTextDraft: () => false } as CanvasControls;
  const status = vi.fn();
  const onSaved = vi.fn();
  const realtime = new RealtimeFile(draft, status, onSaved, create);
  unbind = realtime.bind(controls);

  return { draft, document, controls, realtime, status, onSaved };
}

function draw(document: CanvasDocument, id = "frame") {
  document.add({ id, name: "Frame", x: 0, y: 0, width: 100, height: 100 });
}

describe("optimistic file creation", () => {
  it("keeps early edits and undo history while saving with the server ID", async () => {
    const creation = deferred<DesignFile>();
    const create = vi.fn(() => creation.promise);
    const { draft, document, realtime, onSaved } = setup(create);
    draw(document);
    const flushing = realtime.flush();
    expect(realtime.isDirty()).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.saveFile).not.toHaveBeenCalled();
    const saved = { ...draft, id: "server-id" };
    creation.resolve(saved);
    await flushing;
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith("/api/sync/ticket", { fileId: "server-id" });
    expect(mocks.saveFile).toHaveBeenCalledTimes(1);
    expect(mocks.saveFile.mock.calls[0][0].id).toBe("server-id");
    expect(mocks.saveFile.mock.calls[0][1]).toEqual(document.getCommittedFrames());
    expect(document.getFrame("frame")).toBeTruthy();
    expect(onSaved).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "server-id", revision: 1 }),
    );
    expect(realtime.isDirty()).toBe(false);
    document.undo();
    expect(document.getFrame("frame")).toBeUndefined();
  });

  it("retains failed drafts and edits until an explicit retry succeeds", async () => {
    const creation = deferred<DesignFile>();
    const create = vi.fn(() => creation.promise);
    const { draft, document, realtime, status } = setup(create);
    draw(document);
    const flushing = realtime.flush();
    const failed = expect(flushing).rejects.toThrow("Workspace unavailable");
    creation.reject(new Error("Workspace unavailable"));
    await failed;
    expect(status).toHaveBeenLastCalledWith(expect.stringContaining("Could not create file"));
    expect(realtime.isDirty()).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
    draw(document, "second-frame");
    await vi.advanceTimersByTimeAsync(5000);
    expect(create).toHaveBeenCalledTimes(1);
    expect(mocks.saveFile).not.toHaveBeenCalled();
    create.mockResolvedValue({ ...draft, id: "retried-id" });
    await realtime.flush();
    expect(create).toHaveBeenCalledTimes(2);
    expect(mocks.saveFile.mock.calls[0][0].id).toBe("retried-id");
    expect(document.getFrame("frame")).toBeTruthy();
    expect(document.getFrame("second-frame")).toBeTruthy();
    expect(status).toHaveBeenLastCalledWith("Saved");
  });

  it("does not create twice when React binds the same editor again", async () => {
    const creation = deferred<DesignFile>();
    const create = vi.fn(() => creation.promise);
    const { draft, controls, realtime } = setup(create);
    unbind!();
    unbind = realtime.bind(controls);
    expect(create).toHaveBeenCalledTimes(1);
    creation.resolve({ ...draft, id: "server-id" });
    await realtime.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(realtime.isDirty()).toBe(false);
  });

  it("connects after retrying an empty draft without waiting for an edit", async () => {
    const creation = deferred<DesignFile>();
    const create = vi.fn(() => creation.promise);
    const { draft, realtime } = setup(create);
    const flushing = realtime.flush();
    const failed = expect(flushing).rejects.toThrow("Workspace unavailable");
    creation.reject(new Error("Workspace unavailable"));
    await failed;
    create.mockResolvedValue({ ...draft, id: "retried-id" });
    await realtime.flush();
    expect(mocks.post).toHaveBeenCalledWith("/api/sync/ticket", { fileId: "retried-id" });
    expect(realtime.getSnapshot().state).toBe("disabled");
    expect(realtime.isDirty()).toBe(false);
  });
});
