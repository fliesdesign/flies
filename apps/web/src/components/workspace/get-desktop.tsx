import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { apiUrl } from "@/lib/api";

export function detectDesktopPlatform(userAgent: string, touchPoints = 0) {
  if (
    /Android|iPhone|iPad|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && touchPoints > 1)
  )
    return "all";
  if (/Windows/i.test(userAgent)) return "windows";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "mac";
  if (/Linux/i.test(userAgent) && !/CrOS/i.test(userAgent)) return "linux";

  return "all";
}

const downloads = [
  { platform: "mac", target: "mac-arm", label: "macOS · Apple Silicon" },
  { platform: "mac", target: "mac-intel", label: "macOS · Intel" },
  { platform: "windows", target: "windows-intel", label: "Windows · Intel / AMD" },
  { platform: "windows", target: "windows-arm", label: "Windows · ARM" },
  { platform: "linux", target: "linux", label: "Linux · x64 AppImage" },
];

export function GetDesktop() {
  const [open, setOpen] = useState(false);

  const [platform, setPlatform] = useState(() =>
    typeof navigator === "undefined"
      ? "all"
      : detectDesktopPlatform(navigator.userAgent, navigator.maxTouchPoints),
  );

  return (
    <>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" onClick={() => setOpen(true)}>
              <DownloadIcon />
              <span>Get Desktop</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogTitle>Get Flies for desktop</DialogTitle>
          <DialogDescription>Download the latest version for your computer.</DialogDescription>
          <label className="space-y-2 text-sm">
            <span>Platform</span>
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={platform}
              onChange={(event) => setPlatform(event.target.value)}
            >
              <option value="mac">macOS</option>
              <option value="windows">Windows</option>
              <option value="linux">Linux</option>
              <option value="all">All platforms</option>
            </select>
          </label>
          <div className="grid gap-2">
            {downloads
              .filter((download) => platform === "all" || download.platform === platform)
              .map((download) => (
                <Button
                  key={download.target}
                  variant="outline"
                  render={
                    <a
                      aria-label={`Download Flies for ${download.label}`}
                      href={apiUrl(`/downloads/desktop/${download.target}`)}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  <DownloadIcon aria-hidden="true" />
                  {download.label}
                </Button>
              ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
