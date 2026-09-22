/* oxlint-disable oxc/no-map-spread -- Immutable document snapshots preserve undo and subscription identity. */
import type {
  CanvasFrame,
  CanvasFrameNode,
  CanvasText,
  CanvasTransaction,
} from "./canvas-document";
import type { Point } from "./canvas-geometry";
import type { CanvasOperationPlan } from "./canvas-operations";
import { isCanvasTextRuns, type CanvasTextRun } from "./canvas-rich-text";

export type CanvasComponentVariantValues = Readonly<
  Partial<
    Pick<
      CanvasFrame,
      | "width"
      | "height"
      | "opacity"
      | "rotation"
      | "cornerRadius"
      | "borderWidth"
      | "borderColor"
      | "shadows"
      | "gradient"
      | "filters"
      | "hidden"
    > &
      Pick<
        CanvasText,
        | "text"
        | "textRuns"
        | "fontSize"
        | "color"
        | "fontFamily"
        | "fontWeight"
        | "lineHeight"
        | "letterSpacing"
        | "textAlign"
        | "fontStyle"
        | "textDecoration"
      > &
      Pick<CanvasFrameNode, "fill" | "clipContent" | "layout"> & { src: string }
  >
>;
export type CanvasComponentVariant = Readonly<{
  id: string;
  name: string;
  overrides: readonly Readonly<{ sourceId: string; values: CanvasComponentVariantValues }>[];
}>;
export type CanvasComponentDefinition = Readonly<{ variants: readonly CanvasComponentVariant[] }>;
export type CanvasComponentOverride = Readonly<{
  sourceId: string;
  text?: string;
  textRuns?: readonly CanvasTextRun[];
  /** Measured editable text height, retained with the content override. */
  textHeight?: number;
  src?: string;
}>;
export type CanvasComponentInstance = Readonly<{
  componentId: string;
  variantId?: string;
  overrides: readonly CanvasComponentOverride[];
}>;
export type CanvasComponentFields = Readonly<{
  component?: CanvasComponentDefinition;
  instance?: CanvasComponentInstance;
  componentSourceId?: string;
}>;
type ComponentNode = CanvasFrame & CanvasComponentFields;
const metadata = (node: CanvasFrame) => node as ComponentNode;
const isFrame = (node: CanvasFrame) => node.kind === undefined || node.kind === "frame";

function patchedNode(node: CanvasFrame, values: object | undefined): CanvasFrame {
  const value = { ...clean(node), ...values } as CanvasFrame;
  if (value.kind === "svg" && node.kind === "svg" && value.src !== node.src)
    delete (value as { vector?: unknown }).vector;

  return value;
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const variantKeys = new Set(
  "width height opacity rotation cornerRadius borderWidth borderColor shadows gradient filters hidden text textRuns fontSize color fontFamily fontWeight lineHeight letterSpacing textAlign fontStyle textDecoration fill clipContent layout src".split(
    " ",
  ),
);

export function isCanvasComponent(value: unknown): value is CanvasComponentDefinition {
  if (!object(value) || !Array.isArray(value.variants) || value.variants.length > 100) return false;
  const ids = new Set<string>();

  return value.variants.every((variant: unknown) => {
    if (
      !object(variant) ||
      !nonempty(variant.id) ||
      !nonempty(variant.name) ||
      ids.has(variant.id) ||
      !Array.isArray(variant.overrides)
    )
      return false;
    ids.add(variant.id);
    const sources = new Set<string>();

    return variant.overrides.every((patch: unknown) => {
      if (
        !object(patch) ||
        !nonempty(patch.sourceId) ||
        sources.has(patch.sourceId) ||
        !object(patch.values) ||
        !Object.keys(patch.values).every((key) => variantKeys.has(key))
      )
        return false;
      sources.add(patch.sourceId);

      return true;
    });
  });
}

export function isCanvasComponentInstance(value: unknown): value is CanvasComponentInstance {
  if (
    !object(value) ||
    !nonempty(value.componentId) ||
    (value.variantId !== undefined && !nonempty(value.variantId)) ||
    !Array.isArray(value.overrides)
  )
    return false;
  const sources = new Set<string>();

  return value.overrides.every((patch: unknown) => {
    if (
      !object(patch) ||
      !nonempty(patch.sourceId) ||
      sources.has(patch.sourceId) ||
      (patch.text !== undefined && typeof patch.text !== "string") ||
      (patch.textRuns !== undefined &&
        (typeof patch.text !== "string" || !isCanvasTextRuns(patch.textRuns, patch.text))) ||
      (patch.textHeight !== undefined &&
        (typeof patch.text !== "string" ||
          typeof patch.textHeight !== "number" ||
          !Number.isFinite(patch.textHeight) ||
          patch.textHeight < 1)) ||
      (patch.src !== undefined && typeof patch.src !== "string") ||
      Object.keys(patch).some(
        (key) => !["sourceId", "text", "textRuns", "textHeight", "src"].includes(key),
      )
    )
      return false;
    sources.add(patch.sourceId);

    return true;
  });
}

function subtree(nodes: readonly CanvasFrame[], id: string): ComponentNode[] {
  const selected = new Set([id]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const node of nodes) {
      if (node.parentId && selected.has(node.parentId) && !selected.has(node.id)) {
        selected.add(node.id);
        changed = true;
      }
    }
  }

  return nodes.filter((node) => selected.has(node.id)).map(metadata);
}

function clean(node: ComponentNode): CanvasFrame {
  const { component: _component, instance: _instance, componentSourceId: _source, ...frame } = node;

  return frame as CanvasFrame;
}

/** Structural references are validated separately from ordinary node paint/geometry validation. */
export function validateCanvasComponents(
  nodes: readonly CanvasFrame[],
  validateNode: (node: CanvasFrame) => boolean = () => true,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, metadata(node)]));

  for (const raw of nodes) {
    const node = metadata(raw);
    if (
      node.component !== undefined &&
      (!isFrame(node) || !isCanvasComponent(node.component) || node.instance)
    )
      return false;
    if (
      node.instance !== undefined &&
      (!isFrame(node) || !isCanvasComponentInstance(node.instance) || node.component)
    )
      return false;
    if (node.componentSourceId !== undefined && !nonempty(node.componentSourceId)) return false;
    const visited = new Set([node.id]);
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    let owner: ComponentNode | undefined;

    while (parent) {
      if (visited.has(parent.id)) return false;
      visited.add(parent.id);

      if (parent.component || parent.instance) {
        if (node.component || node.instance) return false;
        owner ??= parent;
      }

      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }

    if (node.componentSourceId && (!owner?.instance || !byId.has(node.componentSourceId)))
      return false;

    if (node.component) {
      const source = new Map(subtree(nodes, node.id).map((child) => [child.id, child]));

      for (const variant of node.component.variants) {
        for (const patch of variant.overrides) {
          const original = source.get(patch.sourceId);
          if (!original || !validateNode(patchedNode(original, patch.values))) return false;
        }
      }
    }

    if (node.instance) {
      const source = byId.get(node.instance.componentId);
      if (!source?.component || source.id === node.id) return false;
      if (
        node.instance.variantId &&
        !source.component.variants.some((variant) => variant.id === node.instance!.variantId)
      )
        return false;
      const sources = new Map(subtree(nodes, source.id).map((child) => [child.id, child]));
      const linked = new Set<string>();

      for (const child of subtree(nodes, node.id)) {
        if (!child.componentSourceId) continue;
        if (!sources.has(child.componentSourceId) || linked.has(child.componentSourceId))
          return false;
        linked.add(child.componentSourceId);
      }

      for (const override of node.instance.overrides) {
        const original = sources.get(override.sourceId);
        if (
          !original ||
          (override.text !== undefined && original.kind !== "text") ||
          (override.src !== undefined && original.kind !== "image" && original.kind !== "svg")
        )
          return false;
        if (
          !validateNode(
            patchedNode(original, {
              ...override,
              ...(override.textHeight !== undefined ? { height: override.textHeight } : {}),
              id: original.id,
            }),
          )
        )
          return false;
      }
    }
  }

  return true;
}

function materialize(
  nodes: readonly CanvasFrame[],
  root: ComponentNode,
  allocate: (source: string) => string,
): CanvasFrame[] {
  const instance = root.instance!;
  const source = nodes.find((node) => node.id === instance.componentId);
  if (!source || !metadata(source).component) return subtree(nodes, root.id).map(clean);
  const definition = metadata(source).component!;
  const variant = definition.variants.find((item) => item.id === instance.variantId);
  const selected = variant ? instance : { ...instance, variantId: undefined };
  const children = subtree(nodes, source.id);
  const previous = subtree(nodes, root.id);
  const mapped = new Map<string, string>([[source.id, root.id]]);
  for (const child of previous)
    if (child.componentSourceId) mapped.set(child.componentSourceId, child.id);
  for (const child of children) if (!mapped.has(child.id)) mapped.set(child.id, allocate(child.id));
  const overrides = new Map(selected.overrides.map((override) => [override.sourceId, override]));
  const variants = new Map(variant?.overrides.map((patch) => [patch.sourceId, patch.values]) ?? []);

  const validOverrides = selected.overrides.filter((override) =>
    children.some(
      (child) =>
        child.id === override.sourceId &&
        (override.text === undefined || child.kind === "text") &&
        (override.src === undefined || child.kind === "image" || child.kind === "svg"),
    ),
  );

  const result: CanvasFrame[] = children.map((child) => {
    const value = patchedNode(child, variants.get(child.id));
    const override = overrides.get(child.id);
    const rootNode = child.id === source.id;

    const translated = {
      ...value,
      id: mapped.get(child.id)!,
      parentId: rootNode ? root.parentId : mapped.get(child.parentId!)!,
      x: root.x + child.x - source.x,
      y: root.y + child.y - source.y,
      ...(child.maskId
        ? {
            maskId: rootNode ? root.maskId : mapped.get(child.maskId),
          }
        : {}),
      ...(override?.text !== undefined && value.kind === "text"
        ? {
            text: override.text,
            textRuns: override.textRuns ?? [],
            ...(override.textHeight !== undefined ? { height: override.textHeight } : {}),
          }
        : {}),
      ...(override?.src !== undefined && (value.kind === "image" || value.kind === "svg")
        ? {
            src: override.src,
            ...(value.kind === "svg" && override.src !== value.src ? { vector: undefined } : {}),
          }
        : {}),
      ...(rootNode
        ? {
            name: root.name,
            rotation: root.rotation,
            instance: { ...selected, overrides: validOverrides },
          }
        : { componentSourceId: child.id }),
    };

    return translated as CanvasFrame;
  });

  // Local additions remain ordinary layers until their linked parent is removed.
  const kept = new Set(result.map((node) => node.id));

  for (const child of previous) {
    if (
      child.id !== root.id &&
      !child.componentSourceId &&
      child.parentId &&
      kept.has(child.parentId)
    ) {
      result.push(child);
      kept.add(child.id);
    }
  }

  return result;
}

function transaction(
  before: readonly CanvasFrame[],
  after: readonly CanvasFrame[],
): CanvasTransaction {
  const previous = new Map(before.map((node) => [node.id, node]));
  const current = new Map(after.map((node) => [node.id, node]));

  return {
    add: after.filter((node) => !previous.has(node.id)),
    update: after.filter(
      (node) =>
        previous.has(node.id) && JSON.stringify(previous.get(node.id)) !== JSON.stringify(node),
    ),
    remove: before.filter((node) => !current.has(node.id)).map((node) => node.id),
  };
}

/** Expand before committing so source propagation and override bookkeeping share the same undo entry. */
export function expandCanvasComponentTransaction(
  before: readonly CanvasFrame[],
  input: CanvasTransaction,
  options: { captureOverrides?: boolean } = {},
): CanvasTransaction {
  const candidate = new Map(before.map((node) => [node.id, metadata(node)]));
  for (const id of input.remove ?? []) candidate.delete(id);
  for (const node of [...(input.add ?? []), ...(input.update ?? [])])
    candidate.set(node.id, metadata(node));
  const previous = new Map(before.map((node) => [node.id, metadata(node)]));
  const occupied = new Set(candidate.keys());

  for (const source of candidate.values()) {
    if (!source.component) continue;
    const currentIds = new Set(subtree([...candidate.values()], source.id).map((node) => node.id));
    const previousIds = new Set(subtree(before, source.id).map((node) => node.id));

    const variants = source.component.variants.map((variant) => ({
      ...variant,
      overrides: variant.overrides.filter(
        (patch) => currentIds.has(patch.sourceId) || !previousIds.has(patch.sourceId),
      ),
    }));

    if (JSON.stringify(variants) !== JSON.stringify(source.component.variants))
      candidate.set(source.id, { ...source, component: { variants } });
  }

  // oxlint-disable-next-line unicorn/no-useless-spread -- Materialization mutates this map; visit only the original roots.
  for (const initial of [...candidate.values()]) {
    if (!initial.instance) continue;
    let root = initial;

    if (
      !candidate.get(root.instance!.componentId)?.component &&
      !(
        previous.get(root.id)?.instance?.componentId === root.instance!.componentId &&
        previous.get(root.instance!.componentId)?.component
      )
    ) {
      throw new Error("Instance component not found.");
    }

    const overrides = new Map(
      root.instance!.overrides.map((override) => [override.sourceId, override]),
    );

    const children = new Set(subtree([...candidate.values()], root.id).map((node) => node.id));

    for (const changed of options.captureOverrides === false ? [] : (input.update ?? [])) {
      const old = previous.get(changed.id);
      const node = metadata(changed);
      if (!old || !children.has(node.id) || !node.componentSourceId) continue;

      const override = {
        ...overrides.get(node.componentSourceId),
        sourceId: node.componentSourceId,
      };

      if (
        node.kind === "text" &&
        old.kind === "text" &&
        (node.text !== old.text ||
          JSON.stringify(node.textRuns) !== JSON.stringify(old.textRuns) ||
          (override.text !== undefined && node.height !== old.height))
      ) {
        override.text = node.text;
        override.textRuns = node.textRuns ?? [];
        override.textHeight = node.height;
      }

      if (
        (node.kind === "image" || node.kind === "svg") &&
        (old.kind === "image" || old.kind === "svg") &&
        node.src !== old.src
      )
        override.src = node.src;
      if (override.text !== undefined || override.src !== undefined)
        overrides.set(node.componentSourceId, override);
    }

    root = { ...root, instance: { ...root.instance!, overrides: [...overrides.values()] } };
    candidate.set(root.id, root);
    const all = [...candidate.values()];

    const rendered = materialize(all, root, (source) => {
      const base = `${root.id}/${source}`;
      let id = base;
      let suffix = 1;
      while (occupied.has(id)) id = `${base}/${suffix++}`;
      occupied.add(id);

      return id;
    });

    for (const id of children) candidate.delete(id);
    for (const node of rendered) candidate.set(node.id, metadata(node));
  }

  return transaction(before, [...candidate.values()]);
}

function plan(
  _nodes: readonly CanvasFrame[],
  input: CanvasTransaction,
  selection: string[],
): CanvasOperationPlan {
  // The document expands this intent once; pre-expanding here would recapture
  // synchronized text as an explicit override when the plan is committed.
  return {
    upsert: [...(input.add ?? []), ...(input.update ?? [])],
    remove: [...(input.remove ?? [])],
    selection,
  };
}

export function createCanvasComponent(
  nodes: readonly CanvasFrame[],
  id: string,
): CanvasOperationPlan {
  const node = nodes.find((item) => item.id === id);
  if (!node || !isFrame(node)) throw new Error("Choose a frame to create a component.");
  if (subtree(nodes, id).some((item) => item.instance || item.component))
    throw new Error("Components cannot contain other components or instances.");
  const component = { ...node, component: { variants: [] } } as ComponentNode;
  if (!validateCanvasComponents(nodes.map((item) => (item.id === id ? component : item))))
    throw new Error("A component cannot be nested inside another component or instance.");

  return plan(nodes, { update: [component] }, [id]);
}

export function instantiateCanvasComponent(
  nodes: readonly CanvasFrame[],
  componentId: string,
  position: Point,
  variantId?: string,
  allocate: () => string = () => crypto.randomUUID(),
): CanvasOperationPlan {
  const source = nodes.find((item) => item.id === componentId);
  if (!source || !metadata(source).component) throw new Error("Component not found.");
  if (
    variantId &&
    !metadata(source).component!.variants.some((variant) => variant.id === variantId)
  )
    throw new Error("Variant not found.");

  const root = {
    ...clean(metadata(source)),
    ...position,
    id: allocate(),
    instance: { componentId, variantId, overrides: [] },
  } as ComponentNode;

  return plan(nodes, { add: [root] }, [root.id]);
}

export function detachCanvasInstance(
  nodes: readonly CanvasFrame[],
  id: string,
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  if (!root || !metadata(root).instance) throw new Error("Instance not found.");

  return { upsert: subtree(nodes, id).map(clean), remove: [], selection: [id] };
}

export function resetCanvasInstanceOverrides(
  nodes: readonly CanvasFrame[],
  id: string,
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  if (!root || !metadata(root).instance) throw new Error("Instance not found.");

  return plan(
    nodes,
    {
      update: [
        { ...root, instance: { ...metadata(root).instance!, overrides: [] } } as ComponentNode,
      ],
    },
    [id],
  );
}

export function setCanvasInstanceVariant(
  nodes: readonly CanvasFrame[],
  id: string,
  variantId?: string,
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  const instance = root && metadata(root).instance;
  const source = instance && nodes.find((node) => node.id === instance.componentId);
  if (
    !root ||
    !instance ||
    !source ||
    (variantId && !metadata(source).component?.variants.some((variant) => variant.id === variantId))
  )
    throw new Error("Instance or variant not found.");

  return plan(
    nodes,
    { update: [{ ...root, instance: { ...instance, variantId } } as ComponentNode] },
    [id],
  );
}

export function setCanvasComponentVariant(
  nodes: readonly CanvasFrame[],
  id: string,
  variant: CanvasComponentVariant,
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  const definition = root && metadata(root).component;
  if (!root || !definition) throw new Error("Component not found.");
  const variants = definition.variants.filter((item) => item.id !== variant.id);
  variants.push(variant);
  const component = { ...root, component: { variants } } as ComponentNode;
  if (!isCanvasComponent(component.component)) throw new Error("Invalid component variant.");

  return plan(nodes, { update: [component] }, [id]);
}

export function removeCanvasComponentVariant(
  nodes: readonly CanvasFrame[],
  id: string,
  variantId: string,
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  const definition = root && metadata(root).component;
  if (!root || !definition) throw new Error("Component not found.");

  return plan(
    nodes,
    {
      update: [
        {
          ...root,
          component: { variants: definition.variants.filter((item) => item.id !== variantId) },
        } as ComponentNode,
      ],
    },
    [id],
  );
}

/** Promote the current instance appearance to a named variant without changing that instance. */
export function captureCanvasInstanceVariant(
  nodes: readonly CanvasFrame[],
  id: string,
  name: string,
  allocate: () => string = () => crypto.randomUUID(),
): CanvasOperationPlan {
  const root = nodes.find((node) => node.id === id);
  const instance = root && metadata(root).instance;
  const source = instance && nodes.find((node) => node.id === instance.componentId);
  if (!root || !instance || !source || !name.trim())
    throw new Error("Choose an instance and name the variant.");
  const sourceNodes = new Map(subtree(nodes, source.id).map((node) => [node.id, node]));
  const overrides: { sourceId: string; values: CanvasComponentVariantValues }[] = [];

  for (const node of subtree(nodes, id)) {
    const sourceId = node.id === id ? source.id : node.componentSourceId;
    const original = sourceId && sourceNodes.get(sourceId);
    if (!sourceId || !original) continue;
    const values: Record<string, unknown> = {};

    for (const key of variantKeys) {
      if (node.id === id && key === "rotation") continue;
      if (key === "textRuns" && node.kind !== "text") continue;
      const value = key === "textRuns" ? (Reflect.get(node, key) ?? []) : Reflect.get(node, key);
      if (
        value !== undefined &&
        JSON.stringify(value) !== JSON.stringify(Reflect.get(original, key))
      )
        values[key] = value;
    }

    if (Object.keys(values).length) overrides.push({ sourceId, values });
  }

  const variant: CanvasComponentVariant = { id: allocate(), name: name.trim(), overrides };
  const definition = metadata(source).component!;

  return plan(
    nodes,
    {
      update: [
        { ...source, component: { variants: [...definition.variants, variant] } } as ComponentNode,
        {
          ...root,
          instance: { ...instance, variantId: variant.id, overrides: [] },
        } as ComponentNode,
      ],
    },
    [id],
  );
}

/** Remap copied masters/instances together; unavailable external masters detach their instances. */
export function remapCanvasComponentReferences(
  node: CanvasFrame,
  ids: ReadonlyMap<string, string>,
  availableComponents?: ReadonlySet<string>,
): CanvasFrame {
  const value = metadata(node);
  const map = (id: string) => ids.get(id) ?? id;

  const component = value.component && {
    variants: value.component.variants.map((variant) => ({
      ...variant,
      overrides: variant.overrides.map((patch) => ({ ...patch, sourceId: map(patch.sourceId) })),
    })),
  };

  const masterAvailable =
    !value.instance ||
    ids.has(value.instance.componentId) ||
    availableComponents?.has(value.instance.componentId);

  const instance =
    value.instance && masterAvailable
      ? {
          ...value.instance,
          componentId: map(value.instance.componentId),
          overrides: value.instance.overrides.map((override) => ({
            ...override,
            sourceId: map(override.sourceId),
          })),
        }
      : undefined;

  return {
    ...clean(value),
    ...(value.maskId ? { maskId: map(value.maskId) } : {}),
    ...(component ? { component } : {}),
    ...(instance ? { instance } : {}),
    ...(value.componentSourceId ? { componentSourceId: map(value.componentSourceId) } : {}),
  } as CanvasFrame;
}

/** Use after remapping a clipboard batch to strip orphaned descendant source links on detached copies. */
export function detachOrphanedComponentLinks(nodes: readonly CanvasFrame[]): CanvasFrame[] {
  const owned = new Set(
    nodes
      .filter((node) => metadata(node).instance)
      .flatMap((node) => subtree(nodes, node.id).map((child) => child.id)),
  );

  return nodes.map((node) =>
    metadata(node).componentSourceId && !owned.has(node.id) ? clean(metadata(node)) : node,
  );
}
