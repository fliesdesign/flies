import {
  normalizeTheme,
  worldTransform,
  worldBounds,
  inverseMatrix,
  transformPoint,
  worldCorners,
  resizeSelection,
  applyTokenBindings,
  isTokenBindings,
  THEME_PROPERTIES,
  canonicalThemeProperty,
  type CanvasLayout,
  type ThemeProperty,
} from "@flies/canvas";
import { ensureCanvasFont, ensureCanvasFonts } from "@flies/canvas";
import { CanvasDocument, type CanvasFrame, agentActivity } from "@flies/canvas";
import { importSource, type SourceFormat } from "@flies/html";

import { measureCanvasTextHeight } from "@/components/canvas/canvas-node-content";
import type { CanvasControls } from "@/components/canvas/design-canvas";
import { updateDocumentTheme, prepareTokenUpdates } from "@/lib/canvas-theme-actions";

import { htmlWarnings } from "./html-diagnostics";
import { inheritedStyles, validateSharedCss } from "./styles";

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

function layoutPatch(value: unknown, current?: CanvasLayout): CanvasLayout | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new Error("layout must be an object or null.");

  for (const key of Object.keys(value)) {
    if (!["direction", "gap", "padding", "align", "justify"].includes(key))
      throw new Error(`Unsupported layout property: ${key}`);
  }

  return {
    direction: "row",
    gap: 16,
    padding: 16,
    align: "start",
    justify: "start",
    ...current,
    ...value,
  };
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
    if (!node) throw new Error(`Node ${id} does not exist in this file.`);

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
    case "get_theme":
      return textResult({
        ...doc.getTheme(),
        cssVariables: doc.getTheme().tokens.map((token) => ({
          id: token.id,
          variable: `--${token.id}`,
          uses: doc
            .getFrames()
            .filter((node) => Object.values(node.tokenBindings ?? {}).includes(token.id)).length,
        })),
      });

    case "set_theme": {
      if (!Array.isArray(args.tokens)) throw new Error("tokens must be an array.");
      if (args.replace !== undefined && typeof args.replace !== "boolean")
        throw new Error("replace must be a boolean.");
      const updates = normalizeTheme({ tokens: args.tokens });
      const remove = args.deleteTokenIds ?? [];
      if (!Array.isArray(remove) || !remove.every((id) => typeof id === "string"))
        throw new Error("deleteTokenIds must be an array of token IDs.");

      const merged = new Map(
        (args.replace ? [] : doc.getTheme().tokens).map((token) => [token.id, token]),
      );

      for (const id of remove) merged.delete(id);
      for (const token of updates.tokens) merged.set(token.id, token);
      await updateDocumentTheme(doc, { tokens: [...merged.values()] });

      return textResult({ theme: doc.getTheme(), revision: doc.getSnapshot().revision });
    }

    case "apply_tokens": {
      const ids = args.nodeIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 1000 ||
        !ids.every((id) => typeof id === "string")
      )
        throw new Error("nodeIds must contain 1–1000 IDs.");
      if (!args.bindings || typeof args.bindings !== "object" || Array.isArray(args.bindings))
        throw new Error("bindings must map properties to token IDs or null.");
      if (
        Object.keys(args.bindings).some(
          (key) => !Object.prototype.hasOwnProperty.call(THEME_PROPERTIES, key),
        )
      )
        throw new Error("Unknown token property.");

      const requested = Object.fromEntries(
        Object.entries(args.bindings).filter(([, id]) => id !== null),
      );

      if (!isTokenBindings(requested)) throw new Error("Invalid token bindings.");
      const originals = [...new Set(ids)].map(getNode);
      const theme = doc.getTheme();

      const updates = originals.map((node) => {
        const bindings = { ...node.tokenBindings };

        for (const [property, id] of Object.entries(
          args.bindings as Record<string, string | null>,
        )) {
          const canonical = canonicalThemeProperty(node, property as ThemeProperty);
          if (id === null) Reflect.deleteProperty(bindings, canonical);
          else Reflect.set(bindings, canonical, id);
        }

        return applyTokenBindings(node, theme, bindings, true);
      });

      await prepareTokenUpdates(updates, originals);
      if (doc.getTheme() !== theme || originals.some((node) => doc.getFrame(node.id) !== node))
        throw new Error("Document changed while applying tokens. Try again.");
      commit([], updates);

      return textResult({ nodes: originals.map((node) => doc.getFrame(node.id)) });
    }

    case "get_selection":
      return textResult({ nodeIds: controls.getSelection() });

    case "get_node_info": {
      const node = getNode(stringArg(args, "nodeId"));

      return textResult({
        node,
        worldBounds: worldBounds(doc, node),
        children: doc.getChildren(node.id),
      });
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
        ...(args.widthSizing !== undefined &&
          args.widthSizing !== null && {
            widthSizing: args.widthSizing,
          }),
        ...(args.heightSizing !== undefined &&
          args.heightSizing !== null && {
            heightSizing: args.heightSizing,
          }),
        ...(args.layout !== undefined && { layout: layoutPatch(args.layout) }),
      } as CanvasFrame;

      commit([node]);
      controls.select(node.id);

      return textResult({ nodeId: node.id });
    }

    case "preview_html": {
      const nodeId = args.nodeId === undefined ? undefined : getNode(stringArg(args, "nodeId")).id;
      const width = numberArg(args, "width", 1280);
      const height = numberArg(args, "height", 800);
      if (width < 40 || width > 8192 || height < 40 || height > 8192)
        throw new Error("Preview dimensions must be between 40 and 8192px.");

      const css =
        inheritedStyles(doc, nodeId) +
        "\n" +
        (args.css === undefined ? "" : validateSharedCss(args.css));

      const { openPrototype } = await import("./prototype");
      await openPrototype(stringArg(args, "html"), css, width, height);

      return textResult({
        opened: true,
        width,
        height,
        mode: "interactive",
        persisted: false,
        capabilities: [
          "CSS gradients",
          "hover/focus",
          "CSS animation",
          "inline JavaScript",
          "Tailwind",
        ],
        network: "Fetch and external assets blocked except Google Fonts",
        screenshot: "get_screenshot captures native canvas nodes, not this preview.",
      });
    }

    case "close_preview": {
      const { closePrototype } = await import("./prototype");
      closePrototype();

      return textResult({ closed: true });
    }

    case "set_styles": {
      const node = getNode(stringArg(args, "nodeId"));
      if (node.kind && node.kind !== "frame")
        throw new Error("Shared styles belong to a frame or artboard.");
      const css = validateSharedCss(args.css);
      commit([], [{ ...node, htmlStyles: css }]);

      return textResult({
        nodeId: node.id,
        css,
        appliesTo:
          "Future descendant write_html calls and previews; existing native layers keep their measured styles.",
      });
    }

    case "fit_node": {
      const node = getNode(stringArg(args, "nodeId"));
      if (node.kind && node.kind !== "frame" && node.kind !== "group")
        throw new Error("fit_node requires a frame or group.");
      const axis = args.axis ?? "both";
      if (!["both", "width", "height"].includes(String(axis)))
        throw new Error("axis must be both, width or height.");
      const padding = numberArg(args, "padding", 0);
      if (padding < 0) throw new Error("padding must be non-negative.");
      if (args.clipContent !== undefined && typeof args.clipContent !== "boolean")
        throw new Error("clipContent must be a boolean.");
      if (node.kind === "group" && args.clipContent !== undefined)
        throw new Error("Groups do not clip content; use a frame.");

      const children = doc
        .getDescendantIds(doc.getChildren(node.id))
        .map(getNode)
        .filter((child) => !doc.isHidden(child.id));

      if (!children.length) throw new Error("This node has no visible content to fit.");

      const inverse = inverseMatrix(worldTransform(doc, node));

      const corners = children.flatMap((child) =>
        worldCorners(doc, child).map((point) => transformPoint(inverse, point)),
      );

      const updated = {
        ...node,
        ...(axis !== "height" && { widthSizing: "fixed" }),
        ...(axis !== "width" && { heightSizing: "fixed" }),
        width:
          axis === "height"
            ? node.width
            : corners.reduce(
                (extent, point) => Math.max(extent, point.x + padding),
                node.kind === "group" ? 1 : 40,
              ),
        height:
          axis === "width"
            ? node.height
            : corners.reduce(
                (extent, point) => Math.max(extent, point.y + padding),
                node.kind === "group" ? 1 : 40,
              ),
        ...(node.kind !== "group" && { clipContent: args.clipContent ?? true }),
      } as CanvasFrame;

      const angle = ((node.rotation ?? 0) * Math.PI) / 180;

      const halfWidth = (updated.width - node.width) / 2,
        halfHeight = (updated.height - node.height) / 2;

      // Keep the painted origin fixed while changing a rotated frame's center.
      const fitted = {
        ...updated,
        x: updated.x + Math.cos(angle) * halfWidth - Math.sin(angle) * halfHeight - halfWidth,
        y: updated.y + Math.sin(angle) * halfWidth + Math.cos(angle) * halfHeight - halfHeight,
      };

      const contents =
        node.kind === "group"
          ? []
          : resizeSelection(doc.getFrames(), [node.id], node, fitted).filter(
              (child) => child.id !== node.id,
            );

      commit([], [fitted, ...contents]);

      return textResult({ node: doc.getFrame(node.id) });
    }

    case "write_html":

    case "write_source": {
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

      const requestedFormat = name === "write_html" ? "html" : (args.format ?? "auto");
      if (typeof requestedFormat !== "string" || !["auto", "html", "jsx"].includes(requestedFormat))
        throw new Error("Source format must be auto, html or jsx (including TSX).");

      const imported = await importSource(
        stringArg(args, name === "write_html" ? "html" : "source"),
        {
          format: requestedFormat as SourceFormat,
          css: inheritedStyles(doc, anchor?.id),
          parentId: target ? target.parentId : parent?.id,
          x: (anchor?.x ?? 0) + numberArg(args, "x", 0),
          y: (anchor?.y ?? 0) + numberArg(args, "y", 0),
          width: numberArg(args, "width", Math.max(40, anchor?.width ?? 800)),
          height: args.height === undefined ? anchor?.height : numberArg(args, "height", 600),
        },
      );

      let nodes = imported.nodes;

      // Isolated HTML measurement loads fonts into its iframe; native diagnostics use this document.
      await ensureCanvasFonts(nodes.filter((node) => node.kind === "text"));

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
            ? {
                ...node,
                id: target.id,
                hidden: target.hidden,
                locked: target.locked,
                ...((!node.kind || node.kind === "frame") &&
                  (!target.kind || target.kind === "frame") && { htmlStyles: target.htmlStyles }),
              }
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
        ...(node.rotation !== undefined ? { rotation: node.rotation } : {}),
        worldBounds: worldBounds(resultDoc, node),
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
      });

      return textResult({
        applied: !args.validateOnly,
        format: imported.format,
        sourceWarnings: imported.warnings,
        nodeIds: args.validateOnly ? [] : nodes.map((node) => node.id),
        roots: nodes
          .filter((node) => !node.parentId || !importedIds.has(node.parentId))
          .map(describe),
        containers: nodes
          .filter((node) => !node.kind || node.kind === "frame" || node.kind === "group")
          .map(describe),
        warnings: htmlWarnings(resultDoc, nodes, Boolean(args.validateOnly)),
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
        "widthSizing",
        "heightSizing",
        "parentId",
        "hidden",
        "locked",
        "opacity",
        "rotation",
        "gradient",
        "blendMode",
        "filters",
        "cornerRadius",
        "borderWidth",
        "borderColor",
        "shadows",
      ];

      const byKind = {
        frame: ["fill", "clipContent", "layout", "htmlStyles"],
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
        svg: ["src"],
        pen: ["points", "stroke", "strokeWidth", "pathWidth", "pathHeight"],
      };

      const allowed = new Set([...base, ...byKind[before.kind ?? "frame"]]);
      for (const key of Object.keys(props))
        if (!allowed.has(key))
          throw new Error(
            `Unsupported property for ${before.kind ?? "frame"}: ${key}. Editable properties: ${[...allowed].join(", ")}.`,
          );
      if (!Object.keys(props).length)
        throw new Error("properties must contain at least one field.");
      const patch = { ...props } as Record<string, unknown>;
      if (patch.htmlStyles !== undefined && patch.htmlStyles !== null)
        validateSharedCss(patch.htmlStyles);

      if (patch.layout !== undefined && (!before.kind || before.kind === "frame")) {
        patch.layout = layoutPatch(patch.layout, before.layout);
      }

      for (const axis of ["width", "height"] as const) {
        const sizing = `${axis}Sizing` as const;
        if (patch[axis] !== undefined && patch[sizing] === undefined) patch[sizing] = "fixed";

        if (
          props &&
          "layout" in props &&
          patch.layout === undefined &&
          before[sizing] === "hug" &&
          patch[sizing] === undefined
        ) {
          patch[sizing] = "fixed";
        }
      }

      let updated = { ...before, ...patch } as CanvasFrame;

      const optional = new Set([
        "parentId",
        "widthSizing",
        "heightSizing",
        "hidden",
        "locked",
        "opacity",
        "rotation",
        "gradient",
        "blendMode",
        "filters",
        "cornerRadius",
        "borderWidth",
        "borderColor",
        "shadows",
        "clipContent",
        "layout",
        "htmlStyles",
        "fontFamily",
        "fontWeight",
        "lineHeight",
        "letterSpacing",
        "textAlign",
        "fontStyle",
        "textDecoration",
      ]);

      for (const [key, value] of Object.entries(patch)) {
        if (value === null && optional.has(key)) Reflect.deleteProperty(updated, key);
      }

      const staged = validate([], [updated], []);

      if (updated.kind === "text") {
        await ensureCanvasFont(updated);
        if (doc.getFrame(before.id) !== before)
          throw new Error(
            "Target changed while loading its font. Read the node again before retrying.",
          );
        const reflowWidth = staged.getFrame(updated.id)!.width;

        // Match the editor's typography measurement, while keeping generous text boxes
        // and respecting an explicit crop or height controlled by its layout parent.
        if (
          before.kind === "text" &&
          patch.height === undefined &&
          updated.heightSizing !== "fill" &&
          (updated.text !== before.text ||
            reflowWidth !== before.width ||
            updated.fontSize !== before.fontSize ||
            updated.fontFamily !== before.fontFamily ||
            updated.fontWeight !== before.fontWeight ||
            updated.fontStyle !== before.fontStyle ||
            updated.lineHeight !== before.lineHeight ||
            updated.letterSpacing !== before.letterSpacing)
        ) {
          updated = {
            ...updated,
            height: Math.max(
              updated.height,
              measureCanvasTextHeight({ ...updated, width: reflowWidth }),
            ),
          };
        }
      }

      const updates = [updated];

      const resized =
        (!before.kind || before.kind === "frame") &&
        before.rotation &&
        (updated.width !== before.width || updated.height !== before.height)
          ? resizeSelection(doc.getFrames(), [before.id], before, {
              ...before,
              width: updated.width,
              height: updated.height,
            })
          : [];

      const resizedById = new Map(resized.map((child) => [child.id, child]));
      const dx = updated.x - before.x;
      const dy = updated.y - before.y;

      if (
        (!before.kind || before.kind === "frame" || before.kind === "group") &&
        (dx !== 0 || dy !== 0 || resized.length > 0)
      ) {
        // Match UI frame cropping, then translate the contents with the container.
        for (const id of doc.getDescendantIds(doc.getChildren(before.id))) {
          const child = resizedById.get(id) ?? getNode(id);
          updates.push({ ...child, x: child.x + dx, y: child.y + dy });
        }
      }

      commit([], updates);

      const committed = doc.getFrame(before.id)!;

      return textResult({
        node: committed,
        ...(committed.kind === "text" && { warnings: htmlWarnings(doc, [committed]) }),
      });
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
