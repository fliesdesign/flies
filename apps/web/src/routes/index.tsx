import { createFileRoute, redirect } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";

import { loadWorkspaceSession } from "@/lib/workspace-session";

export const Route = createFileRoute("/")({
  beforeLoad: () => {
    const activeId = isTauri() ? loadWorkspaceSession().activeId : null;
    if (activeId) throw redirect({ to: "/files/$id", params: { id: activeId } });
    throw redirect({ to: "/recents" });
  },
});
