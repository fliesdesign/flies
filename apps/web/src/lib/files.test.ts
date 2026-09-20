import assert from "node:assert/strict";

import type { CanvasFrame, CanvasTheme } from "@flies/canvas";
import { describe, test } from "vite-plus/test";

import { ApiError } from "./api";
import { FileAutosave, type DesignFile } from "./files";

const file: DesignFile = {
  format: "flies",
  version: 1,
  id: "abc",
  name: "Test",
  createdAt: 1,
  updatedAt: 1,
  revision: 0,
  nodes: [],
};

const nodes: CanvasFrame[] = [{ id: "node", name: "Frame", x: 0, y: 0, width: 100, height: 100 }];
describe("file autosave", () => {
  test("saves theme and node snapshots together through queued edits and rename", async () => {
    const theme: CanvasTheme = {
      tokens: [{ id: "brand", name: "Brand", type: "color", value: "#123456" }],
    };

    const writes: DesignFile[] = [];
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saver = new FileAutosave(file, async (previous, next) => {
      const result = { ...previous, nodes: next, revision: previous.revision + 1 };
      writes.push(result);
      if (writes.length === 1) await gate;

      return result;
    });

    saver.enqueue([]);
    const pending = saver.flush();
    saver.enqueue(nodes, theme);
    const rename = saver.rename("Themed");
    release();
    await Promise.all([pending, rename]);
    assert.deepEqual(writes[0].theme, { tokens: [] });
    assert.deepEqual(writes[1].theme, theme);
    assert.deepEqual(writes[1].nodes, nodes);
    assert.equal(writes[1].name, "Themed");
    assert.equal(writes[1].revision, 2);
  });
  test("serializes edits made during a save with the returned revision", async () => {
    const writes: number[] = [];
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const saver = new FileAutosave(file, async (previous, next) => {
      writes.push(previous.revision);
      if (writes.length === 1) await gate;

      return { ...previous, revision: previous.revision + 1, nodes: next };
    });

    saver.enqueue([]);
    const first = saver.flush();
    saver.enqueue(nodes);
    const second = saver.flush();
    assert.equal(first, second);
    release();
    await first;
    assert.deepEqual(writes, [0, 1]);
  });
  test("retains failed changes for retry without advancing revision", async () => {
    let fail = true;
    const received: CanvasFrame[][] = [];

    const saver = new FileAutosave(file, async (previous, next) => {
      assert.equal(previous.revision, 0);
      if (fail) throw new Error("Disk full");
      received.push(next);

      return { ...previous, revision: 1, nodes: next };
    });

    saver.enqueue(nodes);
    await assert.rejects(saver.flush(), /Disk full/);
    fail = false;
    await saver.flush();
    assert.deepEqual(received, [nodes]);
  });
  test("renaming during an in-flight save retains edits and the latest revision", async () => {
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const writes: DesignFile[] = [];
    const savedNames: string[] = [];

    const saver = new FileAutosave(
      file,
      async (previous, next) => {
        const saved = { ...previous, revision: previous.revision + 1, nodes: next };
        writes.push(saved);
        if (writes.length === 1) await gate;

        return saved;
      },
      undefined,
      (saved) => savedNames.push(saved.name),
    );

    saver.enqueue(nodes);
    const first = saver.flush();
    const rename = saver.rename("Renamed");
    const edited = [{ ...nodes[0], width: 200 }];
    saver.enqueue(edited);
    release();
    await Promise.all([first, rename]);
    await saver.flush();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].name, "Renamed");
    assert.equal(writes[1].revision, 2);
    assert.deepEqual(writes[1].nodes, edited);
    assert.deepEqual(savedNames, ["Test", "Renamed"]);
  });
  test("failed rename can be retried with its name and nodes intact", async () => {
    let fail = true;
    let result: DesignFile | undefined;

    const saver = new FileAutosave({ ...file, nodes }, async (previous, next) => {
      if (fail) throw new Error("Disk full");
      result = { ...previous, revision: previous.revision + 1, nodes: next };

      return result;
    });

    await assert.rejects(saver.rename("Renamed"), /Disk full/);
    fail = false;
    await saver.flush();
    assert.equal(result?.name, "Renamed");
    assert.deepEqual(result?.nodes, nodes);
  });
});

describe("API autosave retry", () => {
  test("replays the same mutation after a lost response before saving newer edits", async () => {
    let attempts = 0;
    const writes: { revision: number; mutationId: string; width: number }[] = [];
    let committed: DesignFile | undefined;

    const saver = new FileAutosave(file, async (previous, next, mutationId) => {
      writes.push({ revision: previous.revision, mutationId, width: next[0].width });
      attempts++;

      if (attempts === 1) {
        committed = { ...previous, nodes: next, revision: 1 };
        throw new Error("Connection lost after commit");
      }

      if (attempts === 2) return committed!;

      return { ...previous, nodes: next, revision: previous.revision + 1 };
    });

    saver.enqueue(nodes);
    await assert.rejects(saver.flush());
    assert.equal(saver.isDirty(), true);
    saver.enqueue([{ ...nodes[0], width: 200 }]);
    await saver.flush();
    assert.deepEqual(
      writes.map((write) => write.revision),
      [0, 0, 1],
    );
    assert.equal(writes[0].mutationId, writes[1].mutationId);
    assert.notEqual(writes[1].mutationId, writes[2].mutationId);
    assert.deepEqual(
      writes.map((write) => write.width),
      [100, 100, 200],
    );
    assert.equal(saver.isDirty(), false);
  });
});

describe("expired sessions", () => {
  test("retains unsaved edits until signing in and retrying", async () => {
    let authenticated = false;

    const saver = new FileAutosave(file, async (previous, next) => {
      if (!authenticated) throw new ApiError(401, "Sign in again.");

      return { ...previous, nodes: next, revision: 1 };
    });

    saver.enqueue(nodes);
    await assert.rejects(saver.flush());
    assert.equal(saver.needsSignIn, true);
    assert.equal(saver.isDirty(), true);
    authenticated = true;
    await saver.flush();
    assert.equal(saver.needsSignIn, false);
    assert.equal(saver.isDirty(), false);
  });
});
