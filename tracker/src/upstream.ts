// Upstream feed: connects to the existing display server's WebSocket as a
// plain client and maintains the live aircraft picture + shared config. In
// replay mode (TRACKER_REPLAY=<session.jsonl>) the same interface is fed from
// a recorded session instead, for deterministic offline debugging.

import { readFileSync } from "node:fs";
import WebSocket from "ws";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  type Aircraft,
  type ClientMessage,
  type Config,
  type ServerMessage,
} from "@shared/index.js";

/**
 * Positions carried across polls. readsb now and then sends an aircraft with
 * no position for one poll (2026-10-15 00:18Z: a departure at 125 ft, the
 * surface→airborne switch); everything downstream skipped it as if it had
 * vanished — the departure lost its priority for 0.5 s and the camera
 * switched target and back. A missing position is not a missing aircraft:
 * the last fix, with its true age, is still the best estimate, and the
 * position-staleness limits (fixAgeSec) decide when it is too old.
 */
export class PositionCarry {
  private last = new Map<string, { lat: number; lon: number; fixAt: number }>();

  /** Fill missing positions in this snapshot from the previous fixes (in place). */
  apply(aircraft: Aircraft[], now: number): Aircraft[] {
    const seen = new Set<string>();
    for (const ac of aircraft) {
      seen.add(ac.hex);
      const ts = ac.ts ?? now;
      if (ac.lat != null && ac.lon != null) {
        this.last.set(ac.hex, { lat: ac.lat, lon: ac.lon, fixAt: ts - 1000 * (ac.seenPos ?? ac.seen ?? 0) });
        continue;
      }
      const prev = this.last.get(ac.hex);
      if (!prev) continue;
      ac.lat = prev.lat;
      ac.lon = prev.lon;
      ac.seenPos = Math.max(0, (ts - prev.fixAt) / 1000);
    }
    for (const hex of this.last.keys()) if (!seen.has(hex)) this.last.delete(hex);
    return aircraft;
  }
}

export interface UpstreamEvents {
  onSnapshot?: (now: number, aircraft: Aircraft[]) => void;
  onConfig?: (config: Config) => void;
}

export interface Upstream {
  start(): void;
  stop(): void;
  isConnected(): boolean;
  getConfig(): Config;
  getAircraft(): Aircraft[];
  find(hex: string): Aircraft | undefined;
  /** Patch the shared config on the server (persisted there). */
  patchConfig(patch: Partial<Config>): void;
}

export class WsUpstream implements Upstream {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private config: Config = DEFAULT_CONFIG;
  private aircraft = new Map<string, Aircraft>();
  private carry = new PositionCarry();

  constructor(
    private url: string,
    private events: UpstreamEvents = {},
  ) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  isConnected(): boolean {
    return this.connected;
  }
  getConfig(): Config {
    return this.config;
  }
  getAircraft(): Aircraft[] {
    return [...this.aircraft.values()];
  }
  find(hex: string): Aircraft | undefined {
    return this.aircraft.get(hex);
  }

  patchConfig(patch: Partial<Config>): void {
    const msg: ClientMessage = { type: "patchConfig", patch };
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
    // Optimistic local merge so the tracker reacts immediately.
    this.config = mergeConfig(this.config, patch);
    this.events.onConfig?.(this.config);
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.connected = true;
      ws.send(JSON.stringify({ type: "hello", role: "control" } satisfies ClientMessage));
    });
    ws.on("close", () => {
      this.connected = false;
      this.scheduleReconnect();
    });
    ws.on("error", () => ws.close());
    ws.on("message", (raw) => this.onMessage(raw.toString()));
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.open();
    }, 1500);
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "config") {
      this.config = mergeConfig(DEFAULT_CONFIG, msg.config);
      this.events.onConfig?.(this.config);
    } else if (msg.type === "aircraft") {
      this.aircraft.clear();
      for (const ac of msg.aircraft) if (ac.ts == null) ac.ts = msg.now;
      this.carry.apply(msg.aircraft, msg.now);
      for (const ac of msg.aircraft) this.aircraft.set(ac.hex, ac);
      this.events.onSnapshot?.(msg.now, msg.aircraft);
    }
  }
}

/**
 * Replays the `snapshot` lines of a recorded JSONL session with original
 * relative timing, shifted to the present so staleness math behaves.
 */
export class ReplayUpstream implements Upstream {
  private aircraft = new Map<string, Aircraft>();
  private carry = new PositionCarry();
  private config: Config = DEFAULT_CONFIG;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private running = false;

  constructor(
    private file: string,
    private events: UpstreamEvents = {},
    private speed = 1,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    const snaps: { t: number; aircraft: Aircraft[] }[] = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.kind === "snapshot") snaps.push({ t: rec.t, aircraft: rec.aircraft });
      } catch {
        // tolerate partial lines from crashed sessions
      }
    }
    if (!snaps.length) {
      console.error(`[replay] no snapshots in ${this.file}`);
      return;
    }
    console.log(`[replay] ${snaps.length} snapshots from ${this.file}`);
    const t0 = snaps[0].t;
    const wall0 = Date.now();
    for (const snap of snaps) {
      const delay = (snap.t - t0) / this.speed;
      this.timers.push(
        setTimeout(() => {
          const now = Date.now();
          const shift = now - snap.t; // re-stamp into the present
          this.aircraft.clear();
          const shifted = snap.aircraft.map((ac) => ({
            ...ac,
            ts: (ac.ts ?? snap.t) + shift,
          }));
          this.carry.apply(shifted, now);
          for (const ac of shifted) this.aircraft.set(ac.hex, ac);
          this.events.onSnapshot?.(wall0 + delay * this.speed, shifted);
        }, delay),
      );
    }
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.running = false;
  }

  isConnected(): boolean {
    return this.running;
  }
  getConfig(): Config {
    return this.config;
  }
  getAircraft(): Aircraft[] {
    return [...this.aircraft.values()];
  }
  find(hex: string): Aircraft | undefined {
    return this.aircraft.get(hex);
  }
  patchConfig(patch: Partial<Config>): void {
    this.config = mergeConfig(this.config, patch);
    this.events.onConfig?.(this.config);
  }
}
