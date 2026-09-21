import { createFileRoute } from "@tanstack/react-router";

import { HostedAuthRedirect } from "@/components/workspace/hosted-auth-redirect";

export const Route = createFileRoute("/signup")({ component: HostedAuthRedirect });
