// "Next plane in 0:42" for the stream: dead-reckon every airborne aircraft
// forward and find when it first becomes trackable (clear of the local
// skyline and the minimum elevation, within range). Departures climbing out
// toward the site count as imminent — they rise into view within seconds.

import {
  FT_TO_M,
  aircraftGeoPoint,
  azElFromSite,
  fixAgeSec,
  horizonMinEl,
  predictGeo,
  type Aircraft,
  type GeoPoint,
  type TargetCriteria,
  type TargetMode,
} from "@shared/index.js";
import { selectTarget, type CurrentTarget } from "./target.js";

export interface NextPlane {
  hex: string;
  flight?: string;
  typeCode?: string;
  typeName?: string;
  /** Seconds until it is on screen: picked by the selector AND above the skyline (0 = now). */
  etaSec: number;
  /** Azimuth where it will appear, deg. */
  azDeg: number;
  departure: boolean;
}

const HORIZON_SEC = 300;
const STEP_SEC = 2;

/** The aircraft as it will be `t` s from now (dead-reckoned, fresh timestamps). */
function project(ac: Aircraft, now: number, t: number): Aircraft | null {
  const geo = aircraftGeoPoint(ac);
  if (!geo) return null;
  if (t === 0) return ac;
  if (ac.onGround || ac.gs == null || ac.track == null) return null;
  const p = predictGeo(
    { lat: geo.lat, lon: geo.lon, altM: geo.altM, gsKt: ac.gs, trackDeg: ac.track, vRateFpm: ac.baroRate },
    fixAgeSec(ac, now) + t,
  );
  const altFt = p.altM / FT_TO_M;
  return { ...ac, lat: p.lat, lon: p.lon, altGeom: altFt, altBaro: altFt, ts: now + t * 1000, seen: 0, seenPos: 0 };
}

/**
 * "Next plane in 0:42" for the stream. Runs the REAL target selector
 * forward on dead-reckoned traffic, starting from the current target: the
 * next plane is the first one the selector would switch to, and its ETA the
 * moment it would also be above the skyline (a departure is picked at
 * lift-off but only seen ~30 s later). The old estimate ("first moment any
 * plane becomes trackable") ignored that the camera was still busy with the
 * current pass and how hysteresis hands over — it ran 10-20 s early.
 */
export function nextPlane(
  aircraft: Aircraft[],
  site: GeoPoint,
  now: number,
  c: TargetCriteria,
  horizon: { azDeg: number; minElDeg: number }[] | undefined,
  /** Current target (a bare hex = held long enough to be challenged). */
  current: CurrentTarget | string | null,
  airport: { lat: number; lon: number } | null,
  sun: { azDeg: number; elDeg: number } | null,
  mode: TargetMode = "closest",
): NextPlane | null {
  const cur0: CurrentTarget | null =
    typeof current === "string" ? { hex: current, sinceMs: now - 3_600_000 } : current;
  let sim: CurrentTarget | null = cur0;
  let picked: { hex: string; t: number; departure: boolean } | null = null;
  for (let t = 0; t <= HORIZON_SEC; t += STEP_SEC) {
    const tNow = now + t * 1000;
    const fleet = aircraft.flatMap((a) => {
      const p = project(a, now, t);
      return p ? [p] : [];
    });
    const sel = selectTarget(fleet, site, tNow, sim, mode, c, undefined, undefined, horizon, sun, airport);
    const hex = sel.hex;
    if (!picked) {
      if (hex && hex !== cur0?.hex) {
        picked = { hex, t, departure: sel.candidates.find((x) => x.hex === hex)?.note === "departure" };
      } else {
        sim = hex ? (sim?.hex === hex ? sim : { hex, sinceMs: tNow }) : null;
        continue;
      }
    }
    // Picked: on screen once it is also clear of the skyline.
    const ac = fleet.find((a) => a.hex === picked!.hex);
    const geo = ac && aircraftGeoPoint(ac);
    if (!ac || !geo) continue;
    const p = azElFromSite(site, geo);
    if (p.elDeg >= horizonMinEl(horizon, p.azDeg, -90) + 1 && p.elDeg >= c.minElevationDeg) {
      return {
        hex: ac.hex, flight: ac.flight, typeCode: ac.typeCode, typeName: ac.typeName,
        etaSec: t, azDeg: p.azDeg, departure: picked.departure,
      };
    }
  }
  return null;
}
