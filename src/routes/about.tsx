import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: AboutPage,
});

function AboutPage() {
  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">About</h1>
      <p className="text-sm text-muted-foreground">
        Routes live in <code className="font-mono text-xs">src/routes</code>. Adding a file there
        regenerates <code className="font-mono text-xs">src/routeTree.gen.ts</code> automatically
        while Vite is running.
      </p>
      <p className="text-sm text-muted-foreground">
        UI primitives come from <code className="font-mono text-xs">src/components/ui</code> — add
        more with <code className="font-mono text-xs">bun x shadcn@latest add &lt;name&gt;</code>.
      </p>
    </main>
  );
}
