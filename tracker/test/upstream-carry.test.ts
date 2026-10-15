// A poll that omits an aircraft's position must not make it vanish downstream.
import { describe, expect, it } from "vitest";
import type { Aircraft } from "@shared/index.js";
import { fixAgeSec } from "@shared/index.js";
import { PositionCarry } from "../src/upstream.js";

const ac = (o: Partial<Aircraft>): Aircraft => ({ hex: "a99796", ts: 0, seen: 0, ...o }) as Aircraft;

describe("PositionCarry", () => {
  it("fills a one-poll position dropout with the last fix and its true age (2026-10-15 departure flicker)", () => {
    const c = new PositionCarry();
    c.apply([ac({ lat: 37.61, lon: -122.39, seenPos: 0.466, ts: 112_100 })], 112_100);
    const [a] = c.apply([ac({ seen: 0.219, ts: 112_600 })], 112_600); // no lat/lon, no seen_pos
    expect(a.lat).toBe(37.61);
    expect(a.lon).toBe(-122.39);
    expect(fixAgeSec(a, 112_600)).toBeCloseTo(0.966, 3); // the fix is 0.97 s old, not fresh
  });

  it("does not resurrect an aircraft that left the feed, nor invent a position never received", () => {
    const c = new PositionCarry();
    c.apply([ac({ lat: 37.6, lon: -122.4, seenPos: 0 })], 0);
    c.apply([], 1000); // gone
    const [a] = c.apply([ac({ ts: 2000 })], 2000);
    expect(a.lat).toBeUndefined();
    const [b] = new PositionCarry().apply([ac({ hex: "new1" })], 0);
    expect(b.lat).toBeUndefined();
  });

  it("a carried fix keeps ageing until the staleness limit drops it", () => {
    const c = new PositionCarry();
    c.apply([ac({ lat: 37.6, lon: -122.4, seenPos: 0, ts: 0 })], 0);
    let a!: Aircraft;
    for (let t = 1000; t <= 40_000; t += 1000) [a] = c.apply([ac({ ts: t })], t);
    expect(fixAgeSec(a, 40_000)).toBeCloseTo(40, 3); // > posStaleSec (30): filtered as stale
  });
});
