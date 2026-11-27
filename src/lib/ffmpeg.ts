/**
 * FFmpeg command builders for REAL broadcasting.
 *
 * The engine runs in two modes:
 *  - SIM    — the same state machine with simulated time (for demos/tests)
 *  - FFMPEG — real mode: the engine spawns actual `ffmpeg` processes per
 *             destination (see src/lib/streamer.ts + src/lib/engine.ts)
 * These builders generate the exact pipelines both modes describe.
 *
 * Deployment guide: see DEPLOYMENT.md at the project root.
 */

import { spawnSync } from "node:child_process";

/**
 * True when an `ffmpeg` binary is on this host's PATH.
 * Used to refuse REAL mode with a clear message on hosts that cannot stream
 * (e.g. serverless platforms like Vercel) instead of failing after spawn.
 */
export function ffmpegAvailable(): boolean {
  try {
    const res = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5_000 });
    return !res.error && res.status === 0;
  } catch {
    return false;
  }
}

export interface StreamInput {
  filePath: string;
  title: string;
  durationSec: number;
}

/** YouTube Live RTMP ingest endpoint (primary). */
export function youtubeRtmp(streamKey: string): string {
  return `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;
}

/** TikTok LIVE RTMP push endpoint (only available to eligible accounts). */
export function tiktokRtmp(streamKey: string): string {
  return `rtmp://push.tiktokcdn.live/live/${streamKey}`;
}

export function buildRtmpTarget(platform: string, streamKey: string): string {
  return platform === "YOUTUBE" ? youtubeRtmp(streamKey) : tiktokRtmp(streamKey);
}

/** lines for an FFmpeg concat demuxer playlist file */
export function buildConcatPlaylist(inputs: StreamInput[]): string {
  return inputs.map((i) => `file '${i.filePath}'`).join("\n") + "\n";
}

export interface LoopStreamOptions {
  inputs: StreamInput[];
  rtmpTarget: string;
  width?: number;
  height?: number;
  fps?: number;
  videoBitrate?: string;
}

/**
 * Continuous looped stream of a whole playlist to one RTMP target.
 * Uses the concat demuxer with -stream_loop -1 so the playlist repeats forever.
 */
export function buildLoopStreamArgs(opts: LoopStreamOptions): string[] {
  const w = opts.width ?? 1920;
  const h = opts.height ?? 1080;
  const fps = opts.fps ?? 30;
  const vb = opts.videoBitrate ?? "4500k";
  return [
    "-re",
    "-stream_loop",
    "-1",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    "playlist.txt",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,fps=${fps}`,
    "-b:v",
    vb,
    "-maxrate",
    vb,
    "-bufsize",
    "9000k",
    "-g",
    String(fps * 2),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ar",
    "44100",
    "-f",
    "flv",
    opts.rtmpTarget,
  ];
}

export function buildLoopStreamCommand(opts: LoopStreamOptions): string {
  return "ffmpeg " + buildLoopStreamArgs(opts).join(" ");
}

// ==================== REAL ENGINE (FFMPEG mode) ====================

/** Encode profile for the real engine, tunable from the environment. */
export interface StreamProfile {
  width: number;
  height: number;
  fps: number;
  videoBitrate: string;
  audioBitrate: string;
}

export function streamProfile(): StreamProfile {
  return {
    width: Number(process.env.TV_STREAM_WIDTH) || 1280,
    height: Number(process.env.TV_STREAM_HEIGHT) || 720,
    fps: Number(process.env.TV_STREAM_FPS) || 30,
    videoBitrate: process.env.TV_STREAM_VIDEO_BITRATE || "4000k",
    audioBitrate: process.env.TV_STREAM_AUDIO_BITRATE || "128k",
  };
}

/** Default RTMP ingest base per platform (override per account with ingestUrl). */
export function defaultIngestUrl(platform: string): string {
  return platform === "YOUTUBE" ? "rtmp://a.rtmp.youtube.com/live2" : "rtmp://push.tiktokcdn.live/live";
}

/** Full RTMP target for an account: custom ingestUrl wins over the platform default. */
export function buildAccountTarget(acc: { platform: string; ingestUrl?: string | null; streamKey?: string | null }): string | null {
  if (!acc.streamKey) return null;
  const base = (acc.ingestUrl?.trim() || defaultIngestUrl(acc.platform)).replace(/\/+$/, "");
  return `${base}/${acc.streamKey.trim()}`;
}

export interface LiveStreamArgsOptions {
  inputPath: string;
  rtmpTarget: string;
  /** probe result — when the file has no audio we inject silent stereo */
  hasAudio: boolean;
  /** embedded as metadata + visible in /proc cmdline so recovery can find leftovers */
  broadcastId: string;
  profile?: Partial<StreamProfile>;
}

/**
 * ONE real FFmpeg invocation: one video file → one RTMP destination.
 *
 * - `-re`            read the input at native frame rate (live pacing)
 * - `-progress pipe:1` machine-readable progress on stdout (parsed by streamer.ts)
 * - `-metadata comment=24tv:broadcast=<id>` tags the process for orphan cleanup
 * - anullsrc input   guarantees an audio track (platforms reject video-only FLV)
 * - scale+pad        letterbox any input resolution into the output canvas
 */
export function buildLiveStreamArgs(o: LiveStreamArgsOptions): string[] {
  const p = { ...streamProfile(), ...(o.profile ?? {}) };
  const marker = `24tv:broadcast=${o.broadcastId}`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-progress",
    "pipe:1",
    "-re",
    "-i",
    o.inputPath,
  ];
  if (!o.hasAudio) {
    args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  }
  args.push(
    "-map",
    "0:v:0",
    ...(o.hasAudio ? ["-map", "0:a:0"] : ["-map", "1:a:0"]),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-vf",
    `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2,fps=${p.fps}`,
    "-b:v",
    p.videoBitrate,
    "-maxrate",
    p.videoBitrate,
    "-bufsize",
    `${parseInt(p.videoBitrate, 10) * 2}k`,
    "-g",
    String(p.fps * 2),
    "-c:a",
    "aac",
    "-b:a",
    p.audioBitrate,
    "-ar",
    "44100",
    "-ac",
    "2",
    ...(o.hasAudio ? [] : ["-shortest"]),
    "-f",
    "flv",
    "-metadata",
    `comment=${marker}`,
    o.rtmpTarget
  );
  return args;
}

export function buildLiveStreamCommand(o: LiveStreamArgsOptions): string {
  return "ffmpeg " + buildLiveStreamArgs(o).join(" ");
}

/**
 * Sequential supervisor script — mirrors the report's engine design:
 * load first video → stream → when it ends load next → repeat playlist.
 * This gives per-video control (better for switching content mid-broadcast).
 */
export function buildSequentialScript(
  inputs: StreamInput[],
  rtmpTarget: string,
  loop: boolean,
  width = 1920,
  height = 1080
): string {
  const encode =
    `-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p ` +
    `-vf scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2 -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -f flv`;

  const body = inputs
    .map(
      (i) =>
        `echo "[engine] streaming: ${i.title.replace(/"/g, "'")}"\n` +
        `ffmpeg -re -i "${i.filePath}" ${encode} "${rtmpTarget}"\n` +
        `echo "[engine] video finished, loading next..."`
    )
    .join("\n");

  if (!loop) return `#!/usr/bin/env bash\nset -e\n${body}\necho "[engine] playlist finished"\n`;

  return [
    "#!/usr/bin/env bash",
    "set -e",
    `while true; do`,
    body,
    `  echo "[engine] playlist finished - looping back to first video"`,
    `done`,
  ].join("\n");
}

/**
 * Masked preview of a destination target for UI display
 * (never show full stream keys in the dashboard).
 */
export function maskRtmp(target: string): string {
  const idx = target.lastIndexOf("/");
  if (idx < 0) return "***";
  return `${target.slice(0, idx)}/••••••••`;
}
