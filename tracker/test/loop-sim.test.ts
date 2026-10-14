// The real control loop + VISCA driver against a simulated head described by
// the camera profile (test/sim). Pointing accuracy on a close overhead pass,
// on the tilted mount the camera actually sits on and on a level one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseTracker, runPass, type Flight } from "./sim/run-pass.js";

// UAL875 (2026-10-14): 777 departure heading 297° at 191 kt, climbing
// 2300 ft/min, closest 384 m (350 m up, 158 m away toward az 23), peak 80°.
const OVERHEAD: Flight = {
  startEastM: 2289, startNorthM: -989, altM: 50, gsKt: 191, trackDeg: 297, climbFpm: 2300, durationSec: 60,
};
// A routine pass: 3 km up, 2 km to the side.
const ROUTINE: Flight = { startEastM: 2000, startNorthM: -9000, altM: 3000, gsKt: 250, trackDeg: 0, durationSec: 70 };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("loop simulation", () => {
  for (const [name, flight] of [["overhead", OVERHEAD], ["routine", ROUTINE]] as const) {
    for (const lean of [27.35, 0]) {
      it(`${name} pass, mount lean ${lean}°`, async () => {
        const t = baseTracker();
        const m = await runPass({ ...t, mount: { ...t.mount, levelTiltDeg: lean } }, flight);
        console.log(`${name} lean ${lean}: ${JSON.stringify(m)}`);
        expect(m.samples).toBeGreaterThan(50);
        expect(m.inFrame).toBeGreaterThan(0.9);
      }, 60_000);
    }
  }
});
