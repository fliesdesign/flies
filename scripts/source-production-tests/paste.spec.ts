import type { CanvasFrame } from "@flies/canvas";
import { expect, test } from "@playwright/test";

test("production JSX paste loads local WASM and survives autosave, undo, redo and reload", async ({
  page,
}) => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

  let file = {
    format: "flies",
    version: 1,
    id,
    name: "Source import",
    createdAt: 1,
    updatedAt: 1,
    revision: 0,
    nodes: [] as CanvasFrame[],
  };

  const account = {
    user: { id: "test", name: "Test", email: "test@example.invalid" },
    workspace: { id: "workspace", name: "My workspace" },
  };

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/me") return route.fulfill({ json: account });
    if (path === "/api/sync/ticket") return route.fulfill({ json: { enabled: false } });
    if (path === "/api/files")
      return route.fulfill({
        json: {
          workspace: account.workspace,
          warnings: [],
          files: [{ ...file, preview: [], nodeCount: file.nodes.length, archived: false }],
        },
      });
    if (path === `/api/files/${id}`) return route.fulfill({ json: file });

    if (path === `/api/files/${id}/revisions`) {
      const body = route.request().postDataJSON();
      file = { ...file, nodes: body.nodes, revision: file.revision + 1 };

      return route.fulfill({ json: file });
    }

    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  const wasmRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith(".wasm")) wasmRequests.push(request.url());
  });
  await page.goto(`/files/${id}`);
  const canvas = page.getByRole("application", { name: "Design canvas" });
  await expect(canvas).toBeVisible();

  const paste = async (source: string) =>
    canvas.evaluate((element, text) => {
      const clipboard = new DataTransfer();
      clipboard.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
      );
    }, source);

  await paste("<p>Plain HTML</p>");
  await expect.poll(() => file.nodes.some((node) => node.text === "Plain HTML")).toBe(true);
  expect(wasmRequests).toEqual([]);

  const wasmResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith(".wasm"),
  );

  await paste(
    'export default function App() { return <section data-name="Production React" style={{width:280,height:120,backgroundColor:"#abcdef"}}><p>WASM works</p></section>; }',
  );
  const response = await wasmResponse;
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/wasm");
  expect(new URL(response.url()).origin).toBe("http://127.0.0.1:1433");
  await expect
    .poll(() => file.nodes)
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Production React", width: 280, height: 120 }),
        expect.objectContaining({ text: "WASM works" }),
      ]),
    );
  const imported = file.nodes;
  await canvas.focus();
  await page.keyboard.press("Control+z");
  await expect.poll(() => file.nodes.some((node) => node.text === "WASM works")).toBe(false);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => file.nodes).toEqual(imported);
  expect(wasmRequests).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole("treeitem", { name: "Production React", exact: true })).toBeVisible();
  expect(file.nodes).toEqual(imported);
});
