import { expect, test } from "@playwright/test";

test("agents build a page shell, then fill and replace sections in separate calls", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const doc = new CanvasDocument();
    const controls = { document: doc, prepare: () => {} };
    const write = async (args: Record<string, unknown>) =>
      JSON.parse((await editorTool(controls, "write_html", args)).content[0].text);
    const shell = await write({
      x: 100,
      y: 200,
      width: 960,
      height: 600,
      html: `<main data-name="Home" style="width:100%;height:100%;background:white;display:flex;flex-direction:column"><header data-name="Header" style="height:64px"></header><section data-name="Content" style="flex:1"></section><footer data-name="Footer" style="height:60px;background:#eeeeee"></footer></main>`,
    });
    const find = (name: string) =>
      shell.containers.find((node: { name: string }) => node.name === name);
    const header = find("Header"),
      content = find("Content"),
      footer = find("Footer");
    const headerResult = await write({
      parentId: header.id,
      x: 24,
      y: 20,
      html: "<p>Gmail · Images</p>",
    });
    const footerResult = await write({
      parentId: footer.id,
      x: 24,
      y: 20,
      html: "<p>About · Privacy</p>",
    });
    await write({
      parentId: content.id,
      x: 350,
      y: 50,
      width: 260,
      html: '<h1 style="font-size:64px">Google</h1>',
    });
    const search = await write({
      parentId: content.id,
      x: 200,
      y: 150,
      width: 560,
      html: '<div data-name="Search" style="width:560px;height:48px;border:1px solid #dddddd;border-radius:24px"><input placeholder="Search" style="width:100%;height:100%;padding:0 20px" /></div>',
    });
    const searchId = search.roots[0].id;
    const beforeReplace = doc.getFrames();
    const orderBefore = [...doc.getChildren(content.id)];
    const replacement = await write({
      targetId: searchId,
      html: '<div data-name="Search" style="width:100%;height:100%;border:1px solid #aaaaaa;border-radius:24px;background:#f5f5f5"><input placeholder="Search Google" style="width:100%;height:100%;padding:0 20px" /></div>',
    });
    const afterReplace = doc.getFrames();
    const orderAfter = [...doc.getChildren(content.id)];
    const stableHeader = doc.getFrame(headerResult.roots[0].id);
    const stableFooter = doc.getFrame(footerResult.roots[0].id);
    doc.undo();
    const restored = JSON.stringify(doc.getFrames()) === JSON.stringify(beforeReplace);
    doc.redo();
    const redone = JSON.stringify(doc.getFrames()) === JSON.stringify(afterReplace);
    const extra = await write({
      parentId: searchId,
      x: 510,
      y: 14,
      width: 40,
      html: "<p>×</p>",
    });
    return {
      shell,
      header,
      content,
      footer,
      replacement,
      searchId,
      orderBefore,
      orderAfter,
      stableHeader,
      stableFooter,
      restored,
      redone,
      extra: doc.getFrame(extra.roots[0].id),
    };
  });
  expect(result.shell.containers.map((node: { name: string }) => node.name)).toEqual([
    "Home",
    "Header",
    "Content",
    "Footer",
  ]);
  expect(result.header).toMatchObject({ kind: "frame", x: 100, y: 200, width: 960, height: 64 });
  expect(result.content).toMatchObject({ kind: "frame", x: 100, y: 264, width: 960, height: 476 });
  expect(result.footer).toMatchObject({ kind: "frame", x: 100, y: 740, width: 960, height: 60 });
  expect(result.replacement.roots[0]).toMatchObject({
    id: result.searchId,
    parentId: result.content.id,
    x: 300,
    y: 414,
    width: 560,
    height: 48,
  });
  expect(result.orderAfter).toEqual(result.orderBefore);
  expect(result.stableHeader).toMatchObject({ text: "Gmail · Images", x: 124, y: 220 });
  expect(result.stableFooter).toMatchObject({ text: "About · Privacy", x: 124, y: 760 });
  expect(result.restored && result.redone).toBe(true);
  expect(result.extra).toMatchObject({ parentId: result.searchId, x: 810, y: 428 });
});

test("targeted previews and invalid replacements leave existing sections and history intact", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const doc = new CanvasDocument([
      { id: "section", name: "Section", x: 50, y: 60, width: 400, height: 200 },
    ]);
    const controls = { document: doc, prepare: () => {} };
    const before = JSON.stringify(doc.getFrames());
    const revision = doc.getSnapshot().revision;
    const preview = JSON.parse(
      (
        await editorTool(controls, "write_html", {
          targetId: "section",
          validateOnly: true,
          html: '<section data-name="Updated" style="height:100%"><p>Hello</p></section>',
        })
      ).content[0].text,
    );
    const errors: string[] = [];
    for (const args of [
      { targetId: "section", html: "<p>One</p><p>Two</p>" },
      { targetId: "section", parentId: "section", html: "<p>Invalid</p>" },
      { targetId: "section", replace: true, html: "<p>Invalid</p>" },
      { targetId: "missing", html: "<p>Invalid</p>" },
      { targetId: "section", html: "<iframe></iframe>" },
    ]) {
      try {
        // Match the server's serial mutation flow against the same document.
        // eslint-disable-next-line no-await-in-loop
        await editorTool(controls, "write_html", args);
      } catch (error) {
        errors.push(String(error));
      }
    }
    return {
      preview,
      errors,
      unchanged: JSON.stringify(doc.getFrames()) === before,
      revisionUnchanged: doc.getSnapshot().revision === revision,
      history: doc.getHistoryStats(),
    };
  });
  expect(result.preview).toMatchObject({ applied: false, nodeIds: [] });
  expect(result.preview.roots[0]).toMatchObject({
    name: "Updated",
    x: 50,
    y: 60,
    width: 400,
    height: 200,
  });
  expect(result.preview.containers).toHaveLength(1);
  expect(result.preview.containers[0]).not.toHaveProperty("id");
  expect(result.preview.containers[0]).not.toHaveProperty("parentId");
  expect(result.errors).toHaveLength(5);
  expect(result.unchanged && result.revisionUnchanged).toBe(true);
  expect(result.history.undoEntries).toBe(0);
});

test("section replacement refuses to overwrite edits made during HTML measurement", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const editorPath = "/src/lib/mcp/editor.ts",
      docPath = "/packages/canvas/src/canvas-document.ts";
    const { editorTool } = await import(/* @vite-ignore */ editorPath);
    const { CanvasDocument } = await import(/* @vite-ignore */ docPath);
    const doc = new CanvasDocument([
      { id: "section", name: "Section", x: 0, y: 0, width: 400, height: 200 },
      {
        id: "child",
        name: "Child",
        parentId: "section",
        kind: "rectangle",
        x: 10,
        y: 10,
        width: 40,
        height: 40,
        fill: "#ffffff",
      },
    ]);
    const controls = { document: doc, prepare: () => {} };
    let resolve!: () => void;
    const ready = new Promise<void>((done) => {
      resolve = done;
    });
    Object.defineProperty(document.fonts, "ready", { configurable: true, value: ready });
    const pending = editorTool(controls, "write_html", {
      targetId: "section",
      html: '<section style="height:200px"><p>Agent change</p></section>',
    }).then(
      () => "unexpected success",
      (error: unknown) => String(error),
    );
    doc.update({ ...doc.getFrame("child"), name: "Human change" });
    resolve();
    const error = await pending;
    Reflect.deleteProperty(document.fonts, "ready");
    return { error, child: doc.getFrame("child"), count: doc.getIds().length };
  });
  expect(result.error).toContain("Target changed during HTML import");
  expect(result.child.name).toBe("Human change");
  expect(result.count).toBe(2);
});
