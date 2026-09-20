import { Link, Outlet, createRootRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export const Route = createRootRoute({
  component: () => (
    <>
      {document.documentElement.dataset.nativeTitlebar === "macos" && (
        <div className="desktop-drag-region" data-tauri-drag-region aria-hidden="true" />
      )}
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
