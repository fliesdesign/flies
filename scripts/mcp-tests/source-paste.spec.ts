import { expect, test, type Page } from "@playwright/test";

const surface = "[data-snapshot-fixture] .design-canvas";

async function mount(page: Page) {
  await page.goto("/");
  await page.evaluate(async () => {
    const path = "/scripts/mcp-tests/paper-snapshot-harness.tsx";
    Reflect.set(
      window,
      "sourceFixture",
      await (await import(/* @vite-ignore */ path)).mountSnapshotFixture(),
    );
  });
}

async function paste(page: Page, text: string, html = "") {
  await page.locator(surface).evaluate(
    (element, content) => {
      const clipboard = new DataTransfer();
      if (content.text) clipboard.setData("text/plain", content.text);
      if (content.html) clipboard.setData("text/html", content.html);

      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      });

      element.dispatchEvent(event);
      if (!event.defaultPrevented) throw new Error("Paste was not handled");
    },
    { text, html },
  );
}

async function frames(page: Page) {
  return page.evaluate(() =>
    Reflect.get(window, "sourceFixture").controls.document.getSceneFrames(),
  );
}

test("SWC loads only for JSX, shares initialization across pastes, and retries a failed WASM fetch", async ({
  page,
}) => {
  let requests = 0;
  let failNext = true;
  await page.route(/wasm_bg.*\.wasm$/, async (route) => {
    requests++;
    if (failNext) {
      failNext = false;
      await route.abort();
    } else await route.continue();
  });
  await mount(page);
  await paste(page, "<p>HTML first</p>");
  await expect
    .poll(() => frames(page))
    .toEqual(expect.arrayContaining([expect.objectContaining({ text: "HTML first" })]));
  expect(requests).toBe(0);
  const before = await frames(page);
  await paste(page, '<p>{"JSX after retry"}</p>');
  await expect(page.locator("[data-snapshot-fixture] .canvas-notice")).toContainText(
    "Could not load the JSX parser",
  );
  expect(await frames(page)).toEqual(before);
  expect(requests).toBe(1);
  await paste(page, '<p>{"JSX after retry"}</p>');
  await paste(page, '<p>{"Concurrent JSX"}</p>');
  await expect
    .poll(() => frames(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "JSX after retry" }),
        expect.objectContaining({ text: "Concurrent JSX" }),
      ]),
    );
  expect(requests).toBe(2);
});

test("HTML-only paste measures embedded CSS, centers editable layers and shares MCP history", async ({
  page,
}) => {
  await mount(page);
  await paste(
    page,
    "",
    '<meta charset="utf-8"><style>.card{width:240px;height:120px;background:#ff0000;padding:20px}.card p{font-size:24px}</style><div data-name="Card" class="card"><p>Hello HTML</p></div>',
  );
  await expect
    .poll(() => frames(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Card", width: 240, height: 120, fill: "#ff0000ff" }),
        expect.objectContaining({ kind: "text", text: "Hello HTML", fontSize: 24 }),
      ]),
    );

  const result = await page.evaluate(async () => {
    const controls = Reflect.get(window, "sourceFixture").controls;
    const size = controls.camera.getCurrent().size;
    const path = "/src/lib/mcp/editor.ts";
    const { editorTool } = await import(/* @vite-ignore */ path);
    const root = controls.document.getFrame(controls.document.getChildren()[0]);
    const info = await editorTool(controls, "get_node_info", { nodeId: root.id });
    const saved = JSON.stringify(controls.document.getCommittedFrames());
    await editorTool(controls, "undo", {});
    const empty = !controls.document.getSceneIds().length;
    await editorTool(controls, "redo", {});

    return {
      root,
      size,
      info,
      empty,
      restored: saved === JSON.stringify(controls.document.getCommittedFrames()),
      background: getComputedStyle(document.body).backgroundColor,
    };
  });

  expect(result.root).toMatchObject({ x: result.size.x / 2 - 120, y: result.size.y / 2 - 60 });
  expect(result.empty && result.restored).toBe(true);
  expect(JSON.stringify(result.info)).toContain("Card");
  expect(result.background).not.toBe("rgb(255, 0, 0)");
});

test("raw fenced TSX wins over code-editor rich HTML and renders local components", async ({
  page,
}) => {
  await mount(page);
  await paste(
    page,
    '```tsx\nconst items = ["One", "Two"];\nfunction Item({label}: {label:string}) { return <p className="text-xl">{label}</p>; }\nexport default function App() { return <section data-name="React card" className="flex flex-col gap-4 bg-blue-500 p-6 w-[320px]">{items.map(label => <Item key={label} label={label} />)}</section>; }\n```',
    "<pre>Syntax highlighted source</pre>",
  );
  await expect
    .poll(() => frames(page))
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "React card", width: 320 }),
        expect.objectContaining({ text: "One", fontSize: 20 }),
        expect.objectContaining({ text: "Two", fontSize: 20 }),
      ]),
    );
  expect(
    (await frames(page)).some((node: { text?: string }) =>
      node.text?.includes("Syntax highlighted"),
    ),
  ).toBe(false);
});

for (const mode of ["keyboard", "menu"] as const) {
  test(`native ${mode} Paste imports React through the shared clipboard path`, async ({ page }) => {
    await mount(page);
    await page.evaluate(async () => {
      const path = "/node_modules/@tauri-apps/api/mocks.js";
      const { mockIPC } = await import(/* @vite-ignore */ path);
      Reflect.set(window, "isTauri", true);
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Macintosh" });
      Reflect.set(window, "sourceReads", 0);
      mockIPC((command: string) => {
        if (command !== "read_canvas_clipboard") throw new Error(command);
        Reflect.set(window, "sourceReads", Reflect.get(window, "sourceReads") + 1);

        return {
          html: "",
          text: '<div data-name="Native React" style={{width:240,height:120,backgroundColor:"#00ff00",transform:"rotate(90deg)"}}>Native JSX</div>',
          imageBase64: null,
        };
      });
    });

    if (mode === "keyboard") {
      await page.locator(surface).focus();
      await page.keyboard.press("Meta+v");
    } else {
      await page.locator(surface).click({ button: "right", position: { x: 320, y: 220 } });
      await page.getByRole("menuitem", { name: /^Paste\s+⌘/ }).click();
    }

    await expect
      .poll(() => frames(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Native React", rotation: 90, width: 240, height: 120 }),
        ]),
      );

    const bounds = await page.evaluate(async () => {
      const path = "/packages/canvas/src/index.ts";
      const { worldBounds } = await import(/* @vite-ignore */ path);
      const { document: doc, camera } = Reflect.get(window, "sourceFixture").controls;

      return {
        rect: worldBounds(doc, doc.getFrame(doc.getChildren()[0])),
        size: camera.getCurrent().size,
      };
    });

    expect(bounds.rect.width).toBeCloseTo(120);
    expect(bounds.rect.height).toBeCloseTo(240);
    expect(bounds.rect.x).toBeCloseTo(mode === "menu" ? 320 : bounds.size.x / 2 - 60);
    expect(bounds.rect.y).toBeCloseTo(mode === "menu" ? 220 : bounds.size.y / 2 - 120);
    expect(await page.evaluate(() => Reflect.get(window, "sourceReads"))).toBe(1);
    await page.keyboard.press("Meta+z");
    await expect.poll(() => frames(page)).toHaveLength(0);
  });
}

test("unsupported React reports an error without replacing existing layers or plain text behavior", async ({
  page,
}) => {
  await mount(page);
  await paste(page, "A plain note");
  await expect
    .poll(() => frames(page))
    .toEqual(expect.arrayContaining([expect.objectContaining({ text: "A plain note" })]));
  const before = await frames(page);
  await paste(
    page,
    "export default function App(){const [count] = useState(0);return <p>{count}</p>;}",
  );
  await expect(page.locator("[data-snapshot-fixture] .canvas-notice")).toContainText(
    "Unknown value useState",
  );
  expect(await frames(page)).toEqual(before);
});

test("write_source validates, applies and replaces in the same document with warnings and atomic failures", async ({
  page,
}) => {
  await mount(page);

  const result = await page.evaluate(async () => {
    const path = "/src/lib/mcp/editor.ts";
    const { editorTool } = await import(/* @vite-ignore */ path);
    const controls = Reflect.get(window, "sourceFixture").controls;
    const doc = controls.document;

    const call = async (name: string, args: object) =>
      JSON.parse((await editorTool(controls, name, args)).content[0].text);

    const args = {
      source:
        'export default () => <section data-name="MCP React" style={{width:280,height:120,backgroundColor:"#123456"}}><button onClick={missingHandler}>Hello MCP</button></section>',
      width: 400,
      x: 50,
      y: 80,
    };

    const preview = await call("write_source", { ...args, validateOnly: true });
    const empty = doc.getSceneIds().length === 0;
    const applied = await call("write_source", args);
    const root = doc.getFrame(applied.roots[0].id);
    const saved = JSON.stringify(doc.getCommittedFrames());
    const errors: string[] = [];

    for (const bad of [
      { source: "<script>window.sourceRan=true</script>" },
      { source: '<div>{fetch("https://example.com")}</div>' },
      { source: '<img src="https://example.com/pixel">' },
      { source: '<style>@import "https://example.com/style";</style><p>Hi</p>' },
      { source: "<p>Hi</p>", format: "wat" },
    ]) {
      try {
        // Each attempted mutation must finish before testing the next on this document.
        // oxlint-disable-next-line no-await-in-loop
        await call("write_source", { ...bad, targetId: root.id });
      } catch (error) {
        errors.push(String(error));
      }
    }

    const unchanged = saved === JSON.stringify(doc.getCommittedFrames());
    await call("write_source", {
      source: "<main style={{width:280,height:120}}>Revised</main>",
      targetId: root.id,
    });
    const retained = doc.getFrame(root.id);
    await call("undo", {});
    const restored = saved === JSON.stringify(doc.getCommittedFrames());

    return {
      preview,
      empty,
      applied,
      root,
      errors,
      unchanged,
      retained,
      restored,
      executed: Reflect.get(window, "sourceRan"),
    };
  });

  expect(result.preview).toMatchObject({ applied: false, format: "jsx", nodeIds: [] });
  expect(result.empty).toBe(true);
  expect(result.applied.sourceWarnings).toEqual([
    "Event handlers and refs were omitted from the static design.",
  ]);
  expect(result.root).toMatchObject({
    name: "MCP React",
    x: 50,
    y: 80,
    width: 280,
    height: 120,
    fill: "#123456ff",
  });
  expect(result.errors).toHaveLength(5);
  expect(result.unchanged && result.restored).toBe(true);
  expect(result.retained.id).toBe(result.root.id);
  expect(result.executed).toBeUndefined();
});
