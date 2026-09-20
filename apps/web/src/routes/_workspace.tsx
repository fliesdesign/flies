import { createFileRoute } from "@tanstack/react-router";

import { AuthGate } from "@/components/workspace/auth-gate";

export const Route = createFileRoute("/_workspace")({ component: AuthGate });
