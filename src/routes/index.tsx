import { createFileRoute } from "@tanstack/react-router";

import { DesignCanvas } from "@/components/canvas/design-canvas";

export const Route = createFileRoute("/")({
  component: DesignCanvas,
});
