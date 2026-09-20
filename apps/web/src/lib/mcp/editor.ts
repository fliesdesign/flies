import { CanvasDocument, type CanvasFrame, agentActivity } from "@flies/canvas";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { importHtml } from "./html";

export type McpResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  isError?: boolean;
};
export const textResult = (value: unknown): McpResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
export const errorResult = (error: unknown): McpResult => ({
  isError: true,
  content: [{ type: "text", text: String(error) }],
});

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${key} must be a non-empty string.`);
  return value;
}
function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${key} must be a finite number.`);
  return value;
}

export async function editorTool(
  controls: CanvasControls,
  name: string,
  args: Record<string, unknown>,
): Promise<McpResult> {
  controls.prepare();
  const doc = controls.document;
  const getNode = (id: string) => {
    const node = doc.getFrame(id);
    if (!node) throw new Error(`Node ${id} does not exist in the active file.`);
    return node;
  };
  const validate = (add: CanvasFrame[], update: CanvasFrame[], remove: string[]) => {
    const removed = new Set(remove);
    const updates = new Map(update.map((node) => [node.id, node]));
    // Validate the whole transaction before changing anything; the document rejects invalid edits silently.
    const validated = new CanvasDocument([
      ...doc
        .getFrames()
        .filter((node) => !removed.has(node.id))
        .map((node) => updates.get(node.id) ?? node),
      ...add,
    ]);
    if (validated.getIds().length > 100_000)
      throw new Error("Document is limited to 100,000 nodes.");
    return validated;
  };
  const commit = (add: CanvasFrame[] = [], update: CanvasFrame[] = [], remove: string[] = []) => {
    validate(add, update, remove);
    return agentActivity(doc).capture(doc, () => doc.transact({ add, update, remove }));
  };
  switch (name) {
    case "get_selection":
      return textResult({ nodeIds: controls.getSelection() });
    case "get_node_info": {
      const node = getNode(stringArg(args, "nodeId"));
      return textResult({ node, children: doc.getChildren(node.id) });
    }
    case "get_tree": {
      const depth = numberArg(args, "depth", 5);
      if (!Number.isInteger(depth) || depth < 0 || depth > 20)
        throw new Error("depth must be an integer between 0 and 20.");
      let count = 0;
      const tree = (id: string, level: number): unknown => {
        if (++count > 5000)
          throw new Error("Tree is too large. Request a specific node or a smaller depth.");
        const node = getNode(id);
        return {
          id,
          name: node.name,
          kind: node.kind ?? "frame",
          childCount: doc.getChildren(id).length,
          ...(level < depth
            ? { children: doc.getChildren(id).map((child) => tree(child, level + 1)) }
            : {}),
        };
      };
      const roots =
        args.nodeId === undefined ? doc.getChildren() : [getNode(stringArg(args, "nodeId")).id];
      return textResult({ nodes: roots.map((id) => tree(id, 0)) });
    }
    case "create_artboard": {
      const node: CanvasFrame = {
        id: crypto.randomUUID(),
        name: stringArg(args, "name"),
        kind: "frame",
        x: numberArg(args, "x", 0),
        y: numberArg(args, "y", 0),
        width: numberArg(args, "width", 800),
        height: numberArg(args, "height", 600),
        fill: args.fill === undefined ? "#ffffff" : stringArg(args, "fill"),
      };
      commit([node]);
      controls.select(node.id);
      return textResult({ nodeId: node.id });
    }
    case "write_html": {
      const target = args.targetId === undefined ? undefined : getNode(stringArg(args, "targetId"));
      if (target && (args.parentId !== undefined || args.replace !== undefined))
        throw new Error("Use targetId alone to replace one node, or parentId to edit children.");
      const parent = args.parentId === undefined ? undefined : getNode(stringArg(args, "parentId"));
      if (parent && parent.kind && parent.kind !== "frame" && parent.kind !== "group")
        throw new Error("parentId must be a frame or group.");
      if (args.replace !== undefined && typeof args.replace !== "boolean")
        throw new Error("replace must be a boolean.");
      if (args.replace && !parent) throw new Error("replace requires parentId.");
      if (args.validateOnly !== undefined && typeof args.validateOnly !== "boolean")
        throw new Error("validateOnly must be a boolean.");
      const anchor = target ?? parent;
      const replacing = target ?? (args.replace ? parent : undefined);
      const descendants = replacing ? doc.getDescendantIds(doc.getChildren(replacing.id)) : [];
      const originals = descendants.map(getNode);
      let nodes = await importHtml(stringArg(args, "html"), {
        parentId: target ? target.parentId : parent?.id,
        x: (anchor?.x ?? 0) + numberArg(args, "x", 0),
        y: (anchor?.y ?? 0) + numberArg(args, "y", 0),
        width: numberArg(args, "width", Math.max(40, anchor?.width ?? 800)),
        height: args.height === undefined ? anchor?.height : numberArg(args, "height", 600),
      });
      // Do not overwrite human edits that happened while fonts/images were measured.
      if (
        (anchor && doc.getFrame(anchor.id) !== anchor) ||
        (replacing &&
          (doc.getDescendantIds(doc.getChildren(replacing.id)).length !== descendants.length ||
            doc
              .getDescendantIds(doc.getChildren(replacing.id))
              .some((id, index) => id !== descendants[index]) ||
            originals.some((node) => doc.getFrame(node.id) !== node)))
      )
        throw new Error("Target changed during HTML import. Inspect it and retry.");
      let updates: CanvasFrame[] = [];
      if (target) {
        const ids = new Set(nodes.map((node) => node.id));
        const roots = nodes.filter((node) => !node.parentId || !ids.has(node.parentId));
        if (roots.length !== 1)
          throw new Error("targetId replacement requires exactly one root element.");
        const root = roots[0];
        nodes = nodes.map((node) =>
          node.id === root.id
            ? { ...node, id: target.id, hidden: target.hidden, locked: target.locked }
            : node.parentId === root.id
              ? { ...node, parentId: target.id }
              : node,
        );
        updates = nodes.filter((node) => node.id === target.id);
      }
      const added = nodes.filter((node) => node.id !== target?.id);
      const preview = validate(added, updates, descendants);
      if (!args.validateOnly)
        agentActivity(doc).capture(doc, () =>
          doc.transact({ add: added, update: updates, remove: descendants }),
        );
      const resultDoc = args.validateOnly ? preview : doc;
      // Native auto-layout or group bounds may have adjusted the measured positions.
      nodes = nodes.map((node) => resultDoc.getFrame(node.id)!);
      const importedIds = new Set(nodes.map((node) => node.id));
      const describe = (node: CanvasFrame) => ({
        id: args.validateOnly ? undefined : node.id,
        parentId: args.validateOnly ? undefined : node.parentId,
        name: node.name,
        kind: node.kind ?? "frame",
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      });
      return textResult({
        applied: !args.validateOnly,
        nodeIds: args.validateOnly ? [] : nodes.map((node) => node.id),
        roots: nodes
          .filter((node) => !node.parentId || !importedIds.has(node.parentId))
          .map(describe),
        containers: nodes
          .filter((node) => !node.kind || node.kind === "frame" || node.kind === "group")
          .map(describe),
        summary: {
          layers: nodes.length,
          textLayers: nodes.filter((node) => node.kind === "text").length,
        },
      });
    }
    case "update_node": {
      const before = getNode(stringArg(args, "nodeId"));
      const props = args.properties;
      if (!props || typeof props !== "object" || Array.isArray(props))
        throw new Error("properties must be an object.");
      const base = [
        "name",
        "x",
        "y",
        "width",
        "height",
        "parentId",
        "hidden",
        "locked",
        "opacity",
        "cornerRadius",
        "borderWidth",
        "borderColor",
        "shadows",
      ];
      const byKind = {
        frame: ["fill", "clipContent", "layout"],
        group: [],
        rectangle: ["fill"],
        text: [
          "text",
          "fontSize",
          "color",
          "fontFamily",
          "fontWeight",
          "lineHeight",
          "letterSpacing",
          "textAlign",
          "fontStyle",
          "textDecoration",
        ],
        image: ["src"],
        pen: ["points", "stroke", "strokeWidth", "pathWidth", "pathHeight"],
      };
      const allowed = new Set([...base, ...byKind[before.kind ?? "frame"]]);
      for (const key of Object.keys(props))
        if (!allowed.has(key)) throw new Error(`Unsupported property: ${key}`);
      const updated = { ...before, ...props } as CanvasFrame;
      const updates = [updated];
      const dx = updated.x - before.x;
      const dy = updated.y - before.y;
      if (
        (!before.kind || before.kind === "frame" || before.kind === "group") &&
        (dx !== 0 || dy !== 0)
      ) {
        // Nodes store world coordinates; moving a container must move its whole subtree.
        for (const id of doc.getDescendantIds(doc.getChildren(before.id))) {
          const child = getNode(id);
          updates.push({ ...child, x: child.x + dx, y: child.y + dy });
        }
      }
      commit([], updates);
      return textResult({ node: doc.getFrame(before.id) });
    }
    case "delete_nodes": {
      const ids = args.nodeIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 1000 ||
        !ids.every((id) => typeof id === "string")
      )
        throw new Error("nodeIds must contain 1–1000 node IDs.");
      ids.forEach(getNode);
      const removed = doc.getDescendantIds(ids);
      commit([], [], removed);
      return textResult({ removed });
    }
    case "set_selection": {
      const id = args.nodeId === undefined ? null : getNode(stringArg(args, "nodeId")).id;
      controls.select(id);
      return textResult({ nodeId: id });
    }
    case "undo":
      agentActivity(doc).capture(doc, () => doc.undo());
      return textResult({ revision: doc.getSnapshot().revision });
    case "redo":
      agentActivity(doc).capture(doc, () => doc.redo());
      return textResult({ revision: doc.getSnapshot().revision });
    case "get_screenshot": {
      const ids =
        args.nodeId === undefined ? doc.getChildren() : [getNode(stringArg(args, "nodeId")).id];
      const { exportCanvasPng } = await import("@/components/canvas/canvas-export");
      const blob = await exportCanvasPng(doc.getCommittedFrames(), ids);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result).split(",")[1]), {
          once: true,
        });
        reader.addEventListener("error", () => reject(new Error("Failed to encode screenshot.")), {
          once: true,
        });
        reader.readAsDataURL(blob);
      });
      return { content: [{ type: "image", data, mimeType: "image/png" }] };
    }
    default:
      throw new Error(`Unknown editor tool: ${name}`);
  }
}
