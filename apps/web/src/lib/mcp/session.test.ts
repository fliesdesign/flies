import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { resolveMcpFileId, waitForMcpControls, withFileLock } from "./session";

test("fileId wins over the visible tab and empty values fall back", () => {
  assert.equal(resolveMcpFileId({ fileId: "poster" }, "notes"), "poster");
  assert.equal(resolveMcpFileId({}, "notes"), "notes");
  assert.equal(resolveMcpFileId({ fileId: "" }, "notes"), "notes");
  assert.equal(resolveMcpFileId({}, null), null);
  assert.throws(() => resolveMcpFileId({ fileId: "   " }, "notes"), /fileId/);
});

test("file locks overlap across files and stay serial on the same file", async () => {
  const log: string[] = [];
  let releaseA!: () => void;

  const blocked = new Promise<void>((resolve) => {
    releaseA = resolve;
  });

  const first = withFileLock("a", async () => {
    log.push("a-start");
    await blocked;
    log.push("a-end");
  });

  await new Promise((resolve) => {
    const wait = () => {
      if (log.includes("a-start")) resolve(undefined);
      else setTimeout(wait, 0);
    };

    wait();
  });

  const other = withFileLock("b", async () => {
    log.push("b");
  });

  const again = withFileLock("a", async () => {
    log.push("a2");
  });

  await other;
  assert.deepEqual(log, ["a-start", "b"]);
  releaseA();
  await first;
  await again;
  assert.deepEqual(log, ["a-start", "b", "a-end", "a2"]);
});

test("waitForMcpControls resolves once the editor is ready", async () => {
  let ready = false;
  queueMicrotask(() => {
    ready = true;
  });
  await waitForMcpControls(() => ready);
  assert.equal(ready, true);
});
