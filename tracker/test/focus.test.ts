import { describe, expect, it } from "vitest";
import { FocusController, type FocusInput } from "../src/camera/focus.js";

/** Feed the same input every 200 ms over [t0, t1]; collect all actions. */
function run(f: FocusController, i: FocusInput, t0: number, t1: number) {
  const out: ReturnType<FocusController["update"]> = [];
  for (let t = t0; t <= t1; t += 200) out.push(...f.update({ ...i, now: t }));
  return out;
}

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
    f.update({ ...base, now: 5000, edgePx: 8, focusUnits: -3600 });
    const acts = f.update({ ...base, now: 5800, edgePx: 8, focusUnits: -3600 });
    expect(acts).toEqual([{ kind: "nudge", deltaUnits: -270, target: -3870 }]);
    // far off and locked: a one-push sweep beats a 10 s nudge
    f.update({ ...base, now: 9000, edgePx: 8, focusUnits: -2900 });
    expect(f.update({ ...base, now: 9800, edgePx: 8, focusUnits: -2900 })).toEqual([{ kind: "onePush" }]);
  });

  it("goes straight to the learned point once zoom AND lens have settled", () => {
    const f = new FocusController();
    f.update({ ...base, now: 0, edgePx: 2.4, focusUnits: -3870 });
    f.update({ ...base, now: 3000, zoomedIn: false });
    // zoom tracking still moving the lens: nothing yet
    expect(run(f, { ...base, zoomSettled: true, focusUnits: -3000 }, 4000, 4000)).not.toContainEqual(
      expect.objectContaining({ kind: "nudge" }));
    f.update({ ...base, now: 4200, focusUnits: -3400 });
    // still at -3600 for a while → one nudge to the learned point
    const acts = run(f, { ...base, focusUnits: -3600 }, 4400, 6000);
    expect(acts.filter((a) => a.kind === "nudge")).toEqual([{ kind: "nudge", deltaUnits: -270, target: -3870 }]);
  });

  it("one-push only when nothing is learned, rate-limited", () => {
    const f = new FocusController(null, false);
    f.update({ ...base, now: 0, edgePx: 7 });
    expect(f.update({ ...base, now: 800, edgePx: 7 })).toEqual([{ kind: "onePush" }]);
    f.update({ ...base, now: 3000, edgePx: 7 });
    expect(f.update({ ...base, now: 4000, edgePx: 7 })).toEqual([]); // cooldown
  });
});

describe("FocusController gating", () => {
  it("nudges a detected-but-off-centre soft plane; sweeps an undetectably soft one", () => {
    const f = new FocusController();
    const acts = run(f, { ...base, zoomUnits: 1437, locked: false, detected: true, edgePx: 6, focusUnits: -3700 }, 0, 1600);
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -170, target: -3870 });
    const g = new FocusController();
    const b = run(g, { ...base, zoomUnits: 1437, locked: false, detected: false, sweepOk: true, focusUnits: -3200 }, 0, 1600);
    expect(b).toContainEqual({ kind: "onePush" });
  });
});

describe("FocusController by target size", () => {
  it("never sweeps a small (distant) plane; nudges it to the learned point instead", () => {
    const f = new FocusController();
    const acts = run(f, { ...base, zoomUnits: 1437, locked: false, detected: false, sweepOk: true, targetPx: 25, focusUnits: -3200 }, 0, 1600);
    expect(acts).not.toContainEqual({ kind: "onePush" });
    expect(acts).toContainEqual({ kind: "nudge", deltaUnits: -670, target: -3870 });
  });

  it("resets the focus distance to the far stop when a pass starts wide", () => {
    const f = new FocusController();
    f.update({ ...base, zoomedIn: false });
    expect(f.update({ ...base, now: 200, zoomUnits: 0 })).toEqual([{ kind: "farReference" }]);
  });
});
