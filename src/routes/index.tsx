import { createFileRoute } from "@tanstack/react-router";
import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/")({
  component: HomePage,
});

function HomePage() {
  const [greetMsg, setGreetMsg] = useState("");
  const [name, setName] = useState("");

  async function greet() {
    // Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
    setGreetMsg(await invoke<string>("greet", { name }));
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-8 px-6 py-16">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">lra-dsgn</h1>
        <p className="text-sm text-muted-foreground">Tauri + React + TanStack Router + shadcn/ui</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Call into Rust</CardTitle>
          <CardDescription>
            Invokes the <code className="font-mono text-xs">greet</code> command over Tauri IPC.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              greet();
            }}
          >
            <Input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="Enter a name..."
            />
            <Button type="submit">Greet</Button>
          </form>
        </CardContent>

        {greetMsg ? (
          <CardFooter>
            <p className="text-sm text-muted-foreground">{greetMsg}</p>
          </CardFooter>
        ) : null}
      </Card>
    </main>
  );
}
