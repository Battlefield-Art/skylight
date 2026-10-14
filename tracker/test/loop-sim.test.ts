// The real control loop + VISCA driver against a simulated head described by
// the camera profile (test/sim). Pointing accuracy on a close overhead pass,
// on the tilted mount the camera actually sits on and on a level one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_HEAD, baseTracker, runPass, type Flight } from "./sim/run-pass.js";

// UAL875 (2026-10-14): 777 departure heading 297° at 191 kt, climbing
// 2300 ft/min, closest 384 m (350 m up, 158 m away toward az 23), peak 80°.
const OVERHEAD: Flight = {
  startEastM: 2289, startNorthM: -989, altM: 50, gsKt: 191, trackDeg: 297, climbFpm: 2300, durationSec: 60,
};
// EJM450 (2026-10-14): G450 departure, 397 m closest, peak 83° — parked live.
const EJM450: Flight = {
  startEastM: 2420, startNorthM: -979, altM: 40, gsKt: 202, trackDeg: 295, climbFpm: 2688, durationSec: 60,
};
// Straight through the wedge head's own pole (world el ≈ 63° toward az 218):
// the geometric singularity of THIS mount — must be handled by the park.
const POLE: Flight = { startEastM: 2609, startNorthM: -3030, altM: 1500, gsKt: 190, trackDeg: 308, durationSec: 80 };
// UAL8143 (2026-10-14): 275 kt climbing out, closest 2.8 km at az 222 el 65
// — next to the wedge head's pole; parked live and came out 19° off.
const UAL8143: Flight = {
  startEastM: -3648, startNorthM: 2233, altM: 2095, gsKt: 275, trackDeg: 138, climbFpm: 3000, durationSec: 55,
};
// A routine pass: 3 km up, 2 km to the side.
const ROUTINE: Flight = { startEastM: 2000, startNorthM: -9000, altM: 3000, gsKt: 250, trackDeg: 0, durationSec: 70 };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("loop simulation", () => {
  const cases = [["overhead", OVERHEAD], ["ejm450", EJM450], ["pole", POLE], ["ual8143", UAL8143], ["routine", ROUTINE]] as const;
  for (const [name, flight] of cases) {
    for (const lean of [27.35, 0]) {
      // On a level mount the "pole" flight crosses the pan blind spot instead.
      if ((name === "pole" || name === "ual8143") && lean === 0) continue;
      it(`${name} pass, mount lean ${lean}°`, async () => {
        const t = baseTracker();
        const m = await runPass({ ...t, mount: { ...t.mount, levelTiltDeg: lean } }, flight);
        console.log(`${name} lean ${lean}: ${JSON.stringify(m)}`);
        expect(m.samples).toBeGreaterThan(50);
        expect(m.inFrame).toBeGreaterThan(lean > 0 ? 0.97 : 0.9);
      }, 60_000);
    }
  }
});

// The live camera ACKs every zoom command but now and then never executes one
// (2026-10-14: ~1% of zoom commands, more during focus drives; UAL817 sat 4.6 s
// at tele after a target change). Here the head drops every 4th zoom command:
// the lens must still never sit idle away from the zoom asked for longer than
// the driver's resend window (it used to wait for the loop to want another zoom).
describe("loop simulation: dropped zoom commands", () => {
  for (const [name, flight] of [["routine", ROUTINE], ["overhead", OVERHEAD]] as const) {
    it(`${name} pass, every 4th zoom command dropped`, async () => {
      const t = baseTracker();
      const m = await runPass(t, flight, { ...DEFAULT_HEAD, dropZoom: (n) => n % 4 === 0 });
      console.log(`${name} dropped zoom: ${JSON.stringify(m)}`);
      expect(m.zoomCommands).toBeGreaterThanOrEqual(4); // something was dropped
      expect(m.zoomIdleOffMaxSec).toBeLessThan(2.5);
    }, 60_000);
  }
});
