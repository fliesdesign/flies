export type TourStep = "welcome" | "library" | "create" | "frame" | "color" | "complete" | "done";
export type TourState = {
  step: TourStep;
  fileId?: string;
  frameId?: string;
  initialFill?: string;
};
export type TourAction =
  | { type: "next" }
  | { type: "skip" }
  | { type: "restart" }
  | { type: "file"; id: string }
  | { type: "file-saved"; draftId: string; id: string }
  | { type: "frame"; fileId: string; id: string; fill: string }
  | { type: "color"; fileId: string; id: string; fill: string }
  | { type: "removed"; fileId: string };

export function tourReducer(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case "skip":
      return { step: "done" };
    case "restart":
      return { step: "welcome" };
    case "next":
      if (state.step === "welcome") return { step: "library" };
      if (state.step === "library") return { step: "create" };
      if (state.step === "complete") return { step: "done" };

      return state;
    case "file":
      return state.step === "create" ? { step: "frame", fileId: action.id } : state;
    case "file-saved":
      return state.fileId === action.draftId ? { ...state, fileId: action.id } : state;
    case "frame":
      return state.step === "frame" && state.fileId === action.fileId
        ? { ...state, step: "color", frameId: action.id, initialFill: action.fill.toLowerCase() }
        : state;
    case "color":
      return state.step === "color" &&
        state.fileId === action.fileId &&
        state.frameId === action.id &&
        action.fill.toLowerCase() !== state.initialFill
        ? { ...state, step: "complete" }
        : state;
    case "removed":
      return state.step === "color" && state.fileId === action.fileId
        ? { step: "frame", fileId: state.fileId }
        : state;
  }
}

export function readTour(key: string): TourState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");

    if (value && typeof value === "object" && "step" in value) {
      if (["welcome", "library", "create", "done"].includes(String(value.step)))
        return { step: value.step as TourStep };

      if ("fileId" in value && typeof value.fileId === "string") {
        if (value.step === "frame") return { step: "frame", fileId: value.fileId };
        if (
          (value.step === "color" || value.step === "complete") &&
          "frameId" in value &&
          typeof value.frameId === "string" &&
          "initialFill" in value &&
          typeof value.initialFill === "string"
        )
          return {
            step: value.step,
            fileId: value.fileId,
            frameId: value.frameId,
            initialFill: value.initialFill,
          };
      }
    }
  } catch {
    /* Storage may be unavailable; the tour still works for this session. */
  }

  return { step: "welcome" };
}
