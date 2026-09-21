import type { CanvasFrame } from "./canvas-document";
import type { CanvasTheme } from "./canvas-theme";

export type SyncSnapshot = { name: string; nodes: CanvasFrame[]; theme: CanvasTheme };
export type EntityDelta = {
  id: string;
  create?: Record<string, unknown>;
  set?: Record<string, unknown>;
  unset?: string[];
  remove?: true;
};
export type DocumentDelta = {
  nodes: EntityDelta[];
  tokens: EntityDelta[];
  order?: string[];
  tokenOrder?: string[];
  name?: string;
};
const forbidden = new Set(["__proto__", "prototype", "constructor", "id"]);
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffEntities(before: readonly { id: string }[], after: readonly { id: string }[]) {
  const old = new Map(before.map((item) => [item.id, item as Record<string, unknown>]));
  const next = new Map(after.map((item) => [item.id, item as Record<string, unknown>]));
  const changes: EntityDelta[] = [];

  for (const [id, value] of old) {
    const replacement = next.get(id);

    if (!replacement) {
      changes.push({ id, remove: true });
      continue;
    }

    const set: Record<string, unknown> = {};
    const unset: string[] = [];

    for (const key of new Set([...Object.keys(value), ...Object.keys(replacement)])) {
      if (forbidden.has(key) || equal(value[key], replacement[key])) continue;
      if (replacement[key] === undefined) unset.push(key);
      else set[key] = replacement[key];
    }

    if (Object.keys(set).length || unset.length) changes.push({ id, set, unset });
  }

  for (const [id, value] of next) if (!old.has(id)) changes.push({ id, create: value });

  return changes;
}

/** Only changed fields are sent; concurrent edits to other fields survive. */
export function diffDocument(before: SyncSnapshot, after: SyncSnapshot): DocumentDelta {
  const order = after.nodes.map((item) => item.id);
  const tokenOrder = after.theme.tokens.map((item) => item.id);

  return {
    nodes: diffEntities(before.nodes, after.nodes),
    tokens: diffEntities(before.theme.tokens, after.theme.tokens),
    ...(!equal(
      before.nodes.map((item) => item.id),
      order,
    )
      ? { order }
      : {}),
    ...(!equal(
      before.theme.tokens.map((item) => item.id),
      tokenOrder,
    )
      ? { tokenOrder }
      : {}),
    ...(before.name !== after.name ? { name: after.name } : {}),
  };
}

export const hasDocumentDelta = (delta: DocumentDelta) =>
  !!(
    delta.nodes.length ||
    delta.tokens.length ||
    delta.order ||
    delta.tokenOrder ||
    delta.name !== undefined
  );

function applyEntities<T extends { id: string }>(
  original: readonly T[],
  changes: EntityDelta[],
  order?: string[],
): T[] {
  const values = new Map(original.map((item) => [item.id, item]));

  for (const change of changes) {
    if (change.remove) {
      values.delete(change.id);
      continue;
    }

    if (change.create) {
      // Never replace an existing entity with an outdated create retry.
      if (!values.has(change.id)) values.set(change.id, { ...change.create, id: change.id } as T);
      continue;
    }

    const previous = values.get(change.id);
    // A late property edit cannot resurrect a deleted layer or token.
    if (!previous) continue;
    const next = { ...previous } as Record<string, unknown>;
    for (const [key, value] of Object.entries(change.set ?? {}))
      if (!forbidden.has(key)) next[key] = value;
    for (const key of change.unset ?? []) if (!forbidden.has(key)) delete next[key];
    values.set(change.id, next as T);
  }

  const result = [...values.values()];
  if (!order) return result;
  const requested = new Set(order);
  const ordered = order.flatMap((id) => (values.has(id) ? [values.get(id)!] : []));
  let index = 0;

  // Concurrent additions retain their positions; ordering never drops unknown IDs.
  return result.map((item) => (requested.has(item.id) ? ordered[index++] : item));
}

export function applyDocumentDelta(snapshot: SyncSnapshot, delta: DocumentDelta): SyncSnapshot {
  let nodes = applyEntities(snapshot.nodes, delta.nodes, delta.order);
  const removed = new Set(delta.nodes.filter((item) => item.remove).map((item) => item.id));
  // Removing a container also removes children added concurrently to that container.
  const children = new Map<string, string[]>();

  for (const node of nodes)
    if (node.parentId) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node.id);
      children.set(node.parentId, siblings);
    }

  const pending = [...removed];

  while (pending.length) {
    for (const id of children.get(pending.pop()!) ?? [])
      if (!removed.has(id)) {
        removed.add(id);
        pending.push(id);
      }
  }

  nodes = nodes.filter((node) => !removed.has(node.id));
  const ids = new Set(nodes.map((node) => node.id));
  nodes = nodes.map((node) => {
    if (!node.parentId || ids.has(node.parentId)) return node;
    const { parentId: _parentId, ...rest } = node;

    return rest as CanvasFrame;
  });

  return {
    name: delta.name ?? snapshot.name,
    nodes,
    theme: { tokens: applyEntities(snapshot.theme.tokens, delta.tokens, delta.tokenOrder) },
  };
}
