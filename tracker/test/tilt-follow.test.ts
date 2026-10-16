// limits.followTiltOffset: an automatic mount update that moves the tilt
// offset moves the tilt range and the park tilt by the same amount (encoder
// degrees), keeping the head's physical range after a tilt-zero slip.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type Config } from "@shared/index.js";

async function loopWith(follow: boolean) {
  vi.stubEnv("SKYLIGHT_TRACKER_DATA", (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "tf-")));
  const { ControlLoop } = await import("../src/loop.js");
  const t = DEFAULT_CONFIG.tracker;
  const cfg: Config = { ...DEFAULT_CONFIG, tracker: { ...t, limits: { ...t.limits, tiltMinDeg: -20, tiltMaxDeg: 85, followTiltOffset: follow }, mount: { ...t.mount, tiltOffsetDeg: 6, tiltGain: 1 } } };
  const upstream = { start() {}, stop() {}, isConnected: () => true, getConfig: () => cfg, getAircraft: () => [], find: () => undefined, patchConfig() {} };
  const loop = new ControlLoop(upstream as never, () => null as never, { write() {} } as never, { latestFrame: () => null, latestFrameAt: () => 0, status: () => ({ running: false }) } as never, () => {});
  return { loop: loop as unknown as { mountPatch(m: unknown): { tracker: Record<string, any> } }, cfg };
}

describe("tilt range follows the tilt offset", () => {
  it("moves limits and park tilt by −Δoffset when enabled", async () => {
    const { loop, cfg } = await loopWith(true);
    const p = loop.mountPatch({ ...cfg.tracker.mount, tiltOffsetDeg: 8 });
    expect(p.tracker.limits.tiltMinDeg).toBeCloseTo(-22, 6);
    expect(p.tracker.limits.tiltMaxDeg).toBeCloseTo(83, 6);
    expect(p.tracker.camera.mechanical.parkTiltMaxDeg).toBeCloseTo(cfg.tracker.camera.mechanical.parkTiltMaxDeg - 2, 6);
    expect(p.tracker.limits.horizon).toEqual(cfg.tracker.limits.horizon);
  });
  it("leaves them alone when disabled", async () => {
    const { loop, cfg } = await loopWith(false);
    const p = loop.mountPatch({ ...cfg.tracker.mount, tiltOffsetDeg: 8 });
    expect(p.tracker.limits).toBeUndefined();
    expect(p.tracker.mount.tiltOffsetDeg).toBe(8);
  });
});
