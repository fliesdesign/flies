import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { Peer, RealtimeState } from "@/lib/realtime";

import { CollaboratorAvatars } from "./collaborator-avatars";

const currentUser = { id: "self", name: "Alex Lee", email: "alex@example.invalid" };

function render(state: RealtimeState) {
  const realtime = { subscribe: () => () => {}, getSnapshot: () => state, highlight: () => {} };

  return renderToStaticMarkup(
    <CollaboratorAvatars realtime={realtime} currentUser={currentUser} />,
  );
}

function peer(userId: string, name: string, connectionId: string): Peer {
  return {
    userId,
    name,
    connectionId,
    color: "#54c7a0",
    cursor: null,
    selection: [],
    activity: "viewing",
    updatedAt: 1,
  };
}

describe("properties collaborators", () => {
  it("always includes the current user, even without live sync or any peers", () => {
    for (const state of ["connecting", "live", "offline", "disabled"] as const) {
      const html = render({ state, peers: [] });
      expect(html).toContain('aria-label="Alex Lee (you)"');
      expect(html).toContain('data-self=""');
      expect(html).toContain("AL");
    }
  });
  it("shows each other user once and excludes all of the current user's connections", () => {
    const html = render({
      state: "live",
      peers: [
        peer("self", "Alex Lee", "self-2"),
        peer("sam", "Sam Taylor", "sam-1"),
        peer("sam", "Sam Taylor", "sam-2"),
        peer("jo", "Jo Kim", "jo-1"),
      ],
    });

    expect(html.match(/aria-label="Alex Lee \(you\)"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Alex Lee"');
    expect(html.match(/aria-label="Sam Taylor"/g)).toHaveLength(1);
    expect(html.indexOf('aria-label="Jo Kim"')).toBeLessThan(
      html.indexOf('aria-label="Sam Taylor"'),
    );
  });
});
