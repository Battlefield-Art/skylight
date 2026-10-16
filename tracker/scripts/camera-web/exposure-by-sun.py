#!/usr/bin/env python3
"""Exposure compensation by sun elevation (TONGVEO web API, see camweb.py).

The camera meters the whole sky, so a sunlit plane clips to white: at neutral, 2026-10-16 afternoon
posters had a median 25% of the plane clipped; at -4 steps, 0.1%. In dim light the same offset would
starve the picture and the vision, so the offset eases back to neutral as the sun goes down.

  exposure-by-sun.py [--dry-run]      run every few minutes (systemd timer); sets ExpComp only on change

Site from the tracker config (GET $SKYLIGHT_CONFIG_URL, default http://localhost:3000/api/config).
STEPS: (minimum sun elevation deg, ExpComp RAW 0..14, 7 = 0 EV) — first row the sun is above wins.
"""
import json, math, os, sys, time, urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import camweb  # noqa: E402

STEPS = [(20.0, 3), (10.0, 5), (-90.0, 7)]  # high sun -4, low sun -2, dusk/night neutral
CONFIG_URL = os.environ.get("SKYLIGHT_CONFIG_URL", "http://localhost:3000/api/config")


def sun_elevation(lat, lon, when):
    """Solar elevation, deg (NOAA approximation, ~0.5° — plenty for exposure steps)."""
    d = (when - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0
    g = math.radians((357.529 + 0.98560028 * d) % 360)
    q = (280.459 + 0.98564736 * d) % 360
    lam = math.radians(q + 1.915 * math.sin(g) + 0.020 * math.sin(2 * g))
    eps = math.radians(23.439 - 0.00000036 * d)
    ra = math.atan2(math.cos(eps) * math.sin(lam), math.cos(lam))
    dec = math.asin(math.sin(eps) * math.sin(lam))
    gmst = (18.697374558 + 24.06570982441908 * d) % 24
    ha = math.radians(gmst * 15 + lon) - ra
    la = math.radians(lat)
    return math.degrees(math.asin(math.sin(la) * math.sin(dec) + math.cos(la) * math.cos(dec) * math.cos(ha)))


def main(argv):
    site = json.load(urllib.request.urlopen(CONFIG_URL, timeout=10))["tracker"]["site"]
    el = sun_elevation(site["lat"], site["lon"], datetime.now(timezone.utc))
    want = next(raw for min_el, raw in STEPS if el >= min_el)
    sid = camweb.login()
    have = int(camweb.call("AjaxGetCfgVImg", {"Channel": 0, "ID": sid})["AE"]["ExpComp"])
    print(f"{time.strftime('%H:%M:%S')} sun {el:.1f}° ExpComp {have} -> {want}" + ("" if have != want else " (unchanged)"))
    if have != want and "--dry-run" not in argv:
        camweb.call("AjaxSetCfgVImg", {"saveAllChannel": 0, "setChannel": 0, "cmd": "ExpComp",
                                        "param": str(want), "profile": 0, "ID": sid})


if __name__ == "__main__":
    main(sys.argv[1:])
