import { invoke } from "@tauri-apps/api/core";

import { post } from "../api";
import { errorResult, type McpResult } from "./editor";

type Request = { id: string; name: string; arguments: Record<string, unknown> };
type Handler = (name: string, args: Record<string, unknown>) => Promise<McpResult>;
let handler: Handler | null = null;
let running = false;

/** One long poll per webview, including across React strict-mode remounts. */
export function connectMcp(next: Handler): () => void {
  handler = next;
  if (!running) void poll();

  return () => {
    if (handler === next) handler = null;
  };
}

async function poll() {
  running = true;

  // The mounted workspace updates handler and clears it on unmount.
  // eslint-disable-next-line no-unmodified-loop-condition
  while (handler) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const request = await invoke<Request | null>("mcp_next_request");
      if (!request) continue;
      void fulfill(request);
    } catch {
      // The server can be unavailable (e.g. a port conflict); do not busy-loop IPC.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  running = false;
}

async function fulfill(request: Request) {
  const current = handler;
  let result: McpResult;

  try {
    if (!current) throw new Error("Desktop editor disconnected.");
    await post("/api/billing/mcp/consume", {});
    result = await current(request.name, request.arguments);
  } catch (error) {
    result = errorResult(error);
  }

  try {
    await invoke("mcp_reply", { id: request.id, result });
  } catch {
    // The waiter may already have timed out.
  }
}
