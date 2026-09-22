import { ArrowRightIcon, CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";

import { useOnboarding } from "./onboarding-provider";
import "./onboarding.css";

const steps = {
  welcome: {
    title: "A little tour. A first idea.",
    body: "Get to know your workspace, then make a frame of your own. It takes about a minute.",
    target: "dashboard",
    action: "Show me around",
    number: 1,
  },
  library: {
    title: "Everything starts here",
    body: "Find your designs in Files, jump back in with Recents, and keep your workspace tidy with Archive. Your files save automatically as you work.",
    target: "navigation",
    action: "Let’s make something",
    number: 2,
  },
  create: {
    title: "Make room for an idea",
    body: "Click New file, give it a name, and choose Create. This will be a real file you can keep designing in.",
    target: "create",
    number: 3,
  },
  frame: {
    title: "Draw your first frame",
    body: "Choose the Frame tool (F), then drag a small frame on the canvas. Frames hold your designs; add text, shapes, and images inside them.",
    target: "frame",
    number: 4,
  },
  color: {
    title: "Make it yours",
    body: "With your frame selected, use Fill in the right panel to choose a color. Try a swatch or enter a hex value, then press Enter.",
    target: "fill",
    number: 5,
  },
  complete: {
    title: "Your first idea, on canvas.",
    body: "You made a file, drew a frame, and gave it a color. Keep exploring with text, shapes, and images. Undo is always there when you need it.",
    target: "",
    action: "Keep creating",
    number: 6,
  },
} as const;

type Placement = {
  left: number;
  top: number;
  width: number;
  height: number;
  cardLeft: number;
  cardTop: number;
  hidden: boolean;
};
const colors = ["#924ff7", "#cba9f4", "#ececec", "#5aa7ff", "#8ed6b2"];

function Confetti() {
  return (
    <div className="onboarding-confetti" aria-hidden="true">
      {Array.from({ length: 36 }, (_, i) => (
        <span
          key={`piece-${i}`}
          style={
            {
              "--x": `${(i * 29) % 100}vw`,
              "--drift": `${((i * 43) % 240) - 120}px`,
              "--delay": `${(i % 7) * 55}ms`,
              "--spin": `${(i % 2 ? 1 : -1) * (240 + i * 17)}deg`,
              background: colors[i % colors.length],
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}

export function OnboardingGuide({
  activeId,
  ready,
  onNavigate,
}: {
  activeId: string | null;
  ready: boolean;
  onNavigate: (id: string | null) => void;
}) {
  const tour = useOnboarding();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const step = tour?.state.step ?? "done";
  const state = tour?.state;
  const dispatch = tour?.dispatch;
  const info = step === "done" ? null : steps[step];
  const inEditor = step === "frame" || step === "color" || step === "complete";
  const away = inEditor ? activeId !== state?.fileId : activeId !== null;

  useEffect(() => {
    if (!info || !ready) return;
    let frame = 0;
    let revealedTarget: HTMLElement | undefined;

    const visible = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.getClientRects().length > 0 && !element.closest("[hidden], [inert]"),
      );

    const measure = () => {
      const naming = !!visible("[data-onboarding-dialog]");
      let target = away ? undefined : visible(`[data-onboarding="${info.target}"]`);
      if (step === "frame" && target?.getAttribute("aria-pressed") === "true")
        target = visible(".design-canvas");

      if (step === "color" && target && target !== revealedTarget) {
        revealedTarget = target;
        target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
      }

      const rect = target?.getBoundingClientRect();
      const width = Math.min(320, window.innerWidth - 24);

      const cardHeight =
        document.querySelector<HTMLElement>(".onboarding-card")?.offsetHeight ?? 280;

      let left = Math.max(12, (window.innerWidth - width) / 2);
      let top = Math.max(12, (window.innerHeight - cardHeight) / 2);

      if (rect) {
        if (rect.right + width + 28 < window.innerWidth) {
          left = rect.right + 16;
          top = rect.top;
        } else if (rect.left - width - 16 >= 12) {
          left = rect.left - width - 16;
          top = rect.top;
        } else {
          left = window.innerWidth - width - 20;
          top =
            rect.bottom + cardHeight + 28 < window.innerHeight
              ? rect.bottom + 16
              : rect.top - cardHeight - 16;
          if (top < 12) top = window.innerHeight - cardHeight - 20;
        }
      }

      const next = {
        left: Math.max(4, (rect?.left ?? 0) - 5),
        top: Math.max(4, (rect?.top ?? 0) - 5),
        width: rect ? Math.min(rect.width + 10, window.innerWidth - 8) : 0,
        height: rect ? Math.min(rect.height + 10, window.innerHeight - 8) : 0,
        cardLeft: Math.max(12, Math.min(left, window.innerWidth - width - 12)),
        cardTop: Math.max(12, Math.min(top, window.innerHeight - cardHeight - 12)),
        hidden: naming,
      };

      setPlacement((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };

    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "aria-pressed", "data-state"],
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [info, step, ready, away]);

  useEffect(() => {
    if (!info || !ready || placement?.hidden) return;

    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input, textarea, [role="dialog"], [contenteditable="true"]'))
      )
        return;
      dispatch?.({ type: "skip" });
    };

    window.addEventListener("keydown", escape);

    return () => window.removeEventListener("keydown", escape);
  }, [dispatch, info, ready, placement?.hidden]);

  if (
    !tour ||
    !info ||
    !ready ||
    !placement ||
    placement.hidden ||
    (step === "welcome" && activeId)
  )
    return null;

  return createPortal(
    <div className="onboarding-layer">
      {placement.width > 0 && !away && (
        <div
          className="onboarding-spot"
          style={{
            left: placement.left,
            top: placement.top,
            width: placement.width,
            height: placement.height,
          }}
        />
      )}
      {step === "complete" && !away && <Confetti />}
      <section
        className="onboarding-card"

        aria-label="Getting started guide"
        style={{ left: placement.cardLeft, top: placement.cardTop }}
      >
        <div className="onboarding-meta">
          <span>
            <SparklesIcon size={13} /> YOUR FIRST DESIGN
          </span>
          <button
            type="button"
            aria-label="Skip onboarding"
            onClick={() => dispatch?.({ type: "skip" })}
          >
            <XIcon size={16} />
          </button>
        </div>
        <div aria-live="polite" aria-atomic="true">
          <h2>{away ? "Pick up where you left off" : info.title}</h2>
          <p>
            {away
              ? inEditor
                ? "Return to your practice file to finish your first design. You can also skip the guide at any time."
                : "Head back to your files to continue the tour."
              : info.body}
          </p>
        </div>
        {step === "complete" && !away && (
          <div className="onboarding-achievement">
            <CheckIcon size={14} /> File · Frame · Your color
          </div>
        )}
        <div className="onboarding-footer">
          <span className="onboarding-count">
            {info.number} <span>/ 6</span>
          </span>
          <button
            type="button"
            className="onboarding-skip"
            onClick={() => dispatch?.({ type: "skip" })}
          >
            Skip tour
          </button>
          {away ? (
            <Button size="sm" onClick={() => onNavigate(inEditor ? (state?.fileId ?? null) : null)}>
              Continue tour <ArrowRightIcon />
            </Button>
          ) : "action" in info ? (
            <Button
              size="sm"
              onClick={() => {
                if (step === "library") onNavigate(null);
                dispatch?.({ type: "next" });
              }}
            >
              {info.action}
              <ArrowRightIcon />
            </Button>
          ) : (
            <span className="onboarding-hint">
              Try it in the app <ArrowRightIcon size={12} />
            </span>
          )}
        </div>
        <div className="onboarding-progress" aria-hidden="true">
          <span style={{ width: `${(info.number / 6) * 100}%` }} />
        </div>
      </section>
    </div>,
    document.body,
  );
}
