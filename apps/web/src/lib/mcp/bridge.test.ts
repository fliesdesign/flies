import { afterEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), post: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../api", () => ({ post: mocks.post }));

let disconnect: (() => void) | undefined;
let finishPoll: ((value: null) => void) | undefined;
afterEach(() => {
  disconnect?.();
  finishPoll?.(null);
  vi.clearAllMocks();
});

async function setup() {
  vi.resetModules();
  let requestSent = false;
  mocks.invoke.mockImplementation((command: string) => {
    if (command !== "mcp_next_request") return Promise.resolve();

    if (!requestSent) {
      requestSent = true;

      return Promise.resolve({ id: "request", name: "get_selection", arguments: {} });
    }

    return new Promise<null>((resolve) => {
      finishPoll = resolve;
    });
  });
  const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] });
  const { connectMcp } = await import("./bridge");
  disconnect = connectMcp(handler);

  return handler;
}

it("does not run a tool until the backend reserves its allowance", async () => {
  let allow!: (value: unknown) => void;
  mocks.post.mockImplementation(
    () =>
      new Promise((resolve) => {
        allow = resolve;
      }),
  );
  const handler = await setup();
  await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledWith("/api/billing/mcp/consume", {}));
  expect(handler).not.toHaveBeenCalled();
  allow({ enabled: false, remaining: null });
  await vi.waitFor(() => expect(handler).toHaveBeenCalledWith("get_selection", {}));
});

it("returns quota failures to the MCP client without dispatching the tool", async () => {
  mocks.post.mockRejectedValue(new Error("Weekly MCP call limit reached."));
  const handler = await setup();
  await vi.waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "mcp_reply",
      expect.objectContaining({ result: expect.objectContaining({ isError: true }) }),
    ),
  );
  expect(handler).not.toHaveBeenCalled();
});
