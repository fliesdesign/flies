import { createFileRoute } from "@tanstack/react-router";

import { FileWorkspace } from "@/components/workspace/file-workspace";

export const Route = createFileRoute("/")({
  component: FileWorkspace,
});
