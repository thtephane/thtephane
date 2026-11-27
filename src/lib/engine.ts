import { db } from "@/lib/db";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildAccountTarget, ffmpegAvailable, maskRtmp } from "@/lib/ffmpeg";
import { probeMedia, videoInputPath } from "@/lib/probe";
import { DestinationStreamer, type ExitInfo } from "@/lib/streamer";

/**
 * 24/7 Internet TV — Broadcasting Engine
 *
 * Implements the responsibilities from the system design report:
 *  1. Retrieve the selected playlist
 *  2. Load the first video
 *  3. Process/stream the video
 *  4. Send the stream to the selected platforms
 *  5. Detect when the current video finishes
 *  6. Automatically load the next video
 *  7. Repeat the playlist when looping is enabled
 *  8. Handle failures / recovery after server restarts
 *  9. Report broadcasting status to the dashboard
 *
 * Two engine modes share one state machine:
 *  - SIM    — videos advance on timers scaled by a speed factor (1x/60x/300x).
 *             Same records, logs and transitions as real mode; nothing is pushed.
 *  - FFMPEG — REAL streaming: the engine spawns one `ffmpeg` process per
 *             destination (src/lib/streamer.ts) pushing RTMP to the configured
 *             ingest URLs. A segment ends when every destination's ffmpeg has
 *             exited after fully streaming the file; crashes are restarted with
 *             a bounded retry budget, then the destination is marked ERROR and
 *             the broadcast continues on the remaining destinations.
 *
 * It also runs the Scheduling Module: a background tick checks due schedules
 * and starts broadcasts automatically.
 */

const MAX_CRASH_RETRIES = 3;
const CRASH_BACKOFF_MS = 2_500;

export type EngineMode = "SIM" | "FFMPEG";

export interface EngineItem {
  videoId: string;
  title: string;
  durationSec: number;
  /** absolute file path or http(s) URL — ffmpeg input (FFMPEG mode) */
  inputPath: string | null;
}

export interface DestMeta {
  id: string;
  name: string;
  platform: string;
  /** full RTMP target including stream key — server-side only, never serialized */
  target: string;
}

export interface EngineRun {
  broadcastId: string;
  playlistId: string;
  playlistName: string;
  items: EngineItem[];
  index: number;
  status: "LIVE" | "PAUSED";
  mode: EngineMode;
  /** SIM only: playback speed factor */
  speed: number;
  loopEnabled: boolean;
  loopCount: number;
  /** content-time (scaled) milliseconds completed of the current video (SIM) */
  finishedInCurrentMs: number;
  /** wall-clock Date.now() when the current segment started; null while paused (SIM) */
  segmentStartedAt: number | null;
  /** content-time seconds already completed by earlier videos */
  finishedTotalSec: number;
  startedWallAt: number;
  timer: ReturnType<typeof setTimeout> | null;

  // ---- FFMPEG mode state ----
  destinations: DestMeta[];
  streamers: Map<string, DestinationStreamer>;
  /** destination ids still streaming the current segment */
  pending: Set<string>;
  /** consecutive crash count per destination (resets each segment) */
  retries: Map<string, number>;
  /** destinations that have ever confirmed the ingest accepted the push */
  confirmedLive: Set<string>;
  /** guards against double-advance while exit callbacks drain */
  advancing: boolean;
  /** incremented on every stop; stale async callbacks check it */
  generation: number;
  /** incremented per segment start; restart timers must match their epoch */
  segmentEpoch: number;
  restartTimers: Set<ReturnType<typeof setTimeout>>;
  /** probed duration of the current input (progress UI) */
  probeDurationSec: number | null;
  /** probed audio presence of the current input (silence-fill decision) */
  probeHasAudio: boolean;
}

interface EngineState {
  runs: Map<string, EngineRun>;
  schedulerStarted: boolean;
  recovered: boolean;
}

const g = globalThis as unknown as { __tvEngine?: EngineState };
const state: EngineState = (g.__tvEngine ??= {
  runs: new Map(),
  schedulerStarted: false,
  recovered: false,
});

const ENGINE_DIR = path.join(process.cwd(), "db", "engine");

// ---------- logging ----------

export async function logEvent(
  broadcastId: string | null,
  level: "INFO" | "WARN" | "ERROR",
  eventType: string,
  message: string
): Promise<void> {
  try {
    await db.broadcastLog.create({ data: { broadcastId, level, eventType, message } });
  } catch (err) {
    console.error("[engine] failed to write log", err);
  }
}

// ---------- helpers ----------

function hasActiveRun(): boolean {
  for (const run of state.runs.values()) {
    if (run.status === "LIVE" || run.status === "PAUSED") return true;
  }
  return false;
}

export function getActiveRun(): EngineRun | null {
  let latest: EngineRun | null = null;
  for (const run of state.runs.values()) {
    if (!latest || run.startedWallAt > latest.startedWallAt) latest = run;
  }
  return latest;
}

function runAlive(run: EngineRun): boolean {
  const cur = state.runs.get(run.broadcastId);
  return cur === run && cur.generation === run.generation;
}

function currentElapsedMs(run: EngineRun): number {
  if (run.status === "PAUSED" || run.segmentStartedAt === null) return run.finishedInCurrentMs;
  return run.finishedInCurrentMs + (Date.now() - run.segmentStartedAt) * run.speed;
}

/** Live ffmpeg out-time across destinations (FFMPEG mode progress). */
function realElapsedSec(run: EngineRun): number {
  let max = 0;
  for (const st of run.streamers.values()) {
    if (st.stats.outTimeSec > max) max = st.stats.outTimeSec;
  }
  return max;
}

// ---------- pid files (orphan cleanup after server restarts) ----------

async function persistPids(run: EngineRun): Promise<void> {
  if (run.mode !== "FFMPEG") return;
  const pids = [...run.streamers.values()].map((s) => s.proc?.pid).filter((p): p is number => !!p);
  try {
    await mkdir(ENGINE_DIR, { recursive: true });
    await writeFile(path.join(ENGINE_DIR, `${run.broadcastId}.json`), JSON.stringify({ pids }));
  } catch {
    /* best effort */
  }
}

async function clearPidFile(broadcastId: string): Promise<void> {
  await rm(path.join(ENGINE_DIR, `${broadcastId}.json`), { force: true }).catch(() => undefined);
}

/** Kill ffmpeg processes left over from a previous server run (marker-matched). */
async function killOrphanPids(): Promise<void> {
  let files: string[] = [];
  try {
    files = await readdir(ENGINE_DIR);
  } catch {
    return; // no engine dir — nothing to clean
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const filePath = path.join(ENGINE_DIR, f);
    try {
      const data = JSON.parse(await readFile(filePath, "utf-8")) as { pids?: number[] };
      for (const pid of data.pids ?? []) {
        try {
          const cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf-8")).replace(/\0/g, " ");
          // only kill processes we spawned (they carry our marker in argv)
          if (cmdline.includes("24tv:broadcast=")) {
            process.kill(pid, "SIGKILL");
            console.log(`[engine] killed orphaned ffmpeg pid ${pid}`);
          }
        } catch {
          /* pid gone or not ours */
        }
      }
      await rm(filePath, { force: true });
    } catch {
      /* unreadable entry — skip */
    }
  }
}

// ---------- SIM-mode segment machinery ----------

function scheduleSegment(run: EngineRun): void {
  if (run.timer) clearTimeout(run.timer);
  const video = run.items[run.index];
  const durationMs = video.durationSec * 1000;
  const remainingMs = Math.max(0, durationMs - currentElapsedMs(run));
  const wallMs = remainingMs / run.speed;
  run.timer = setTimeout(() => {
    void onSegmentComplete(run);
  }, Math.min(wallMs, 2 ** 31 - 1));
}

// ---------- FFMPEG-mode segment machinery ----------

async function setDestinationStatus(broadcastId: string, destId: string, status: string): Promise<void> {
  await db.broadcastDestination
    .updateMany({ where: { id: destId, broadcastId }, data: { status } })
    .catch(() => undefined);
}

function handleStreamExit(run: EngineRun, destId: string, info: ExitInfo): void {
  // stale callback (run stopped/restarted, or broadcast changed)? ignore.
  if (!runAlive(run) || run.status !== "LIVE") return;
  run.pending.delete(destId);

  if (info.intentional) return; // pause/stop flow handles the rest

  const streamer = run.streamers.get(destId);
  const destMeta = run.destinations.find((d) => d.id === destId);
  const tail = streamer?.stderrTail.slice(-3).join(" | ") ?? "";

  if (info.code !== 0) {
    // crash: exit code != 0 (rejected stream key, network error, undecodable input…)
    const retries = (run.retries.get(destId) ?? 0) + 1;
    run.retries.set(destId, retries);
    const item = run.items[run.index];
    const input = item.inputPath;

    if (retries <= MAX_CRASH_RETRIES && streamer && destMeta && input) {
      streamer.status = "RESTARTING";
      streamer.restarts += 1;
      void logEvent(
        run.broadcastId,
        "WARN",
        "ffmpeg_restart",
        `FFmpeg exited unexpectedly for "${destMeta.name}" (code ${info.code ?? "signal"}) — restarting "${item.title}" (attempt ${retries}/${MAX_CRASH_RETRIES})${tail ? `: ${tail}` : ""}`
      );
      const epoch = run.segmentEpoch;
      const t = setTimeout(() => {
        run.restartTimers.delete(t);
        // re-validate: same segment, still live, nobody else spawned meanwhile
        if (!runAlive(run) || run.status !== "LIVE" || run.segmentEpoch !== epoch) return;
        if (streamer.running) return;
        run.pending.add(destId);
        streamer.start(input, run.probeHasAudio);
        void persistPids(run);
      }, CRASH_BACKOFF_MS);
      run.restartTimers.add(t);
    } else {
      // give up on this destination for the current segment
      if (streamer) streamer.status = "ERROR";
      void setDestinationStatus(run.broadcastId, destId, "ERROR");
      void logEvent(
        run.broadcastId,
        "ERROR",
        "destination_failed",
        `Destination "${destMeta?.name ?? destId}" failed after ${retries} FFmpeg attempts — broadcast continues on remaining destinations${tail ? `: ${tail}` : ""}`
      );
    }
  }

  // clean end (code === 0): this destination finished streaming the whole file.
  // Either way, advance when no destination is streaming anymore.
  maybeAdvance(run);
}

function maybeAdvance(run: EngineRun): void {
  if (!runAlive(run) || run.status !== "LIVE" || run.advancing) return;
  if (run.pending.size === 0) {
    run.advancing = true;
    void onSegmentComplete(run);
  }
}

async function startRealSegment(run: EngineRun): Promise<void> {
  // guard: stop() may have removed the run while earlier awaits were pending
  if (!runAlive(run)) return;
  const video = run.items[run.index];
  if (!video) return;
  if (!video.inputPath) {
    await finalizeBroadcast(
      run,
      "FAILED",
      "engine_failed",
      `Cannot stream "${video.title}": the video has neither an uploaded file nor a direct URL.`
    );
    return;
  }

  run.status = "LIVE";
  run.advancing = false;
  run.segmentEpoch += 1;
  run.retries.clear();
  run.pending.clear();
  await db.broadcast
    .update({
      where: { id: run.broadcastId },
      data: { status: "LIVE", currentVideoId: video.videoId },
    })
    .catch(() => undefined);
  if (!runAlive(run) || run.status !== "LIVE") return;

  await logEvent(
    run.broadcastId,
    "INFO",
    "video_started",
    `Now streaming (video ${run.index + 1}/${run.items.length}): "${video.title}" via FFmpeg`
  );

  // probe the input once: real duration for the progress bar + audio presence
  const probe = await probeMedia(video.inputPath);
  run.probeDurationSec = probe.durationSec;
  run.probeHasAudio = probe.hasAudio;
  if (!runAlive(run) || run.status !== "LIVE") return;

  // (re)activate every destination that is not permanently failed
  for (const dest of run.destinations) {
    const streamer = run.streamers.get(dest.id);
    if (!streamer) continue;
    const wasError = streamer.status === "ERROR";
    streamer.status = "CONNECTING";
    if (wasError) await setDestinationStatus(run.broadcastId, dest.id, "CONNECTING");
    run.pending.add(dest.id);
    streamer.start(video.inputPath, probe.hasAudio);
  }
  await persistPids(run);
  if (!runAlive(run) || run.status !== "LIVE") {
    // stop()/pause() landed while we were spawning — tear everything down
    for (const s of run.streamers.values()) s.stop();
    return;
  }
  maybeAdvance(run); // in case every spawn failed instantly
}

// ---------- segment completion (shared by both modes) ----------

async function onSegmentComplete(run: EngineRun): Promise<void> {
  if (!runAlive(run) || run.status !== "LIVE") {
    if (run.mode === "FFMPEG") run.advancing = false;
    return;
  }
  const video = run.items[run.index];
  if (!video) return;
  run.finishedInCurrentMs = 0;
  // synchronous bookkeeping before any await: a pause/stop landing during the
  // log write below must never replay or skip the finished video
  run.segmentStartedAt = null;
  run.finishedTotalSec += video.durationSec;
  run.index += 1;
  await logEvent(run.broadcastId, "INFO", "video_completed", `Video finished: "${video.title}"`);
  // the run may have been stopped/paused while the log write was in flight —
  // resume() will pick up items[index] (the next video) from here
  if (!runAlive(run) || run.status !== "LIVE") {
    run.advancing = false;
    return;
  }

  if (run.index >= run.items.length) {
    if (run.loopEnabled) {
      run.index = 0;
      run.loopCount += 1;
      await logEvent(
        run.broadcastId,
        "INFO",
        "playlist_looped",
        `Playlist "${run.playlistName}" finished — looping back to first video (loop #${run.loopCount})`
      );
      if (!runAlive(run) || run.status !== "LIVE") {
        run.advancing = false;
        return;
      }
    } else {
      await completeBroadcast(run);
      return;
    }
  }
  if (run.mode === "SIM") {
    await startSegment(run);
  } else {
    run.advancing = false;
    await startRealSegment(run);
  }
}

async function startSegment(run: EngineRun): Promise<void> {
  // guard: stop() may have removed the run while earlier awaits were pending
  if (!runAlive(run)) return;
  const video = run.items[run.index];
  if (!video) return;
  run.status = "LIVE";
  run.segmentStartedAt = Date.now();
  await db.broadcast
    .update({
      where: { id: run.broadcastId },
      data: { status: "LIVE", currentVideoId: video.videoId },
    })
    .catch(() => undefined);
  // if stop() landed during the update above, re-assert the stopped state
  if (!runAlive(run)) {
    await db.broadcast
      .update({
        where: { id: run.broadcastId },
        data: { status: "STOPPED", endedAt: new Date(), currentVideoId: null },
      })
      .catch(() => undefined);
    await db.broadcastDestination
      .updateMany({
        where: { broadcastId: run.broadcastId, status: { in: ["PENDING", "CONNECTING", "LIVE"] } },
        data: { status: "ENDED" },
      })
      .catch(() => undefined);
    return;
  }
  await logEvent(
    run.broadcastId,
    "INFO",
    "video_started",
    `Now playing (video ${run.index + 1}/${run.items.length}): "${video.title}"`
  );
  scheduleSegment(run);
}

async function finalizeBroadcast(
  run: EngineRun,
  status: "STOPPED" | "COMPLETED" | "FAILED",
  eventType: string,
  message: string
): Promise<void> {
  if (run.timer) clearTimeout(run.timer);
  for (const t of run.restartTimers) clearTimeout(t);
  run.restartTimers.clear();
  run.generation += 1;
  if (run.mode === "FFMPEG") {
    for (const s of run.streamers.values()) {
      if (s.running) s.stop();
    }
  }
  state.runs.delete(run.broadcastId);
  await clearPidFile(run.broadcastId);
  await db.broadcast.update({
    where: { id: run.broadcastId },
    data: { status, endedAt: new Date(), currentVideoId: null },
  });
  await db.broadcastDestination.updateMany({
    where: { broadcastId: run.broadcastId },
    data: { status: "ENDED" },
  });
  await logEvent(run.broadcastId, "INFO", eventType, message);
}

async function completeBroadcast(run: EngineRun): Promise<void> {
  await finalizeBroadcast(
    run,
    "COMPLETED",
    "broadcast_completed",
    `Broadcast finished after ${run.loopCount} full loops and ${Math.round(
      run.finishedTotalSec
    )}s of content`
  );
}

// ---------- public control API ----------

export interface StartOptions {
  playlistId: string;
  destinationIds: string[];
  /** SIM only; FFMPEG always streams at real time (1x) */
  speed?: number;
  mode?: EngineMode;
  scheduleId?: string | null;
}

export class EngineError extends Error {}

export async function startBroadcast(opts: StartOptions): Promise<EngineRun> {
  await ensureEngine();

  if (hasActiveRun()) {
    throw new EngineError(
      "A broadcast is already running. Stop it before starting a new one."
    );
  }

  const mode: EngineMode = opts.mode === "FFMPEG" ? "FFMPEG" : "SIM";
  const speed = mode === "FFMPEG" ? 1 : opts.speed ?? 1;

  if (mode === "FFMPEG" && !ffmpegAvailable()) {
    throw new EngineError(
      "FFmpeg is not available on this host. Real streaming needs an always-on machine " +
        "with ffmpeg installed (your PC, a VPS, Railway/Render). On serverless hosts " +
        "like Vercel, use SIM mode here and run the real engine on a dedicated box — " +
        "see DEPLOYMENT.md → Section 4."
    );
  }

  const playlist = await db.playlist.findUnique({
    where: { id: opts.playlistId },
    include: {
      items: { orderBy: { position: "asc" }, include: { video: true } },
    },
  });
  if (!playlist) throw new EngineError("Playlist not found.");
  if (playlist.items.length === 0)
    throw new EngineError("This playlist has no videos yet. Add videos first.");

  const accounts = await db.platformAccount.findMany({
    where: { id: { in: opts.destinationIds }, status: "CONNECTED" },
  });
  if (accounts.length === 0)
    throw new EngineError("Select at least one connected platform account as destination.");

  // FFMPEG mode requires a concrete RTMP target (ingest URL + stream key) per account
  const dests: DestMeta[] = [];
  if (mode === "FFMPEG") {
    for (const acc of accounts) {
      const target = buildAccountTarget(acc);
      if (!target) {
        throw new EngineError(
          `Channel "${acc.accountName}" has no stream key configured — open Channels and add its stream key before real streaming.`
        );
      }
      dests.push({ id: "", name: acc.accountName, platform: acc.platform, target });
    }
  }

  const items: EngineItem[] = playlist.items.map((it) => ({
    videoId: it.video.id,
    title: it.video.title,
    durationSec: it.video.durationSec,
    inputPath: videoInputPath(it.video),
  }));

  const urlOnly = items.filter((i) => i.inputPath && /^https?:\/\//i.test(i.inputPath));
  const missingSource = items.filter((i) => !i.inputPath);

  if (mode === "FFMPEG" && missingSource.length > 0) {
    throw new EngineError(
      `These playlist videos have no file or direct URL to stream: ${missingSource
        .map((i) => `"${i.title}"`)
        .join(", ")}. Re-upload them or import a direct .mp4/HLS link.`
    );
  }

  const broadcast = await db.broadcast.create({
    data: {
      playlistId: playlist.id,
      status: "STARTING",
      engineMode: mode,
      speed,
      scheduleId: opts.scheduleId ?? null,
    },
  });

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    const dest = await db.broadcastDestination.create({
      data: {
        broadcastId: broadcast.id,
        platformAccountId: acc.id,
        platform: acc.platform,
        destinationName: acc.accountName,
        status: mode === "FFMPEG" ? "PENDING" : "LIVE",
        rtmpTarget: mode === "FFMPEG" ? buildAccountTarget(acc) : acc.platform === "YOUTUBE" ? "rtmp://a.rtmp.youtube.com/live2" : "rtmp://push.tiktokcdn.live/live",
      },
    });
    if (mode === "FFMPEG" && dests[i]) dests[i].id = dest.id;
  }

  await logEvent(
    broadcast.id,
    "INFO",
    "engine_started",
    mode === "SIM"
      ? `Broadcasting engine started (SIM mode, ${speed}x) — playlist "${playlist.name}" with ${items.length} videos`
      : `Broadcasting engine started (REAL FFmpeg mode, ${dests.length} destination${dests.length > 1 ? "s" : ""}) — playlist "${playlist.name}" with ${items.length} videos`
  );

  if (mode === "FFMPEG") {
    for (const d of dests) {
      await logEvent(
        broadcast.id,
        "INFO",
        "connect_to_ingest",
        `Will push RTMP to ${d.platform} ingest: ${maskRtmp(d.target)} ("${d.name}")`
      );
    }
    if (urlOnly.length > 0) {
      await logEvent(
        broadcast.id,
        "WARN",
        "url_videos",
        `${urlOnly.length} URL-imported video(s) are read directly by FFmpeg — direct .mp4/.m3u8 links work, platform page links will fail.`
      );
    }
  }

  const run: EngineRun = {
    broadcastId: broadcast.id,
    playlistId: playlist.id,
    playlistName: playlist.name,
    items,
    index: 0,
    status: "LIVE",
    mode,
    speed,
    loopEnabled: playlist.loopEnabled,
    loopCount: 0,
    finishedInCurrentMs: 0,
    segmentStartedAt: mode === "SIM" ? Date.now() : null,
    finishedTotalSec: 0,
    startedWallAt: Date.now(),
    timer: null,
    destinations: dests,
    streamers: new Map(),
    pending: new Set(),
    retries: new Map(),
    confirmedLive: new Set(),
    advancing: false,
    generation: 0,
    segmentEpoch: 0,
    restartTimers: new Set(),
    probeDurationSec: null,
    probeHasAudio: true,
  };
  state.runs.set(broadcast.id, run);

  if (mode === "FFMPEG") {
    for (const d of dests) {
      const streamer = new DestinationStreamer(
        broadcast.id,
        { destinationId: d.id, destinationName: d.name, platform: d.platform, target: d.target },
        (info) => handleStreamExit(run, d.id, info),
        () => {
          if (!runAlive(run)) return;
          setDestinationStatus(run.broadcastId, d.id, "LIVE");
          if (!run.confirmedLive.has(d.id)) {
            run.confirmedLive.add(d.id);
            void logEvent(
              broadcast.id,
              "INFO",
              "ingest_accepted",
              `${d.platform} ingest accepted the push from "${d.name}" — on air`
            );
          }
        }
      );
      run.streamers.set(d.id, streamer);
    }
    await startRealSegment(run);
  } else {
    await startSegment(run);
  }
  return run;
}

export async function pauseBroadcast(broadcastId: string): Promise<void> {
  const run = state.runs.get(broadcastId);
  if (!run) throw new EngineError("This broadcast is not managed by the engine anymore.");
  if (run.status !== "LIVE") throw new EngineError("Broadcast is not live.");

  if (run.mode === "SIM") {
    if (run.timer) clearTimeout(run.timer);
    run.finishedInCurrentMs = currentElapsedMs(run);
    run.segmentStartedAt = null;
    run.status = "PAUSED";
    await db.broadcast.update({ where: { id: broadcastId }, data: { status: "PAUSED" } });
    await logEvent(broadcastId, "INFO", "broadcast_paused", "Broadcast paused by administrator");
    return;
  }

  // REAL mode: there is no "hold" on RTMP — stop pushing, remember position.
  run.generation += 1;
  for (const t of run.restartTimers) clearTimeout(t);
  run.restartTimers.clear();
  for (const s of run.streamers.values()) {
    if (s.running) s.stop();
  }
  run.pending.clear();
  run.status = "PAUSED";
  await db.broadcast.update({
    where: { id: broadcastId },
    data: { status: "PAUSED", currentVideoId: null },
  });
  await db.broadcastDestination
    .updateMany({ where: { broadcastId, status: { in: ["PENDING", "CONNECTING", "LIVE"] } }, data: { status: "ENDED" } })
    .catch(() => undefined);
  await clearPidFile(broadcastId);
  await logEvent(
    broadcastId,
    "INFO",
    "broadcast_paused",
    "Broadcast paused — FFmpeg stopped pushing. Resuming restarts the current video from the beginning (RTMP has no pause)."
  );
}

export async function resumeBroadcast(broadcastId: string): Promise<void> {
  const run = state.runs.get(broadcastId);
  if (!run) throw new EngineError("This broadcast is not managed by the engine anymore.");
  if (run.status !== "PAUSED") throw new EngineError("Broadcast is not paused.");

  run.generation += 1; // invalidate any stragglers from the paused epoch
  if (run.mode === "SIM") {
    run.segmentStartedAt = Date.now();
    run.status = "LIVE";
    await db.broadcast.update({ where: { id: broadcastId }, data: { status: "LIVE" } });
    await logEvent(broadcastId, "INFO", "broadcast_resumed", "Broadcast resumed");
    scheduleSegment(run);
    return;
  }

  run.status = "LIVE";
  await db.broadcast.update({ where: { id: broadcastId }, data: { status: "LIVE" } });
  await logEvent(
    broadcastId,
    "INFO",
    "broadcast_resumed",
    `Broadcast resumed — restarting "${run.items[run.index]?.title ?? "current video"}" from the beginning`
  );
  await startRealSegment(run);
}

export async function stopBroadcast(broadcastId: string): Promise<void> {
  const run = state.runs.get(broadcastId);
  if (!run) {
    // broadcast exists in DB but no engine run (e.g. after restart)
    await db.broadcast.updateMany({
      where: { id: broadcastId, status: { in: ["STARTING", "LIVE", "PAUSED"] } },
      data: { status: "STOPPED", endedAt: new Date() },
    });
    await db.broadcastDestination.updateMany({
      where: { broadcastId, status: { in: ["PENDING", "CONNECTING", "LIVE"] } },
      data: { status: "ENDED" },
    });
    await logEvent(broadcastId, "INFO", "broadcast_stopped", "Broadcast stopped");
    return;
  }
  const uptimeMin = Math.round((Date.now() - run.startedWallAt) / 60000);
  await finalizeBroadcast(
    run,
    "STOPPED",
    "broadcast_stopped",
    `Broadcast stopped by administrator — uptime ${uptimeMin} min${
      run.mode === "FFMPEG" ? ", FFmpeg processes terminated" : ""
    }`
  );
}

// ---------- status for the dashboard ----------

export interface ProcStatus {
  destinationId: string;
  destinationName: string;
  platform: string;
  status: string;
  pid: number | null;
  uptimeSec: number;
  restarts: number;
  fps: number;
  bitrateKbps: number;
  frames: number;
  droppedFrames: number;
  outTimeSec: number;
  stderrTail: string[];
}

export interface RunStatus {
  broadcastId: string;
  status: "LIVE" | "PAUSED";
  mode: EngineMode;
  speed: number;
  loopCount: number;
  playlistId: string;
  playlistName: string;
  startedAt: string;
  uptimeSec: number;
  totalElapsedSec: number;
  index: number;
  total: number;
  current: { videoId: string; title: string; durationSec: number; elapsedSec: number; progress: number } | null;
  next: { title: string } | null;
  destinations: { platform: string; destinationName: string; status: string }[];
  processes: ProcStatus[];
}

export function getRunStatus(): RunStatus | null {
  const run = getActiveRun();
  if (!run) return null;
  const video = run.items[run.index] ?? null;
  const isReal = run.mode === "FFMPEG";
  const shownDuration = (isReal ? run.probeDurationSec : null) ?? video?.durationSec ?? 0;
  const elapsedSec = isReal
    ? run.status === "LIVE"
      ? realElapsedSec(run)
      : 0
    : currentElapsedMs(run) / 1000;
  const nextItem = run.items[run.index + 1] ?? (run.loopEnabled ? run.items[0] : null);
  return {
    broadcastId: run.broadcastId,
    status: run.status,
    mode: run.mode,
    speed: run.speed,
    loopCount: run.loopCount,
    playlistId: run.playlistId,
    playlistName: run.playlistName,
    startedAt: new Date(run.startedWallAt).toISOString(),
    uptimeSec: Math.floor((Date.now() - run.startedWallAt) / 1000),
    totalElapsedSec: Math.floor(run.finishedTotalSec + (isReal ? 0 : elapsedSec)),
    index: run.index,
    total: run.items.length,
    current: video
      ? {
          videoId: video.videoId,
          title: video.title,
          durationSec: shownDuration,
          elapsedSec: Math.min(elapsedSec, shownDuration),
          progress: shownDuration > 0 ? Math.min(1, elapsedSec / shownDuration) : 0,
        }
      : null,
    next: nextItem ? { title: nextItem.title } : null,
    destinations: [],
    processes: isReal
      ? [...run.streamers.values()].map((s) => {
          const i = s.info();
          return {
            destinationId: i.destinationId,
            destinationName: i.destinationName,
            platform: i.platform,
            status: i.status,
            pid: i.pid,
            uptimeSec: i.uptimeSec,
            restarts: i.restarts,
            fps: i.stats.fps,
            bitrateKbps: i.stats.bitrateKbps,
            frames: i.stats.frames,
            droppedFrames: i.stats.droppedFrames,
            outTimeSec: i.stats.outTimeSec,
            stderrTail: i.stderrTail,
          };
        })
      : [],
  };
}

export async function getRunStatusWithDestinations(): Promise<RunStatus | null> {
  const status = getRunStatus();
  if (!status) return null;
  const dests = await db.broadcastDestination.findMany({
    where: { broadcastId: status.broadcastId },
    select: { platform: true, destinationName: true, status: true },
  });
  status.destinations = dests;
  return status;
}

// ---------- recovery & scheduler ----------

/** Called on every engine-related API hit. Recovers orphaned broadcasts once. */
export async function ensureEngine(): Promise<void> {
  if (!state.recovered) {
    state.recovered = true;
    await killOrphanPids();
    const orphaned = await db.broadcast.findMany({
      where: { status: { in: ["STARTING", "LIVE", "PAUSED"] } },
    });
    for (const b of orphaned) {
      await db.broadcast.update({
        where: { id: b.id },
        data: { status: "FAILED", endedAt: new Date(), currentVideoId: null },
      });
      await db.broadcastDestination.updateMany({
        where: { broadcastId: b.id, status: { in: ["PENDING", "CONNECTING", "LIVE"] } },
        data: { status: "ERROR" },
      });
      await logEvent(
        b.id,
        "WARN",
        "engine_recovered",
        "Server restarted while broadcasting — this broadcast was marked FAILED. Start it again to resume."
      );
    }
  }
  startScheduler();
}

function nextOccurrence(now: Date, startAt: Date, recurrence: string): Date | null {
  if (recurrence === "DAILY") {
    const next = new Date(startAt);
    while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next;
  }
  if (recurrence === "WEEKLY") {
    const next = new Date(startAt);
    while (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 7);
    return next;
  }
  return null;
}

/** Background scheduler tick — checks due schedules every 10 seconds. */
export function startScheduler(): void {
  if (state.schedulerStarted) return;
  state.schedulerStarted = true;
  const tick = async () => {
    try {
      const now = new Date();
      const due = await db.schedule.findMany({
        where: {
          enabled: true,
          OR: [{ nextRunAt: { lte: now } }, { nextRunAt: null, startAt: { lte: now } }],
        },
        include: { playlist: true },
      });
      for (const s of due) {
        let destinationIds: string[] = [];
        try {
          destinationIds = JSON.parse(s.destinationsJson) as string[];
        } catch {
          destinationIds = [];
        }
        await logEvent(
          null,
          "INFO",
          "schedule_triggered",
          `Schedule "${s.name}" triggered — starting playlist "${s.playlist?.name ?? "?"}"`
        );
        try {
          await startBroadcast({
            playlistId: s.playlistId,
            destinationIds,
            scheduleId: s.id,
          });
        } catch (err) {
          await logEvent(
            null,
            "ERROR",
            "schedule_failed",
            `Schedule "${s.name}" could not start a broadcast: ${
              err instanceof Error ? err.message : "unknown error"
            }`
          );
        }
        const startAt = s.nextRunAt ?? s.startAt;
        const next = nextOccurrence(new Date(), startAt, s.recurrence);
        await db.schedule.update({
          where: { id: s.id },
          data: { lastRunAt: now, nextRunAt: next, enabled: next ? s.enabled : false },
        });
      }
    } catch (err) {
      console.error("[scheduler] tick error", err);
    }
  };
  setInterval(() => void tick(), 10_000);
}
