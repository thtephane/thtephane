import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { buildLiveStreamArgs } from "./ffmpeg";

/** ffmpeg child: stdin ignored, stdout/stderr piped (progress + diagnostics) */
type FfmpegProc = ChildProcessByStdio<null, Readable, Readable>;

/**
 * FFmpeg process supervisor for REAL engine mode (one destination = one child).
 *
 * Responsibilities:
 *  - spawn `ffmpeg` per destination and keep it alive (crash detection)
 *  - parse `-progress pipe:1` output into live stats (fps / bitrate / frames / drops)
 *  - keep a bounded stderr tail for diagnostics
 *  - graceful stop: SIGINT → SIGKILL escalation
 *  - safety net: on parent exit, SIGKILL every tracked child so no orphaned
 *    encoders outlive the dashboard server
 *
 * Restart policy and playlist sequencing live in the engine (engine.ts),
 * which reacts to this class' exit callbacks.
 */

export interface StreamStats {
  frames: number;
  fps: number;
  bitrateKbps: number;
  outTimeSec: number;
  droppedFrames: number;
}

export type DestProcStatus = "CONNECTING" | "LIVE" | "RESTARTING" | "ERROR" | "ENDED";

export interface DestProcInfo {
  destinationId: string;
  destinationName: string;
  platform: string;
  status: DestProcStatus;
  pid: number | null;
  startedAt: number | null;
  uptimeSec: number;
  restarts: number;
  exitCode: number | null;
  stats: StreamStats;
  stderrTail: string[];
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  intentional: boolean;
  uptimeMs: number;
}

// ---- global registry so the safety net survives module reloads in dev ----
const g = globalThis as unknown as {
  __tvLiveChildren?: Set<FfmpegProc>;
  __tvSafetyNetInstalled?: boolean;
};
const liveChildren: Set<FfmpegProc> = (g.__tvLiveChildren ??= new Set());

function installSafetyNet(): void {
  if (g.__tvSafetyNetInstalled) return;
  g.__tvSafetyNetInstalled = true;
  process.on("exit", () => {
    for (const child of liveChildren) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* process may already be gone */
      }
    }
    liveChildren.clear();
  });
}

const EMPTY_STATS: StreamStats = {
  frames: 0,
  fps: 0,
  bitrateKbps: 0,
  outTimeSec: 0,
  droppedFrames: 0,
};

export class DestinationStreamer {
  status: DestProcStatus = "CONNECTING";
  stats: StreamStats = { ...EMPTY_STATS };
  stderrTail: string[] = [];
  restarts = 0;
  exitCode: number | null = null;
  proc: FfmpegProc | null = null;
  startedAt: number | null = null;

  private intentional = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly broadcastId: string,
    readonly meta: { destinationId: string; destinationName: string; platform: string; target: string },
    private readonly onExit: (info: ExitInfo) => void,
    private readonly onLive: () => void
  ) {
    installSafetyNet();
  }

  /** Spawn ffmpeg for one input. Previous process must have exited (or was never started). */
  start(inputPath: string, hasAudio: boolean): void {
    this.intentional = false;
    this.exitCode = null;
    this.stats = { ...EMPTY_STATS };
    this.stderrTail = [];
    this.status = "CONNECTING";
    this.startedAt = Date.now();

    const args = buildLiveStreamArgs({
      inputPath,
      rtmpTarget: this.meta.target,
      hasAudio,
      broadcastId: this.broadcastId,
    });
    let proc: FfmpegProc;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      this.status = "ERROR";
      this.stderrTail = [err instanceof Error ? err.message : "spawn failed"];
      // report as a crash so the engine's retry/error logic applies
      this.onExit({ code: null, signal: null, intentional: false, uptimeMs: 0 });
      return;
    }
    this.proc = proc;
    liveChildren.add(proc);

    // machine-readable progress: key=value lines on stdout
    let stdoutBuf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) this.parseProgressLine(line);
      }
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        this.stderrTail.push(t.slice(0, 300));
        if (this.stderrTail.length > 10) this.stderrTail.shift();
      }
    });

    proc.on("error", () => {
      /* spawn failures surface via close; kept for belt-and-braces */
    });

    proc.on("close", (code, signal) => {
      liveChildren.delete(proc);
      this.proc = null;
      this.exitCode = code;
      const uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
      const wasIntentional = this.intentional;
      this.status = "ENDED";
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.onExit({
        code,
        signal,
        intentional: wasIntentional,
        uptimeMs,
      });
    });
  }

  /** Graceful stop of the current process: SIGINT (clean FLV finalization) → SIGKILL. */
  stop(): void {
    this.intentional = true;
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    try {
      proc.kill("SIGINT");
    } catch {
      return;
    }
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.proc === proc && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 4000);
  }

  /** True while a live ffmpeg child exists. */
  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  info(): DestProcInfo {
    return {
      destinationId: this.meta.destinationId,
      destinationName: this.meta.destinationName,
      platform: this.meta.platform,
      status: this.status,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      uptimeSec: this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0,
      restarts: this.restarts,
      exitCode: this.exitCode,
      stats: { ...this.stats },
      stderrTail: [...this.stderrTail],
    };
  }

  private parseProgressLine(line: string): void {
    const eq = line.indexOf("=");
    if (eq < 0) return;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    switch (key) {
      case "frame":
        this.stats.frames = Number(value) || this.stats.frames;
        break;
      case "fps":
        this.stats.fps = Number(value) || 0;
        break;
      case "bitrate": {
        // "  812.3kbits/s"
        const m = value.match(/([\d.]+)kbits/);
        this.stats.bitrateKbps = m ? Number(m[1]) : 0;
        break;
      }
      case "out_time_us":
        this.stats.outTimeSec = Math.max(0, (Number(value) || 0) / 1_000_000);
        break;
      case "out_time":
        // fallback when out_time_us is missing (older ffmpeg): HH:MM:SS.ms
        if (this.stats.outTimeSec === 0 && /^\d+:\d+:\d+\.\d+$/.test(value)) {
          const [h, m, s] = value.split(":").map(Number);
          this.stats.outTimeSec = h * 3600 + m * 60 + s;
        }
        break;
      case "drop_frames":
        this.stats.droppedFrames = Number(value) || 0;
        break;
      case "progress":
        if (this.status === "CONNECTING") {
          this.status = "LIVE";
          this.onLive();
        }
        break;
    }
  }
}
