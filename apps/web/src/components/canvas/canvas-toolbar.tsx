import type { CanvasTool } from "@flies/canvas";
import {
  FrameIcon,
  HandIcon,
  ImagePlusIcon,
  MousePointer2Icon,
  PenLineIcon,
  SquareIcon,
  TypeIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import "./canvas-toolbar.css";

const TOOLS = [
  { tool: "select", label: "Select", shortcut: "V", Icon: MousePointer2Icon },
  { tool: "frame", label: "Frame", shortcut: "F", Icon: FrameIcon },
  { tool: "rectangle", label: "Rectangle", shortcut: "R", Icon: SquareIcon },
  { tool: "text", label: "Text", shortcut: "T", Icon: TypeIcon },
  { tool: "image", label: "Image", shortcut: "I", Icon: ImagePlusIcon },
  { tool: "pen", label: "Pen", shortcut: "P", Icon: PenLineIcon },
  { tool: "pan", label: "Hand", shortcut: "H", Icon: HandIcon },
] as const;

type CanvasToolbarProps = {
  tool: CanvasTool;
  onToolChange: (tool: CanvasTool) => void;
  disabled?: boolean;
  actions?: ReactNode;
};

function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (!step && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  event.stopPropagation();
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const index = buttons.indexOf(event.target as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? buttons.length - 1
        : (index + step + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function CanvasToolbar({
  tool,
  onToolChange,
  disabled = false,
  actions,
}: CanvasToolbarProps) {
  const [focusTool, setFocusTool] = useState(tool);

  return (
    <TooltipProvider delay={350}>
      <div
        className="canvas-toolbar"
        role="toolbar"
        tabIndex={-1}
        aria-label="Canvas tools"
        aria-orientation="vertical"
        data-canvas-ui=""
        onKeyDown={moveFocus}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {TOOLS.map(({ tool: item, label, shortcut, Icon }) => (
          <Tooltip key={item}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="canvas-tool"
                  aria-label={`${label} (${shortcut})`}
                  aria-pressed={tool === item}
                  tabIndex={focusTool === item ? 0 : -1}
                  disabled={disabled}
                  onFocus={() => setFocusTool(item)}
                  onClick={() => onToolChange(item)}
                />
              }
            >
              <Icon size={16} strokeWidth={1.65} aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              {label}
              <kbd className="canvas-tool-shortcut">{shortcut}</kbd>
            </TooltipContent>
          </Tooltip>
        ))}
        {actions && (
          <>
            <div className="canvas-toolbar-divider" aria-hidden="true" />
            {actions}
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
