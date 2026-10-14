import { describe, expect, it } from "vitest";
import { alongTrackSec, LeadLearner } from "../src/pointing/leadLearn.js";

describe("alongTrackSec", () => {
  it("reads a plane 1° ahead of the aim at 2°/s as +0.5 s", () => {
    // moving +el at 2°/s, plane 1° above the aim
    expect(alongTrackSec(0, 1, 30, 0, 2)).toBeCloseTo(0.5, 6);
    // moving +az at el 60 (2°/s of az = 1°/s across the sky), plane 1° of
    // az (= 0.5° across the sky) behind the aim
    expect(alongTrackSec(-1, 0, 60, 2, 0)).toBeCloseTo(-0.5, 6);
  });
  it("ignores cross-track offsets and slow planes", () => {
    expect(alongTrackSec(1, 0, 0, 0, 2)).toBeCloseTo(0, 6);
    expect(alongTrackSec(0, 1, 30, 0, 0.2)).toBeNull();
  });
});

describe("LeadLearner", () => {
  const pass = (l: LeadLearner, sec: number, n = 30) => {
    for (let i = 0; i < n; i++) l.push(sec + (i % 3 - 1) * 0.05);
  };
  it("folds half the agreed error after three passes", () => {
    const l = new LeadLearner();
    pass(l, -0.6); expect(l.endPass(0, 0.6)).toBeNull();
    pass(l, -0.5); expect(l.endPass(1, 0.6)).toBeNull();
    pass(l, -0.55);
    const r = l.endPass(2, 0.6)!;
    expect(r.medianSec).toBeCloseTo(-0.55, 2);
    expect(r.leadSec).toBeCloseTo(0.6 - 0.275, 2);
  });
  it("does nothing when passes disagree, are small, or too short", () => {
    const l = new LeadLearner();
    pass(l, 0.4); l.endPass(0, 0.3);
    pass(l, -0.4); l.endPass(1, 0.3);
    pass(l, 0.4); expect(l.endPass(2, 0.3)).toBeNull();
    const s = new LeadLearner();
    for (const t of [0, 1, 2]) { pass(s, 0.03); expect(s.endPass(t, 0.3)).toBeNull(); }
    const short = new LeadLearner();
    for (const t of [0, 1, 2]) { pass(short, 0.5, 5); expect(short.endPass(t, 0.3)).toBeNull(); }
  });
});
