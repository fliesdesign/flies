import { useEffect } from "react";

import type { CanvasControls } from "@/components/canvas/design-canvas";

import { useOnboarding } from "./onboarding-provider";

/** Observe the real document; all edits still use the editor's persistence and undo paths. */
export function OnboardingCanvas({
  controls,
  fileId,
  active,
}: {
  controls: CanvasControls | null;
  fileId: string;
  active: boolean;
}) {
  const tour = useOnboarding();
  const state = tour?.state;
  const dispatch = tour?.dispatch;
  useEffect(() => {
    if (!controls || !active || !dispatch || state?.fileId !== fileId) return;
    if (state.step !== "frame" && state.step !== "color") return;
    const doc = controls.document;
    const existing = new Set(doc.getFrames().map((node) => node.id));

    const inspect = () => {
      if (state.step === "frame") {
        const node = doc
          .getFrames()
          .find(
            (item) =>
              !existing.has(item.id) &&
              (item.kind === "frame" || item.kind === undefined) &&
              item.width > 1 &&
              item.height > 1,
          );

        if (node && (node.kind === "frame" || node.kind === undefined))
          dispatch({ type: "frame", fileId, id: node.id, fill: node.fill ?? "#ffffff" });
      } else {
        const node = doc.getFrame(state.frameId!);
        if (!node) dispatch({ type: "removed", fileId });
        else if (node.kind === "frame" || node.kind === undefined)
          dispatch({ type: "color", fileId, id: node.id, fill: node.fill ?? "#ffffff" });
      }
    };

    if (state.step === "color") {
      controls.setPanelsOpen(true);
      const node = doc.getFrame(state.frameId!);
      if (node) controls.select(node.id);
      inspect();
    }

    return doc.subscribeChanges(inspect);
  }, [controls, active, fileId, state, dispatch]);

  return null;
}
