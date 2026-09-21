import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { DesktopTitlebar } from "@/components/workspace/desktop-titlebar";

export const Route = createRootRoute({
  component: () => (
    <>
      <DesktopTitlebar />
      <Outlet />
    </>
  ),
  notFoundComponent: () => (
    <main className="flex flex-col items-center gap-4 p-16">
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="text-muted-foreground">That page does not exist.</p>
      <Button variant="outline" render={<Link to="/">Go to canvas</Link>} />
    </main>
  ),
});
