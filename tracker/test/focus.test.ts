import { describe, expect, it } from "vitest";
import { FocusController, type FocusInput } from "../src/camera/focus.js";

const base: FocusInput = { now: 0, zoomedIn: true, zoomUnits: 1200, zoomSettled: true, locked: true, edgePx: null, edgeContrast: 40, focusUnits: -3870 };

describe("FocusController", () => {
  it("seeds full tele and keys by exact zoom (no neighbour fallback)", () => {
    const f = new FocusController();
    expect(f.learned(1437)).toBe(-3870);
    expect(f.learned(1404)).toBeNull();
    const g = new FocusController(null, false);
    g.update({ ...base, zoomUnits: 1404, edgePx: 2.2, focusUnits: -2187 });
    expect(g.learned(1404)).toBe(-2187);
    expect(g.learned(1437)).toBeNull();
  });

  it("does not learn from implausible measurements", () => {
    const f = new FocusController(null, false);
    f.update({ ...base, edgePx: 0.7 });
    f.update({ ...base, now: 100, edgePx: 2.0, edgeContrast: 10 });
    expect(f.learned(1200)).toBeNull();
  });

  it("holds manual focus on zoom-in and AF at wide, without driving the lens", () => {
    const f = new FocusController();
    expect(f.update({ ...base, zoomedIn: false })).toEqual([{ kind: "auto" }]);
    expect(f.update({ ...base, now: 100 })).toEqual([{ kind: "manual" }]);
    expect(f.update({ ...base, now: 200, edgePx: 2.5 })).toEqual([]);
  });

  it("learns sharp positions and nudges straight there when soft", () => {
    const f = new FocusController();
    f.update({ ...base, now: 0, edgePx: 2.4, focusUnits: -3870 }); // learn
    expect(f.learned(1200)).toBe(-3870);
    // later the focus drifted and the plane is soft
    f.update({ ...base, now: 5000, edgePx: 8, focusUnits: -2900 });
    const acts = f.update({ ...base, now: 5800, edgePx: 8, focusUnits: -2900 });
    expect(acts).toEqual([{ kind: "nudge", deltaUnits: -970, target: -3870 }]);
  });

  it("goes straight to the learned point when the zoom settles", () => {
    const f = new FocusController();
    f.update({ ...base, now: 0, edgePx: 2.4, focusUnits: -3870 });
    f.update({ ...base, now: 3000, zoomedIn: false });
    f.update({ ...base, now: 4000, zoomSettled: false, focusUnits: -1000 });
    const acts = f.update({ ...base, now: 5000, zoomSettled: true, focusUnits: -3500 });
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -370, target: -3870 });
  });

  it("one-push only when nothing is learned, rate-limited", () => {
    const f = new FocusController(null, false);
    f.update({ ...base, now: 0, edgePx: 7 });
    expect(f.update({ ...base, now: 800, edgePx: 7 })).toEqual([{ kind: "onePush" }]);
    f.update({ ...base, now: 3000, edgePx: 7 });
    expect(f.update({ ...base, now: 4000, edgePx: 7 })).toEqual([]); // cooldown
  });
});
