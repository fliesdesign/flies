import { useEffect, useSyncExternalStore } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RealtimeFile } from "@/lib/realtime";

export function CollaboratorAvatars({ realtime }: { realtime: RealtimeFile }) {
  const state = useSyncExternalStore(
    realtime.subscribe,
    realtime.getSnapshot,
    realtime.getSnapshot,
  );

  useEffect(() => () => realtime.highlight(), [realtime]);

  useEffect(() => {
    if (!state.highlightedUserId) return;
    const timer = setTimeout(() => realtime.highlight(), 2000);

    return () => clearTimeout(timer);
  }, [realtime, state.highlightedUserId]);

  const peers = [
    ...new Map(
      state.peers.filter((peer) => peer.userId !== state.userId).map((peer) => [peer.userId, peer]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));

  useEffect(() => {
    if (state.highlightedUserId && !peers.some((peer) => peer.userId === state.highlightedUserId)) {
      realtime.highlight();
    }
  }, [peers, realtime, state.highlightedUserId]);

  if (!peers.length) return null;

  return (
    <div className="workspace-collaborators" aria-label="Active collaborators">
      {peers.map((peer) => (
        <Tooltip key={peer.userId}>
          <TooltipTrigger
            className="workspace-collaborator-avatar"
            aria-label={peer.name}
            style={{ backgroundColor: peer.color }}
            onMouseEnter={() => realtime.highlight(peer.userId)}
            onMouseLeave={(event) => {
              if (event.currentTarget !== window.document.activeElement) realtime.highlight();
            }}
            onFocus={() => realtime.highlight(peer.userId)}
            onBlur={() => realtime.highlight()}
            data-highlighted={state.highlightedUserId === peer.userId || undefined}
          >
            {peer.name
              .trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((part) => part[0])
              .join("")
              .toUpperCase() || "?"}
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={8}>
            {peer.name} · {peer.activity}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
