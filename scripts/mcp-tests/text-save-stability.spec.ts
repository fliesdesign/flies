/* eslint-disable no-await-in-loop -- Each edit exercises the previous edit's save and focus lifecycle. */
import { expect, test } from "@playwright/test";

import type { DesignFile } from "../../apps/web/src/lib/files";
import { applyDocumentDelta } from "../../packages/canvas/src/canvas-sync";
test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

for (const renderer of ["dom", "webgl2"]) {
  for (const { realtime, saveDelay, cancel } of [
    { realtime: false, saveDelay: 400, cancel: false },
    { realtime: true, saveDelay: 0, cancel: false },
    { realtime: true, saveDelay: 400, cancel: false },
    { realtime: true, saveDelay: 0, cancel: true },
  ]) {
    test(`${renderer} text draft survives sync: realtime=${realtime}, delay=${saveDelay}, cancel=${cancel}`, async ({
      page,
    }) => {
      await page.addInitScript(
        (backend) => localStorage.setItem("flies.canvas.renderer", backend),
        renderer,
      );
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

      let saved: DesignFile = {
        format: "flies",
        version: 1,
        id,
        name: "Text editing",
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
        nodes: [
          { id: "home", kind: "page", name: "Default", x: 0, y: 0, width: 0, height: 0 },
          {
            id: "background",
            kind: "rectangle",
            name: "Background",
            parentId: "home",
            x: 0,
            y: 0,
            width: 900,
            height: 800,
            fill: "#D9D9D9",
          },
        ],
      };

      const account = {
        user: { id: "test", name: "Test", email: "test@example.invalid" },
        workspace: { id: "workspace", name: "My workspace" },
      };

      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/me") return route.fulfill({ json: account });
        if (path === "/api/files")
          return route.fulfill({
            json: {
              workspace: account.workspace,
              warnings: [],
              files: [{ ...saved, preview: [], nodeCount: 1, archived: false }],
            },
          });
        if (path === "/api/sync/ticket")
          return route.fulfill({ json: { enabled: realtime, ticket: "test" } });
        if (path === `/api/files/${id}`) return route.fulfill({ json: saved });

        if (path === `/api/files/${id}/revisions`) {
          const body = route.request().postDataJSON();
          saved = { ...saved, nodes: body.nodes, revision: saved.revision + 1 };
          const response = structuredClone(saved);
          await new Promise((resolve) => setTimeout(resolve, saveDelay));

          return route.fulfill({ json: response });
        }

        return route.fulfill({ status: 404, json: { error: "Not found" } });
      });
      let changeParent: (() => void) | undefined;
      await page.routeWebSocket("**/api/sync/socket", (socket) => {
        socket.send(
          JSON.stringify({
            type: "ready",
            revision: saved.revision,
            connectionId: "test",
            peers: [],
          }),
        );

        changeParent = () => {
          const node = saved.nodes.find((entry) => entry.kind === "text");
          if (!node) throw new Error("Text not saved yet");
          saved = {
            ...saved,
            revision: saved.revision + 1,
            nodes: [
              ...saved.nodes.map((entry) =>
                entry.id === node.id ? { ...entry, parentId: "remote-frame" } : entry,
              ),
              {
                id: "remote-frame",
                kind: "frame",
                name: "Remote frame",
                parentId: "home",
                x: node.x - 10,
                y: node.y - 10,
                width: 300,
                height: 100,
              },
            ],
          };
          socket.send(JSON.stringify({ type: "changed", revision: saved.revision }));
        };

        socket.onMessage(async (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type !== "commit") return;

          const next = applyDocumentDelta(
            { name: saved.name, nodes: saved.nodes, theme: saved.theme ?? { tokens: [] } },
            message.change.delta,
          );

          saved = { ...saved, ...next, revision: saved.revision + 1 };
          const revision = saved.revision;
          await new Promise((resolve) => setTimeout(resolve, saveDelay));
          socket.send(
            JSON.stringify({ type: "ack", mutationId: message.change.mutationId, revision }),
          );
        });
      });
      await page.goto(`/files/${id}`);
      const surface = page.getByRole("application", { name: "Design canvas" });
      await expect(surface).toBeVisible();
      await expect(surface).toHaveAttribute("data-renderer", renderer);

      for (let index = 0; index < 4; index++) {
        await page.getByRole("button", { name: "Text (T)", exact: true }).click();
        await surface.click({ position: { x: 250, y: 150 + index * 70 } });
        const editor = page.locator("textarea.canvas-text-editor");
        await editor.fill(`Retained text ${index}`);
        // The creation save can finish while the text is still an uncommitted draft.
        await page.waitForTimeout([200, 0, 700, 200][index]);

        if (realtime && index === 0) {
          await expect.poll(() => saved.nodes.some((node) => node.kind === "text")).toBe(true);
          changeParent!();
          await page.waitForTimeout(700);
        }

        await expect(editor).toHaveValue(`Retained text ${index}`);

        if (cancel) {
          await editor.press("Escape");
          await expect(editor).toHaveCount(0);
          await expect(
            page.getByRole("treeitem", { name: "Remote frame", exact: true }),
          ).toBeVisible();
          expect(saved.nodes.find((node) => node.kind === "text")).toMatchObject({
            text: "Text",
            parentId: "remote-frame",
          });
          expect(errors).toEqual([]);

          return;
        }

        await surface.click({ position: { x: 600, y: 500 } });
        await expect(editor).toHaveCount(0);
        await expect
          .poll(() =>
            saved.nodes.some((node) => Reflect.get(node, "text") === `Retained text ${index}`),
          )
          .toBe(true);
      }

      // Undo and redo the final text commit, rather than losing the entire created layer.
      await page.keyboard.press("ControlOrMeta+z");
      await expect
        .poll(() => saved.nodes.find((node) => node.name === "Text 4"))
        .toMatchObject({ text: "Text" });
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await expect
        .poll(() => saved.nodes.find((node) => node.name === "Text 4"))
        .toMatchObject({ text: "Retained text 3" });

      if (realtime) {
        await expect(
          page.getByRole("treeitem", { name: "Remote frame", exact: true }),
        ).toBeVisible();
        expect(saved.nodes.find((node) => node.name === "Text 1")).toMatchObject({
          parentId: "remote-frame",
          text: "Retained text 0",
        });
      }

      expect(errors).toEqual([]);
      await page.reload();
      await expect(surface).toBeVisible();
      expect(
        saved.nodes.filter((node) => node.kind === "text").map((node) => Reflect.get(node, "text")),
      ).toEqual(["Retained text 0", "Retained text 1", "Retained text 2", "Retained text 3"]);
    });
  }
}
