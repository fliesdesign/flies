import assert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  captureCanvasInstanceVariant,
  createCanvasComponent,
  detachCanvasInstance,
  detachOrphanedComponentLinks,
  expandCanvasComponentTransaction,
  instantiateCanvasComponent,
  isCanvasComponent,
  isCanvasComponentInstance,
  remapCanvasComponentReferences,
  removeCanvasComponentVariant,
  resetCanvasInstanceOverrides,
  setCanvasComponentVariant,
  setCanvasInstanceVariant,
  validateCanvasComponents,
  type CanvasComponentFields,
} from "./canvas-components";
import { CanvasDocument, type CanvasFrame, type CanvasTransaction } from "./canvas-document";
import type { CanvasOperationPlan } from "./canvas-operations";
import { convertCanvasNodeToVector } from "./canvas-vector";

type Node = CanvasFrame & CanvasComponentFields;

const source: Node[] = [
  {
    id: "button",
    name: "Button",
    kind: "frame",
    x: 10,
    y: 20,
    width: 160,
    height: 80,
    fill: "#ffffff",
  },
  {
    id: "label",
    name: "Label",
    kind: "text",
    parentId: "button",
    x: 20,
    y: 30,
    width: 100,
    height: 30,
    text: "Submit",
    color: "#000000",
    fontSize: 20,
  },
  {
    id: "icon",
    name: "Icon",
    kind: "image",
    parentId: "button",
    x: 125,
    y: 35,
    width: 25,
    height: 25,
    src: "data:image/png;base64,AAAA",
  },
];

function apply(nodes: readonly Node[], input: CanvasTransaction): Node[] {
  const expanded = expandCanvasComponentTransaction(nodes, input);
  const current = new Map(nodes.map((node) => [node.id, node]));
  for (const id of expanded.remove ?? []) current.delete(id);
  for (const node of [...(expanded.add ?? []), ...(expanded.update ?? [])])
    current.set(node.id, node);

  return [...current.values()];
}

function commit(nodes: readonly Node[], plan: CanvasOperationPlan) {
  const ids = new Set(nodes.map((node) => node.id));

  return apply(nodes, {
    add: plan.upsert.filter((node) => !ids.has(node.id)),
    update: plan.upsert.filter((node) => ids.has(node.id)),
    remove: plan.remove,
  });
}

function fixture() {
  const master = commit(source, createCanvasComponent(source, "button"));

  return commit(
    master,
    instantiateCanvasComponent(master, "button", { x: 300, y: 200 }, undefined, () => "instance"),
  );
}

const node = (nodes: readonly Node[], id: string) => nodes.find((item) => item.id === id)!;

describe("reusable canvas components", () => {
  it("retains measured override height through source edits, reload, reset, and history", () => {
    const document = new CanvasDocument(fixture());
    const label = document.getFrame("instance/label")!;
    const text = "A much longer label that wraps across several lines.";
    assert.equal(document.update({ ...label, text, height: 120 } as CanvasFrame), true);
    assert.equal(document.getFrame(label.id)?.height, 120);
    assert.equal(document.getFrame("instance")?.instance?.overrides[0].textHeight, 120);
    assert.equal(new CanvasDocument(document.getFrames()).getFrame(label.id)?.height, 120);

    document.undo();
    assert.equal(document.getFrame(label.id)?.height, 30);
    document.redo();
    assert.equal(document.getFrame(label.id)?.height, 120);
    document.update({
      ...document.getFrame("label")!,
      text: "Changed source",
      height: 50,
    } as CanvasFrame);
    assert.equal(document.getFrame(label.id)?.height, 120);

    const reset = resetCanvasInstanceOverrides(document.getFrames(), "instance");
    assert.equal(document.transact({ update: reset.upsert, remove: reset.remove }), true);
    assert.equal(document.getFrame(label.id)?.height, 50);
    document.undo();
    assert.equal(document.getFrame(label.id)?.height, 120);
    document.redo();
    assert.equal(document.getFrame(label.id)?.height, 50);

    for (const invalid of [0, -1, Infinity, "120"])
      assert.equal(
        isCanvasComponentInstance({
          componentId: "button",
          overrides: [{ sourceId: "label", text, textHeight: invalid }],
        }),
        false,
      );
    assert.equal(
      isCanvasComponentInstance({
        componentId: "button",
        overrides: [{ sourceId: "label", textHeight: 120 }],
      }),
      false,
    );
  });

  it("clears editable geometry when an instance overrides an SVG source", () => {
    const vector = convertCanvasNodeToVector({
      id: "icon",
      name: "Icon",
      kind: "rectangle",
      fill: "#ff0000",
      x: 30,
      y: 30,
      width: 20,
      height: 20,
      parentId: "button",
    });

    let nodes = commit(
      [source[0], source[1], vector],
      createCanvasComponent([source[0], source[1], vector], "button"),
    );

    nodes = commit(
      nodes,
      instantiateCanvasComponent(nodes, "button", { x: 300, y: 200 }, undefined, () => "instance"),
    );

    const replacement = convertCanvasNodeToVector({
      id: "other",
      name: "Other",
      kind: "rectangle",
      fill: "#00ff00",
      x: 0,
      y: 0,
      width: 30,
      height: 30,
    });

    nodes = apply(nodes, {
      update: [
        { ...node(nodes, "instance/icon"), src: replacement.src, vector: undefined } as Node,
      ],
    });
    const icon = node(nodes, "instance/icon");
    assert.equal(icon.kind === "svg" ? icon.vector : null, undefined);
    assert.equal(icon.kind === "svg" ? icon.src : null, replacement.src);
    assert.doesNotThrow(() => new CanvasDocument(nodes));
  });

  it("preserves rich text overrides, including an explicit return to plain text", () => {
    let nodes = fixture();
    const runs = [{ start: 0, end: 3, fontWeight: 700 }];
    nodes = apply(nodes, {
      update: [{ ...node(nodes, "instance/label"), text: "Buy now", textRuns: runs } as Node],
    });
    nodes = apply(nodes, { update: [{ ...node(nodes, "label"), text: "Changed source" } as Node] });
    assert.deepEqual((node(nodes, "instance/label") as { textRuns: unknown }).textRuns, runs);
    nodes = apply(nodes, {
      update: [{ ...node(nodes, "instance/label"), textRuns: undefined } as Node],
    });
    assert.deepEqual((node(nodes, "instance/label") as { textRuns: unknown }).textRuns, []);
  });

  it("does not accept newly created instances with dangling masters", () => {
    assert.throws(
      () =>
        apply(source, {
          add: [
            {
              ...source[0],
              id: "dangling",
              instance: { componentId: "missing", overrides: [] },
            } as Node,
          ],
        }),
      /not found/,
    );
  });

  it("materializes ordinary layers and preserves source-relative geometry", () => {
    const nodes = fixture();
    assert.equal(nodes.length, 6);
    assert.equal(node(nodes, "instance").instance?.componentId, "button");
    assert.equal(node(nodes, "instance/label").parentId, "instance");
    assert.equal(node(nodes, "instance/label").componentSourceId, "label");
    assert.equal(node(nodes, "instance/label").x, 310);
    assert.equal(node(nodes, "instance/label").y, 210);
    assert.equal(validateCanvasComponents(nodes), true);
  });

  it("propagates source edits and additions in one transaction with stable existing layer IDs", () => {
    const nodes = fixture();
    const updated = { ...node(nodes, "label"), text: "Continue", x: 30 } as Node;

    const expanded = expandCanvasComponentTransaction(nodes, {
      update: [updated],
      add: [{ ...source[1], id: "extra", text: "New" } as Node],
    });

    assert.ok(
      expanded.update?.some(
        (item) =>
          item.id === "instance/label" &&
          item.kind === "text" &&
          item.text === "Continue" &&
          item.x === 320,
      ),
    );
    assert.ok(expanded.add?.some((item) => item.id === "instance/extra"));
    assert.equal(
      node(apply(nodes, { update: [updated] }), "instance").instance?.overrides.length,
      0,
    );
  });

  it("captures edited text and image overrides and retains them across source changes", () => {
    let nodes = fixture();
    nodes = apply(nodes, {
      update: [
        { ...node(nodes, "instance/label"), text: "Buy" } as Node,
        { ...node(nodes, "instance/icon"), src: "data:image/png;base64,BBBB" } as Node,
      ],
    });
    nodes = apply(nodes, {
      update: [
        { ...node(nodes, "label"), text: "Continue" } as Node,
        { ...node(nodes, "icon"), src: "data:image/png;base64,CCCC" } as Node,
      ],
    });
    assert.equal((node(nodes, "instance/label") as { text: string }).text, "Buy");
    assert.equal(
      (node(nodes, "instance/icon") as { src: string }).src,
      "data:image/png;base64,BBBB",
    );
    assert.equal(node(nodes, "instance").instance?.overrides.length, 2);
    nodes = commit(nodes, resetCanvasInstanceOverrides(nodes, "instance"));
    assert.equal((node(nodes, "instance/label") as { text: string }).text, "Continue");
    assert.equal(node(nodes, "instance").instance?.overrides.length, 0);
  });

  it("switches variants while preserving explicit overrides and falls back when a variant is removed", () => {
    let nodes = fixture();
    nodes = commit(
      nodes,
      setCanvasComponentVariant(nodes, "button", {
        id: "danger",
        name: "Danger",
        overrides: [
          { sourceId: "button", values: { fill: "#ff0000", width: 200 } },
          { sourceId: "label", values: { text: "Delete" } },
        ],
      }),
    );
    nodes = commit(nodes, setCanvasInstanceVariant(nodes, "instance", "danger"));
    assert.equal((node(nodes, "instance") as { fill: string }).fill, "#ff0000");
    assert.equal((node(nodes, "instance/label") as { text: string }).text, "Delete");
    nodes = apply(nodes, {
      update: [{ ...node(nodes, "instance/label"), text: "Remove" } as Node],
    });
    nodes = commit(nodes, removeCanvasComponentVariant(nodes, "button", "danger"));
    assert.equal(node(nodes, "instance").instance?.variantId, undefined);
    assert.equal((node(nodes, "instance/label") as { text: string }).text, "Remove");
    assert.equal(node(nodes, "instance").width, 160);
  });

  it("promotes an instance's overrides into a named variant", () => {
    let nodes = fixture();
    nodes = apply(nodes, {
      update: [{ ...node(nodes, "instance/label"), text: "Cancel" } as Node],
    });
    nodes = commit(
      nodes,
      captureCanvasInstanceVariant(nodes, "instance", "Cancel action", () => "cancel"),
    );
    assert.equal(node(nodes, "instance").instance?.variantId, "cancel");
    assert.equal(node(nodes, "instance").instance?.overrides.length, 0);
    assert.equal((node(nodes, "instance/label") as { text: string }).text, "Cancel");
    assert.equal(node(nodes, "button").component?.variants[0].name, "Cancel action");
    assert.doesNotThrow(() => new CanvasDocument(nodes));
  });

  it("detaches without losing appearance when the master is deleted or explicitly detached", () => {
    const nodes = fixture();

    for (const detached of [
      apply(nodes, { remove: ["button", "label", "icon"] }),
      commit(nodes, detachCanvasInstance(nodes, "instance")),
    ]) {
      assert.equal(node(detached, "instance").instance, undefined);
      assert.equal(node(detached, "instance/label").componentSourceId, undefined);
      assert.equal((node(detached, "instance/label") as { text: string }).text, "Submit");
      assert.equal(validateCanvasComponents(detached), true);
    }
  });

  it("removes deleted source layers and stale override references", () => {
    let nodes = fixture();
    nodes = apply(nodes, {
      update: [{ ...node(nodes, "instance/label"), text: "Changed" } as Node],
    });
    nodes = apply(nodes, { remove: ["label"] });
    assert.equal(
      nodes.some((item) => item.id === "instance/label"),
      false,
    );
    assert.equal(node(nodes, "instance").instance?.overrides.length, 0);
  });

  it("remaps copied sources and links, and detaches copies whose external master is unavailable", () => {
    const nodes = fixture();
    const ids = new Map(nodes.map((item) => [item.id, `copy-${item.id}`]));

    const copied = nodes.map((item) => ({
      ...remapCanvasComponentReferences(item, ids),
      id: ids.get(item.id)!,
      parentId: item.parentId ? ids.get(item.parentId) : undefined,
    }));

    assert.equal(validateCanvasComponents(copied), true);
    const instance = nodes.filter((item) => item.id.startsWith("instance"));

    const detached = detachOrphanedComponentLinks(
      instance.map((item) => remapCanvasComponentReferences(item, new Map(), new Set())),
    );

    assert.equal(
      detached.some((item) => (item as Node).instance || (item as Node).componentSourceId),
      false,
    );
  });

  it("rejects nested instances, cycles, foreign source links and variant structural mutations", () => {
    const nodes = fixture();
    assert.equal(
      validateCanvasComponents(
        nodes.map((item) => (item.id === "instance" ? { ...item, parentId: "button" } : item)),
      ),
      false,
    );
    assert.equal(
      validateCanvasComponents(
        nodes.map((item) =>
          item.id === "instance"
            ? { ...item, instance: { componentId: "instance", overrides: [] } }
            : item,
        ),
      ),
      false,
    );
    assert.equal(
      validateCanvasComponents(
        nodes.map((item) =>
          item.id === "instance/label" ? { ...item, componentSourceId: "instance/icon" } : item,
        ),
      ),
      false,
    );
    assert.equal(
      isCanvasComponent({
        variants: [
          {
            id: "bad",
            name: "Bad",
            overrides: [{ sourceId: "button", values: { parentId: "label" } }],
          },
        ],
      }),
      false,
    );
    assert.throws(() => createCanvasComponent(nodes, "instance"));
  });
});
