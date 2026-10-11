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
// So: hold manual focus while zoomed in; measure sharpness on the plane
// (vision/sharpness.ts edge width); learn the sharp focus position per zoom;
// when soft, NUDGE straight to the learned position. One-push only when
// nothing has been learned for this zoom yet.

import fs from "node:fs";
import { dirname } from "node:path";

/** Edge width (full-res px) at or below which the plane counts as sharp. */
export const FE_SHARP = 3.0;
/** ...and above which it counts as soft (needs correcting). */
export const FE_SOFT = 4.0;
/** Zoom buckets for the learned table, units. */
export const LUT_BUCKET = 32;
/** Nudge only when the lens is at least this far from the learned point. */
export const NUDGE_MIN_UNITS = 30;
const SOFT_HOLD_MS = 700;
const ACTION_COOLDOWN_MS = 1500;
const ONEPUSH_COOLDOWN_MS = 8000;
const LEARN_ALPHA = 0.3;

export interface FocusInput {
  now: number;
  /** Meaningfully zoomed in (manual focus regime). */
  zoomedIn: boolean;
  zoomUnits: number;
  /** The zoom ladder isn't stepping (the lens is at its final zoom). */
  zoomSettled: boolean;
  /** Fresh, centred, steady lock on the plane. */
  locked: boolean;
  /** Latest sharpness measurement on the plane, if fresh. */
  edgePx: number | null;
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

  constructor(private file: string | null = null) {
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, LutEntry>;
      for (const [k, v] of Object.entries(raw)) this.lut.set(Number(k), v);
    } catch {
      /* first run */
    }
  }

  /** Learned sharp focus for a zoom (nearest bucket within one step). */
  learned(zoomUnits: number): number | null {
    const b = Math.round(zoomUnits / LUT_BUCKET);
    for (const k of [b, b - 1, b + 1]) {
      const e = this.lut.get(k);
      if (e) return e.focus;
    }
    return null;
  }

  table(): Record<number, LutEntry> {
    return Object.fromEntries(this.lut);
  }

  /** One control step; returns the actions to send this tick (often none). */
  update(i: FocusInput): FocusAction[] {
    const out: FocusAction[] = [];
    if (!i.zoomedIn) {
      // Wide: continuous AF is fine (hyperfocal), and it parks focus on the
      // wide infinity point the zoom tracking starts from.
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
    if (sharp && i.zoomSettled && i.locked && i.focusUnits != null) this.learn(i.zoomUnits, i.focusUnits, i.edgePx!, i.now);

    this.softSince = soft ? (this.softSince ?? i.now) : null;
    const justSettled = i.zoomSettled && !this.wasSettled;
    this.wasSettled = i.zoomSettled;
    if (!i.zoomSettled || i.now - this.lastActionAt < ACTION_COOLDOWN_MS) return out;

    const off = target != null && i.focusUnits != null ? target - i.focusUnits : null;
    // Arriving at a zoom we know: go straight to the learned point.
    if (justSettled && off != null && Math.abs(off) > 2 * NUDGE_MIN_UNITS) {
      this.lastActionAt = i.now;
      out.push({ kind: "nudge", deltaUnits: off, target: target! });
      return out;
    }
    // Soft on the plane for a moment: correct.
    if (i.locked && this.softSince != null && i.now - this.softSince >= SOFT_HOLD_MS) {
      if (off != null && Math.abs(off) > NUDGE_MIN_UNITS) {
        this.lastActionAt = i.now;
        this.softSince = null;
        out.push({ kind: "nudge", deltaUnits: off, target: target! });
      } else if (i.now - this.lastOnePushAt > ONEPUSH_COOLDOWN_MS) {
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
      const a = edgePx < e.edgePx ? Math.min(0.6, LEARN_ALPHA * 1.5) : LEARN_ALPHA;
      e.focus = e.focus + a * (focus - e.focus);
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
      fs.writeFileSync(this.file, JSON.stringify(this.table()));
    } catch {
      /* best-effort */
    }
  }
}
