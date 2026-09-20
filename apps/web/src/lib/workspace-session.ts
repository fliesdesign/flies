export const WORKSPACE_SESSION_KEY = "flies.workspace.v1";
export const LIBRARY_SECTIONS = ["recents", "files", "archive", "settings"] as const;
export const SIDEBAR_TABS = ["design", "theme"] as const;
export const MAX_OPEN_TABS = 24;

export type LibrarySection = (typeof LIBRARY_SECTIONS)[number];
export type SidebarTab = (typeof SIDEBAR_TABS)[number];
export type WorkspaceSession = {
  openIds: string[];
  activeId: string | null;
  librarySection: LibrarySection;
  sidebarTab: SidebarTab;
};

export const DEFAULT_WORKSPACE_SESSION: WorkspaceSession = {
  openIds: [],
  activeId: null,
  librarySection: "recents",
  sidebarTab: "design",
};

const FILE_ID = /^[\da-f][\da-f-]{0,79}$/i;

function storage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isFileId(value: unknown): value is string {
  return typeof value === "string" && FILE_ID.test(value);
}

function isLibrarySection(value: unknown): value is LibrarySection {
  return LIBRARY_SECTIONS.some((section) => section === value);
}

function isSidebarTab(value: unknown): value is SidebarTab {
  return SIDEBAR_TABS.some((tab) => tab === value);
}

export function normalizeWorkspaceSession(value: unknown): WorkspaceSession {
  if (typeof value !== "object" || value === null) return DEFAULT_WORKSPACE_SESSION;
  const raw = value as Record<string, unknown>;
  const seen = new Set<string>();
  const openIds: string[] = [];
  if (Array.isArray(raw.openIds)) {
    for (const id of raw.openIds) {
      if (!isFileId(id) || seen.has(id)) continue;
      seen.add(id);
      openIds.push(id);
      if (openIds.length >= MAX_OPEN_TABS) break;
    }
  }
  const requested =
    raw.activeId === null || raw.activeId === undefined
      ? null
      : isFileId(raw.activeId)
        ? raw.activeId
        : null;
  return {
    openIds,
    activeId: requested && seen.has(requested) ? requested : null,
    librarySection: isLibrarySection(raw.librarySection) ? raw.librarySection : "recents",
    sidebarTab: isSidebarTab(raw.sidebarTab) ? raw.sidebarTab : "design",
  };
}

export function restoreableOpenIds(
  session: WorkspaceSession,
  availableIds: Iterable<string>,
): string[] {
  const alive = availableIds instanceof Set ? availableIds : new Set(availableIds);
  return session.openIds.filter((id) => alive.has(id));
}

export function restoreableActiveId(
  session: WorkspaceSession,
  openIds: readonly string[],
): string | null {
  if (session.activeId === null) return null;
  return openIds.includes(session.activeId) ? session.activeId : null;
}

export function loadWorkspaceSession(): WorkspaceSession {
  const raw = storage()?.getItem(WORKSPACE_SESSION_KEY);
  if (!raw) return DEFAULT_WORKSPACE_SESSION;
  try {
    return normalizeWorkspaceSession(JSON.parse(raw) as unknown);
  } catch {
    return DEFAULT_WORKSPACE_SESSION;
  }
}

export function saveWorkspaceSession(session: WorkspaceSession): WorkspaceSession {
  const next = normalizeWorkspaceSession(session);
  try {
    storage()?.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(next));
  } catch {
    /* private mode still keeps the in-memory session */
  }
  return next;
}

export function patchWorkspaceSession(patch: Partial<WorkspaceSession>): WorkspaceSession {
  return saveWorkspaceSession({ ...loadWorkspaceSession(), ...patch });
}
