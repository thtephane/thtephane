import { execFile } from "node:child_process";
import { resolveStoredPath } from "@/lib/paths";

/**
 * ffprobe wrapper for the real engine — resolves the actual duration and
 * whether the input carries an audio track (needed to decide if the engine
 * must inject silent audio, see buildLiveStreamArgs).
 */

export interface ProbeResult {
  durationSec: number | null;
  hasAudio: boolean;
}

/** Resolve a video DB row to an ffmpeg-readable input (absolute path or URL). */
export function videoInputPath(video: { filePath: string | null; url: string | null }): string | null {
  if (video.filePath) return resolveStoredPath(video.filePath);
  if (video.url && /^https?:\/\//i.test(video.url)) return video.url;
  return null;
}

export function probeMedia(input: string, timeoutMs = 15_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_entries",
      "format=duration:stream=codec_type",
      input,
    ];
    const child = execFile(
      "ffprobe",
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ durationSec: null, hasAudio: true }); // assume audio; ffmpeg will still work or the crash path reports
          return;
        }
        try {
          const data = JSON.parse(stdout) as {
            format?: { duration?: string };
            streams?: { codec_type?: string }[];
          };
          const dur = data.format?.duration ? Number(data.format.duration) : null;
          resolve({
            durationSec: dur && Number.isFinite(dur) && dur > 0 ? dur : null,
            hasAudio: (data.streams ?? []).some((s) => s.codec_type === "audio"),
          });
        } catch {
          resolve({ durationSec: null, hasAudio: true });
        }
      }
    );
    child.on("error", () => resolve({ durationSec: null, hasAudio: true }));
  });
}
