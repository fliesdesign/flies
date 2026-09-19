import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRightIcon, ChevronDownIcon, InfoIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toaster, toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export const Route = createFileRoute("/components")({ component: ComponentsPage });

function ComponentsPage() {
  const [date, setDate] = useState<Date | undefined>(new Date(2026, 8, 19));
  const [project, setProject] = useState("Default project");
  const [draft, setDraft] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <TooltipProvider>
      <Toaster>
        <main className="oui-page space-y-10">
          <header className="flex flex-wrap items-start justify-between gap-6">
            <div className="space-y-3">
              <p className="text-xs tracking-wider text-muted-foreground uppercase">UI library</p>
              <h1 className="oui-page-title">Components</h1>
              <p className="max-w-xl text-muted-foreground">
                A quiet foundation for focused work. Explore the controls, surfaces, and
                interactions.
              </p>
            </div>
            <Badge variant="new">OUI</Badge>
          </header>

          <section className="oui-section" aria-labelledby="controls-title">
            <h2 id="controls-title" className="oui-section-title">
              Controls
            </h2>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => toast.add({ title: "Changes saved", type: "success" })}>
                Save changes
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  toast.add({
                    title: "Preview ready",
                    description: "This is a local component preview.",
                  })
                }
              >
                Preview <ArrowUpRightIcon />
              </Button>
              <Button variant="outline" onClick={() => toast.add({ title: "Nothing to cancel" })}>
                Cancel
              </Button>
              <Button
                variant="ghost"
                onClick={() =>
                  toast.add({
                    title: "More options",
                    description: "Use the project menu below to explore actions.",
                  })
                }
              >
                More options
              </Button>
              <Button disabled>Unavailable</Button>
              <Tooltip>
                <TooltipTrigger
                  render={<Button variant="ghost" size="icon" aria-label="Configure" />}
                >
                  <SettingsIcon />
                </TooltipTrigger>
                <TooltipContent>Configure</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Badge>Default</Badge>
              <Badge variant="secondary">Active</Badge>
              <Badge variant="new">New</Badge>
              <Badge variant="subtle">20% lower cost</Badge>
              <Badge variant="outline">Draft</Badge>
            </div>
            <Tabs defaultValue="7d">
              <TabsList aria-label="Time range">
                {["24h", "7d", "14d", "30d"].map((period) => (
                  <TabsTrigger key={period} value={period}>
                    {period}
                  </TabsTrigger>
                ))}
              </TabsList>
              {["24h", "7d", "14d", "30d"].map((period) => (
                <TabsContent key={period} value={period} className="pt-2 text-muted-foreground">
                  Showing activity for the last {period}.
                </TabsContent>
              ))}
            </Tabs>
          </section>

          <section className="oui-section" aria-labelledby="forms-title">
            <h2 id="forms-title" className="oui-section-title">
              Forms & selection
            </h2>
            <div className="grid gap-8 md:grid-cols-2">
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="project-name">Project name</Label>
                  <Input id="project-name" defaultValue="Default project" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-id">Project ID</Label>
                  <Input id="project-id" value="proj_example" readOnly />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-residency">Residency</Label>
                  <Input id="project-residency" value="Global" disabled />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="project-notes">Notes</Label>
                  <Textarea id="project-notes" placeholder="Add a note about this project…" />
                </div>
              </div>
              <div className="space-y-6">
                <div className="space-y-2">
                  <Label id="tier-label">Service tier</Label>
                  <Select
                    defaultValue="standard"
                    items={{ standard: "Standard", fast: "Fast", flex: "Flex" }}
                  >
                    <SelectTrigger aria-labelledby="tier-label" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="standard">Standard</SelectItem>
                        <SelectItem value="fast">Fast</SelectItem>
                        <SelectItem value="flex" disabled>
                          Flex — unavailable
                        </SelectItem>
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-wrap gap-6">
                  <Label>
                    <Checkbox defaultChecked />
                    Activity reports
                  </Label>
                  <Label>
                    <Checkbox />
                    Weekly summary
                  </Label>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <Label htmlFor="notifications">Notifications</Label>
                  <Switch id="notifications" defaultChecked />
                </div>
                <RadioGroup defaultValue="owners" aria-label="Visibility">
                  <Label>
                    <RadioGroupItem value="hidden" />
                    Hidden
                  </Label>
                  <Label>
                    <RadioGroupItem value="owners" />
                    Visible to owners
                  </Label>
                  <Label>
                    <RadioGroupItem value="everyone" />
                    Visible to everyone
                  </Label>
                </RadioGroup>
                <div className="space-y-3">
                  <Label id="volume-label">Volume</Label>
                  <Slider defaultValue={[40]} aria-labelledby="volume-label" />
                </div>
              </div>
            </div>
          </section>

          <section className="oui-section" aria-labelledby="surfaces-title">
            <h2 id="surfaces-title" className="oui-section-title">
              Surfaces & actions
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle>{project}</CardTitle>
                  <CardDescription>Your workspace for everyday work.</CardDescription>
                </CardHeader>
                <CardContent className="flex items-center gap-3">
                  <Avatar>
                    <AvatarFallback>AM</AvatarFallback>
                  </Avatar>
                  <div>
                    <p>Alex Morgan</p>
                    <p className="text-xs text-muted-foreground">Project owner</p>
                  </div>
                </CardContent>
              </Card>
              <Card className="oui-card-reveal min-h-40">
                <div className="oui-card-reveal-content">
                  <CardHeader>
                    <CardTitle>Ready when you are</CardTitle>
                    <CardDescription>Hover or focus to reveal the actions.</CardDescription>
                  </CardHeader>
                </div>
                <div className="oui-card-reveal-actions">
                  <Button
                    onClick={() => toast.add({ title: "Project opened", description: project })}
                  >
                    Open project <ArrowUpRightIcon />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() =>
                      toast.add({
                        title: "Project details",
                        description: "A local preview of the card action layer.",
                      })
                    }
                  >
                    Details
                  </Button>
                </div>
              </Card>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="secondary" />}>
                  {project}
                  <ChevronDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>Projects</DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => setProject("Default project")}>
                      Default project
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setProject("Example project")}>
                      Example project
                    </DropdownMenuItem>
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                    <PlusIcon />
                    Create project
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled>Manage permissions</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogTrigger render={<Button variant="outline" />}>
                  <PlusIcon />
                  Create project
                </DialogTrigger>
                <DialogContent>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = draft.trim();
                      if (!name) return;
                      setProject(name);
                      setDialogOpen(false);
                      setDraft("");
                      toast.add({
                        title: "Project created",
                        description: "Added to this preview session.",
                        type: "success",
                      });
                    }}
                    className="space-y-5"
                  >
                    <DialogHeader>
                      <DialogTitle>Create project</DialogTitle>
                      <DialogDescription>
                        Give your project a name. This preview keeps changes in memory.
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-2">
                      <Label htmlFor="new-project">Name</Label>
                      <Input
                        id="new-project"
                        placeholder="Project name"
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        required
                      />
                    </div>
                    <DialogFooter>
                      <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
                      <Button type="submit" disabled={!draft.trim()}>
                        Create
                      </Button>
                    </DialogFooter>
                  </form>
                </DialogContent>
              </Dialog>
              <Button
                variant="destructive"
                onClick={() =>
                  toast.add({
                    title: "Destructive action preview",
                    description: "No data was removed.",
                    type: "error",
                  })
                }
              >
                Archive
              </Button>
            </div>
            <Accordion>
              <AccordionItem value="details">
                <AccordionTrigger>Project details</AccordionTrigger>
                <AccordionContent>
                  <p className="text-muted-foreground">
                    Settings are grouped in compact, independently collapsible sections.
                  </p>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </section>

          <section className="oui-section" aria-labelledby="data-title">
            <h2 id="data-title" className="oui-section-title">
              Data & dates
            </h2>
            <div className="grid items-start gap-8 lg:grid-cols-[1fr_auto]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Members</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    { id: "default", name: project, members: 3 },
                    { id: "staging", name: "Staging", members: 2 },
                    { id: "research", name: "Research", members: 1 },
                  ].map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.name}</TableCell>
                      <TableCell>{row.members}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="secondary">Active</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <Calendar
                mode="single"
                selected={date}
                onSelect={setDate}
                defaultMonth={date}
                className="rounded-xl bg-popover"
              />
            </div>
          </section>

          <section className="oui-section" aria-labelledby="feedback-title">
            <h2 id="feedback-title" className="oui-section-title">
              Feedback & loading
            </h2>
            <Alert>
              <InfoIcon />
              <AlertTitle>Everything in one place</AlertTitle>
              <AlertDescription>
                Your project settings apply to everyone in this workspace.
              </AlertDescription>
            </Alert>
            <div className="grid gap-4 md:grid-cols-2">
              <Alert variant="warning">
                <AlertTitle>Check project access</AlertTitle>
                <AlertDescription>This change may affect project members.</AlertDescription>
              </Alert>
              <Alert variant="destructive">
                <AlertTitle>Archive with care</AlertTitle>
                <AlertDescription>Archived projects cannot be restored.</AlertDescription>
              </Alert>
            </div>
            <div className="grid gap-8 md:grid-cols-2">
              <div className="space-y-5">
                <div className="flex items-center gap-4">
                  <Spinner className="size-4" />
                  <Spinner className="size-5" />
                  <Spinner className="size-6" />
                  <Spinner className="size-8" />
                  <span className="text-muted-foreground">Loading…</span>
                </div>
                <Progress value={64} aria-label="Upload progress" />
              </div>
              <div className="flex items-center gap-3" aria-label="Loading content">
                <Skeleton className="size-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-3/4" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
              </div>
            </div>
          </section>
        </main>
      </Toaster>
    </TooltipProvider>
  );
}
