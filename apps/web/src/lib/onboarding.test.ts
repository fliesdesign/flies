import { describe, expect, it } from "vite-plus/test";

import { tourReducer, type TourState } from "./onboarding";

describe("guided onboarding", () => {
  it("requires a created file, a frame in that file, and a changed fill on that frame", () => {
    let state: TourState = { step: "welcome" };
    state = tourReducer(state, { type: "next" });
    state = tourReducer(state, { type: "next" });
    expect(state.step).toBe("create");
    expect(tourReducer(state, { type: "next" })).toBe(state);
    state = tourReducer(state, { type: "file", id: "practice" });
    expect(
      tourReducer(state, { type: "frame", fileId: "other", id: "frame", fill: "#ffffff" }),
    ).toBe(state);
    state = tourReducer(state, { type: "frame", fileId: "practice", id: "frame", fill: "#FFFFFF" });
    expect(
      tourReducer(state, { type: "color", fileId: "practice", id: "frame", fill: "#ffffff" }),
    ).toBe(state);
    expect(
      tourReducer(state, { type: "color", fileId: "practice", id: "other", fill: "#924ff7" }),
    ).toBe(state);
    state = tourReducer(state, { type: "color", fileId: "practice", id: "frame", fill: "#924ff7" });
    expect(state.step).toBe("complete");
    expect(tourReducer(state, { type: "next" }).step).toBe("done");
  });
  it("allows skipping every step and starting again", () => {
    for (const step of ["welcome", "library", "create", "frame", "color", "complete"] as const)
      expect(tourReducer({ step }, { type: "skip" })).toEqual({ step: "done" });
    expect(tourReducer({ step: "done" }, { type: "restart" })).toEqual({ step: "welcome" });
  });
  it("recovers if the practice frame is deleted before changing its color", () => {
    expect(
      tourReducer(
        { step: "color", fileId: "practice", frameId: "removed" },
        { type: "removed", fileId: "practice" },
      ),
    ).toEqual({ step: "frame", fileId: "practice" });
  });
  it("keeps progress made before a draft receives its server ID", () => {
    const state: TourState = {
      step: "color",
      fileId: "draft",
      frameId: "frame",
      initialFill: "#ffffff",
    };

    expect(tourReducer(state, { type: "file-saved", draftId: "draft", id: "saved" })).toEqual({
      ...state,
      fileId: "saved",
    });
    expect(tourReducer(state, { type: "file-saved", draftId: "other", id: "saved" })).toBe(state);
  });
});
