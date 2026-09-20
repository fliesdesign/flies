import { invoke } from "@tauri-apps/api/core";

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
      let result: McpResult;
      try {
        if (!handler) throw new Error("Desktop editor disconnected.");
        // eslint-disable-next-line no-await-in-loop
        result = await handler(request.name, request.arguments);
      } catch (error) {
        result = errorResult(error);
      }
      // eslint-disable-next-line no-await-in-loop
      await invoke("mcp_reply", { id: request.id, result });
    } catch {
      // The server can be unavailable (e.g. a port conflict); do not busy-loop IPC.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  running = false;
}
