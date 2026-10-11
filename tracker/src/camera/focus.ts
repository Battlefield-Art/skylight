// Focus at tele, driven by measurement instead of the camera's AF.
//
// What the lens actually does (probed 2026-10-11, TONGVEO, signed focus units
// from `81 09 04 48`, larger = nearer):
//  - In MANUAL focus the camera keeps zoom-tracking: zooming in from the wide
//    infinity point (≈ −2000) carries focus to ≈ −3870 at full tele, which
//    is sharp. Nothing needs to happen for a zoom-in to arrive in focus.
//  - The far stop at tele is ≈ −4117 — ~250 units past sharp, so "drive to
//    the far stop = infinity" is soft at 20×.
//  - One-push AF sweeps the whole range at ~400 units/s: 5+ s of visible
//    racking per attempt (the "takes way too long to focus" complaint).
//  - Focus Direct (`81 01 04 48`) is ignored; far/near drives at speed 7
//    move ≈ 80-95 units/s.
//
// So: hold manual focus while tracking; measure sharpness on the plane
// (vision/sharpness.ts edge width); learn the sharp focus position per zoom;
// when soft, NUDGE straight to the learned position. One-push only when
// nothing has been learned for this zoom yet.

import fs from "node:fs";
import { dirname } from "node:path";

/** Edge width (full-res px) at or below which the plane counts as sharp. */
export const FE_SHARP = 3.0;
/** ...and above which it counts as soft (needs correcting). */
export const FE_SOFT = 4.0;
/** Zoom buckets for the learned table, units. Near tele the zoom-tracking
 *  curve is ~37 focus units per zoom unit (zoom 1385 → −1924, 1437 → −3870),
 *  so only the exact zoom is meaningful: the ladder's rungs recur exactly.
 *  (A 32-unit bucket with neighbour fallback nudged a 1437 plane to the
 *  focus learned at 1404 — 1700 units off — and blurred a whole pass.) */
export const LUT_BUCKET = 4;
/** Seed: full tele, measured sharp at −3857…−3905 on two passes + probe. */
export const TELE_SEED: [number, number] = [1437, -3870];
/** Believable measurements only: sub-pixel edges are compression/tiny-plane
 *  artefacts, low contrast is haze. */
const LEARN_MIN_EDGE = 1.2;
const LEARN_MIN_CONTRAST = 25;
/** Nudge only when the lens is at least this far from the learned point. */
export const NUDGE_MIN_UNITS = 30;
/** Beyond this a nudge takes >4 s at ~85 u/s; a one-push sweep with the
 *  plane centred lands in ~1-3 s (UAL2317: 1.2 s), so use that instead. */
export const ONEPUSH_ABOVE_UNITS = 350;
const SOFT_HOLD_MS = 700;
const ACTION_COOLDOWN_MS = 1500;
const ONEPUSH_COOLDOWN_MS = 8000;
/** Slow: sharp samples spread across a ~300-unit depth-of-field zone at
 *  tele; a fast average walked to its far edge (−4142 at 1437). */
const LEARN_ALPHA = 0.08;

export interface FocusInput {
  now: number;
  /** Manual-focus regime: a target is being tracked. Manual from the moment
   *  a target is picked, before any zoom — continuous AF left on while the
   *  zoom climbed hunted on blank sky, and the camera's zoom tracking then
   *  carried that error up to tele (SKW3462 arrived 1000 units off). */
  zoomedIn: boolean;
  zoomUnits: number;
  /** The zoom ladder isn't stepping (the lens is at its final zoom). */
  zoomSettled: boolean;
  /** Fresh, centred, steady lock on the plane (gates learning). */
  locked: boolean;
  /** The plane is detected at all (gates soft-correction nudges). */
  detected?: boolean;
  /** Camera steady and the plane centred or, when not detected (too soft
   *  to see), the aim settled on the prediction — the camera's centre-
   *  weighted one-push AF will find it (gates sweeps). */
  sweepOk?: boolean;
  /** Latest sharpness measurement on the plane, if fresh. */
  edgePx: number | null;
  /** Its contrast (luma p98−p2). */
  edgeContrast?: number | null;
  /** Lens focus position (signed raw units), if known. */
  focusUnits: number | null;
}

export type FocusAction =
  | { kind: "auto" }
  | { kind: "manual" }
  | { kind: "nudge"; deltaUnits: number; target: number }
  | { kind: "onePush" };

interface LutEntry { focus: number; edgePx: number; n: number; at: number }

export class FocusController {
  private lut = new Map<number, LutEntry>();
  private mode: "auto" | "manual" | null = null;
  private softSince: number | null = null;
  private lastActionAt = -Infinity;
  private lastOnePushAt = -Infinity;
  private wasSettled = false;
  private dirty = false;
  private lastSaveAt = 0;

  constructor(private file: string | null = null, seed = true) {
    if (file) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { bucket?: number; lut?: Record<string, LutEntry> };
        if (raw.bucket === LUT_BUCKET && raw.lut) for (const [k, v] of Object.entries(raw.lut)) this.lut.set(Number(k), v);
      } catch {
        /* first run */
      }
    }
    const tb = Math.round(TELE_SEED[0] / LUT_BUCKET);
    if (seed && !this.lut.has(tb)) this.lut.set(tb, { focus: TELE_SEED[1], edgePx: 3, n: 0, at: 0 });
  }

  /** Learned sharp focus for exactly this zoom (its 4-unit bucket). */
  learned(zoomUnits: number): number | null {
    return this.lut.get(Math.round(zoomUnits / LUT_BUCKET))?.focus ?? null;
  }

  table(): Record<number, LutEntry> {
    return Object.fromEntries(this.lut);
  }

  /** One control step; returns the actions to send this tick (often none). */
  update(i: FocusInput): FocusAction[] {
    const out: FocusAction[] = [];
    if (!i.zoomedIn) {
      // Idle at home: continuous AF on the scenery parks focus on the wide
      // infinity point the zoom tracking starts from.
      if (this.mode !== "auto") { this.mode = "auto"; out.push({ kind: "auto" }); }
      this.softSince = null;
      this.wasSettled = false;
      return out;
    }
    if (this.mode !== "manual") { this.mode = "manual"; out.push({ kind: "manual" }); }

    const target = this.learned(i.zoomUnits);
    const sharp = i.edgePx != null && i.edgePx <= FE_SHARP;
    const soft = i.edgePx != null && i.edgePx > FE_SOFT;

    // Learn: a sharp plane at a settled zoom → that focus is right for it.
    if (
      sharp && i.edgePx! >= LEARN_MIN_EDGE && (i.edgeContrast ?? 0) >= LEARN_MIN_CONTRAST &&
      i.zoomSettled && i.locked && i.focusUnits != null
    ) this.learn(i.zoomUnits, i.focusUnits, i.edgePx!, i.now);

    this.softSince = soft ? (this.softSince ?? i.now) : null;
    const justSettled = i.zoomSettled && !this.wasSettled;
    this.wasSettled = i.zoomSettled;
    if (!i.zoomSettled || i.now - this.lastActionAt < ACTION_COOLDOWN_MS) return out;

    const off = target != null && i.focusUnits != null ? target - i.focusUnits : null;
    const canSweep = (i.sweepOk ?? i.locked) && i.now - this.lastOnePushAt > ONEPUSH_COOLDOWN_MS;
    // Arriving at a zoom we know: go straight to the learned point.
    if (justSettled && off != null && Math.abs(off) > 2 * NUDGE_MIN_UNITS) {
      this.lastActionAt = i.now;
      if (Math.abs(off) > ONEPUSH_ABOVE_UNITS && canSweep) {
        this.lastOnePushAt = i.now;
        out.push({ kind: "onePush" });
      } else out.push({ kind: "nudge", deltaUnits: off, target: target! });
      return out;
    }
    // Soft on the plane for a moment: correct.
    if ((i.detected ?? i.locked) && this.softSince != null && i.now - this.softSince >= SOFT_HOLD_MS) {
      if (off != null && Math.abs(off) > NUDGE_MIN_UNITS && !(Math.abs(off) > ONEPUSH_ABOVE_UNITS && canSweep)) {
        this.lastActionAt = i.now;
        this.softSince = null;
        out.push({ kind: "nudge", deltaUnits: off, target: target! });
      } else if (canSweep) {
        // Nothing learned here (or the learned point is soft now): sweep.
        this.lastActionAt = i.now;
        this.lastOnePushAt = i.now;
        this.softSince = null;
        out.push({ kind: "onePush" });
      }
    }
    return out;
  }

  private learn(zoom: number, focus: number, edgePx: number, now: number): void {
    const b = Math.round(zoom / LUT_BUCKET);
    const e = this.lut.get(b);
    if (!e) this.lut.set(b, { focus, edgePx, n: 1, at: now });
    else {
      // Weight sharper observations more.
      e.focus = e.focus + LEARN_ALPHA * (focus - e.focus);
      e.edgePx = e.edgePx + 0.3 * (edgePx - e.edgePx);
      e.n++;
      e.at = now;
    }
    this.dirty = true;
    if (this.file && now - this.lastSaveAt > 30_000) this.flush(now);
  }

  flush(now = Date.now()): void {
    if (!this.file || !this.dirty) return;
    this.lastSaveAt = now;
    this.dirty = false;
    try {
      fs.mkdirSync(dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ bucket: LUT_BUCKET, lut: this.table() }));
    } catch {
      /* best-effort */
    }
  }
}
