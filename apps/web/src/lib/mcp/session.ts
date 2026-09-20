const locks = new Map<string, Promise<void>>();

export function resolveMcpFileId(
  args: Record<string, unknown>,
  visibleId: string | null,
): string | null {
  const value = args.fileId;
  if (value === undefined || value === null || value === "") return visibleId;
  if (typeof value !== "string" || !value.trim())
    throw new Error("fileId must be a non-empty string.");

  return value.trim();
}

/** Serialize MCP work per file so several agents can edit different files at once. */
export async function withFileLock<T>(fileId: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(fileId) ?? Promise.resolve();
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  locks.set(
    fileId,
    previous.then(
      () => held,
      () => held,
    ),
  );

  try {
    await previous.catch(() => {});

    return await action();
  } finally {
    release();
  }
}

export async function waitForMcpControls(
  ready: () => boolean,
  message = "File opened, but the editor is still loading. Try get_basic_info shortly.",
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (ready()) return;
    // The tab mounts after React commits; this is the same wait create/open already used.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(message);
}
