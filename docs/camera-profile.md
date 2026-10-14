# Camera-agnostic tracking: the camera profile

Goal: plug in any PTZ camera, at any mount angle, and configure it — no code
tuned to one model. Everything the control loop needs to know about a camera
is **measured** by a characterization tool and stored as data in the tracker
config (`tracker.camera`). The loop derives its behaviour from that data and
from the mount model.

## What belongs where

| Kind of fact | Examples | Lives in |
|---|---|---|
| Camera motion | achievable rate per speed setting at each zoom (the "speed surface"), slowest/fastest rate, command→motion latency per axis, speed-change settle time, absolute-move speed, whether re-issued absolute moves restart the ramp | `tracker.camera` profile (measured) |
| Camera mechanics | pan/tilt range, tilt at which the firmware auto-flips, encoder units | `tracker.camera` / `tracker.units` / `tracker.limits` |
| Lens | zoom → HFOV table, zoom travel rate, zoom stops, focus behaviour | `tracker.zoom` / `tracker.camera.lens` (measured) |
| Mount | offsets, gains, lean (any angle) | `tracker.mount` (calibrated) |
| Site | location, airport, skyline | `tracker.site`, `limits.horizon` (surveyed) |
| Physics / geometry | head-frame rates, singularities, angular size | code, derived from the above |
| Protocol | VISCA bytes, ONVIF SOAP | driver (`camera/visca.ts`, …) only |

## Control derived from the profile (instead of constants)

- **Feedforward** in head axes through the mount model (`mountRatesFromWorld`) — done 2026-10-14.
- **Zoom vs speed**: at each moment the usable zoom range is the set of zooms
  where (a) the head rates the pass needs are within the profile's top speed
  at that zoom, with margin, and (b) the ripple the slowest speed forces
  (a camera that cannot go slower than its floor must stop/go) is a small
  fraction of the frame. Replaces the hard-coded gear/rate floors.
- **Overhead / singularity**: park-and-fly-through when the head rate the
  pass needs exceeds the profile's top speed at a usable zoom; park tilt from
  the profile's flip limit. Replaces ZENITH_* elevation constants.
- **Braking / latency**: from the measured latency, not literals.
- **Sensor sanity** (e.g. impossible zoom readings): from the lens travel rate.

## Characterization tool

`tracker/scripts/` probes, run with the tracker stopped:
- `onvif-ptz.ts info` — what an ONVIF camera says it supports.
- `probe-onvif-speed.ts` — rate delivered per ONVIF velocity at chosen zooms.
- `probe-speed-zoom.ts` — VISCA speed surface (to fold into one
  `characterize-camera.ts` that writes the profile JSON).

## Migration (one measured change at a time)

1. Profile type + config, seeded with the current camera's measured values;
   driver and loop read it. No behaviour change.
2. Zoom-vs-speed policy from the profile; remove gear/rate floor constants.
3. Park decision from the profile; remove ZENITH_* constants, follow caps,
   FF_SCALE_CROSSING (patches over the pre-2026-10-14 feedforward bug).
4. Re-measure and cut `predict.aimLeadSec` (a patch over the same bug).
5. One `characterize-camera.ts` producing the whole profile.
