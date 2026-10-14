// Run the real ControlLoop + ViscaCamera driver against a FakeViscaHead for
// one synthetic straight-line flight, on the fake clock, and measure how well
// the camera axis follows the plane. Offline twin for control changes.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  DEFAULT_CONFIG,
  FT_TO_M,
  angularSepDeg,
  azElFromSite,
  predictGeo,
  worldFromMount,
  type Aircraft,
  type CameraProfile,
  type Config,
  type TrackerConfig,
} from "@shared/index.js";
import { FakeViscaHead, type HeadOptions } from "./fake-visca-head.js";
import PI from "./pi-tracker-2026-10-14.json" with { type: "json" };

export interface Flight {
  /** Start position offset from the site, m (east, north). */
  startEastM: number;
  startNorthM: number;
  altM: number;
  gsKt: number;
  trackDeg: number;
  /** Climb rate, ft/min (0 = level). */
  climbFpm?: number;
  durationSec: number;
}

export interface PassMetrics {
  samples: number;
  /** Camera-axis error to the true plane, deg. */
  errP50: number;
  errP95: number;
  errMax: number;
  /** Fraction of samples with the plane inside the frame. */
  inFrame: number;
  /** p95 of error ÷ HFOV (frame widths). */
  errFrameP95: number;
  /** Loop events of interest (zenith park/follow/release), with sim time. */
  events: string[];
}

export function baseTracker(over: Partial<TrackerConfig> = {}): TrackerConfig {
  const t = DEFAULT_CONFIG.tracker;
  return {
    ...t,
    ...(PI as unknown as Partial<TrackerConfig>),
    driver: "visca",
    // no video in the sim: framing from ADS-B only
    vision: { ...t.vision, ...(PI.vision as object), lockWide: false, applyCorrection: false },
    home: { ...t.home, enabled: false },
    ...over,
  } as TrackerConfig;
}

export const DEFAULT_HEAD: HeadOptions = { panLatencySec: 0.4, tiltLatencySec: 0.4, poseLagSec: 0.18 };

export async function runPass(
  tracker: TrackerConfig,
  flight: Flight,
  head: HeadOptions = DEFAULT_HEAD,
  profile?: CameraProfile,
): Promise<PassMetrics> {
  vi.stubEnv("SKYLIGHT_TRACKER_DATA", mkdtempSync(join(tmpdir(), "skylight-sim-")));
  const { ControlLoop } = await import("../../src/loop.js");
  const cfg: Config = { ...DEFAULT_CONFIG, tracker: { ...tracker, camera: profile ?? tracker.camera } };
  const sim = new FakeViscaHead(cfg.tracker.camera, cfg.tracker.units, cfg.tracker.limits, head);

  const site = cfg.tracker.site;
  const cosLat = Math.cos((site.lat * Math.PI) / 180);
  const start = {
    lat: site.lat + flight.startNorthM / 111320,
    lon: site.lon + flight.startEastM / (111320 * cosLat),
    altM: flight.altM,
  };
  const kin = { ...start, gsKt: flight.gsKt, trackDeg: flight.trackDeg, vRateFpm: flight.climbFpm ?? 0 };
  const t0 = Date.now();
  let fix: Aircraft | null = null;
  const makeFix = (): Aircraft => {
    const sec = (Date.now() - t0) / 1000;
    const p = predictGeo(kin, sec);
    return {
      hex: "sim001", flight: "SIM1", typeCode: "B772", lat: p.lat, lon: p.lon,
      altGeom: p.altM / FT_TO_M, altBaro: p.altM / FT_TO_M, gs: flight.gsKt, track: flight.trackDeg,
      baroRate: flight.climbFpm ?? 0, ts: Date.now(), seen: 0, seenPos: 0,
    } as Aircraft;
  };
  const upstream = {
    start() {}, stop() {}, isConnected: () => true,
    getConfig: () => cfg,
    getAircraft: () => (fix ? [fix] : []),
    find: (hex: string) => (fix && fix.hex === hex ? fix : undefined),
    patchConfig() {},
  };
  const recorder = { write() {}, recording: false, start() {}, stop() {} };
  const video = { latestFrame: () => null, latestFrameAt: () => 0, status: () => ({ running: false }) };
  const loop = new ControlLoop(
    upstream as never, () => sim.driver, recorder as never, video as never, () => {},
  );
  const events: string[] = [];
  loop.onEvent((e) => {
    if (e.kind === "zenith") events.push(`${((e.t - t0) / 1000).toFixed(1)}s ${e.kind}:${(e as { phase?: string }).phase}`);
  });
  fix = makeFix();
  loop.onSnapshot(Date.now(), [fix]);
  loop.manualTarget("sim001");
  sim.driver.start();
  loop.start();

  const errs: number[] = [];
  const frac: number[] = [];
  let inFrame = 0;
  const DT = 50;
  for (let ms = 0; ms < flight.durationSec * 1000; ms += DT) {
    await vi.advanceTimersByTimeAsync(DT);
    sim.tick(DT / 1000);
    if (ms % 1000 < DT) {
      fix = makeFix();
      loop.onSnapshot(Date.now(), [fix]);
    }
    const truth = azElFromSite(site, predictGeo(kin, (Date.now() - t0) / 1000));
    if (truth.elDeg < 20 || ms < 8000) continue; // settle + clear sky only
    const axis = worldFromMount({ panDeg: sim.panDeg, tiltDeg: sim.tiltDeg }, cfg.tracker.mount);
    const err = angularSepDeg(axis.azDeg, axis.elDeg, truth.azDeg, truth.elDeg);
    const hfov = hfovAt(cfg.tracker, sim.zoom);
    errs.push(err);
    frac.push(err / hfov);
    if (err < hfov / 2 * 0.9) inFrame++;
  }
  loop.stop();
  sim.driver.stop();
  vi.unstubAllEnvs();
  const q = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN;
  };
  return {
    samples: errs.length,
    errP50: q(errs, 0.5),
    errP95: q(errs, 0.95),
    errMax: Math.max(...errs),
    inFrame: errs.length ? inFrame / errs.length : 0,
    errFrameP95: q(frac, 0.95),
    events,
  };
}

function hfovAt(t: TrackerConfig, units: number): number {
  const lut = [...t.zoom.fovLut].sort((a, b) => a.units - b.units);
  if (units <= lut[0].units) return lut[0].hfovDeg;
  for (let i = 1; i < lut.length; i++) {
    if (units <= lut[i].units) {
      const f = (units - lut[i - 1].units) / (lut[i].units - lut[i - 1].units);
      return lut[i - 1].hfovDeg + f * (lut[i].hfovDeg - lut[i - 1].hfovDeg);
    }
  }
  return lut[lut.length - 1].hfovDeg;
}
