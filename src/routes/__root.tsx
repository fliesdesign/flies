import { Link, Outlet, createRootRoute } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: () => (
    <main className="flex flex-col items-center gap-4 p-16">
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="text-muted-foreground">That page does not exist.</p>
      <Button variant="outline" render={<Link to="/">Go home</Link>} />
    </main>
  ),
});

/** Keep the `dark` class in sync with the OS colour scheme. */
function useSystemTheme() {
  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", query.matches);

    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);
}

const linkClass =
  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

function RootLayout() {
  useSystemTheme();

  return (
    <div className="flex min-h-screen flex-col">
      <nav className="flex items-center gap-1 border-b px-4 py-2">
        <Link
          to="/"
          className={linkClass}
          activeProps={{ className: "bg-muted text-foreground" }}
          activeOptions={{ exact: true }}
        >
          Home
        </Link>
        <Link
          to="/about"
          className={linkClass}
          activeProps={{ className: "bg-muted text-foreground" }}
        >
          About
        </Link>
      </nav>

      <div className="flex-1">
        <Outlet />
      </div>

      {import.meta.env.DEV ? <TanStackRouterDevtools position="bottom-right" /> : null}
    </div>
  );
}
