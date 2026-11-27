import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import {
  buildConcatPlaylist,
  buildLoopStreamCommand,
  buildSequentialScript,
  buildRtmpTarget,
  buildLiveStreamCommand,
  maskRtmp,
  StreamInput,
} from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";

/**
 * Generates the FFmpeg pipelines for a playlist:
 *  - liveCommand: the EXACT ffmpeg invocation the built-in real engine spawns
 *    for the first video (one process per destination, see src/lib/streamer.ts)
 *  - loopCommand / sequentialScript: standalone recipes for a dedicated
 *    broadcasting server (see DEPLOYMENT.md)
 */
export async function GET(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const playlistId = url.searchParams.get("playlistId") ?? "";
  const streamKey = url.searchParams.get("streamKey") ?? "YOUR-STREAM-KEY";
  const platform = url.searchParams.get("platform") ?? "YOUTUBE";

  const playlist = await db.playlist.findUnique({
    where: { id: playlistId },
    include: {
      items: { orderBy: { position: "asc" }, include: { video: true } },
    },
  });
  if (!playlist) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });

  const inputs: StreamInput[] = playlist.items.map((it) => ({
    title: it.video.title,
    durationSec: it.video.durationSec,
    filePath: it.video.filePath
      ? it.video.filePath // engine inputs are relative to the project dir
      : it.video.url ?? `https://example.com/${it.video.id}.mp4`,
  }));

  const rtmpTarget = buildRtmpTarget(platform, streamKey);
  const first = inputs[0];

  return NextResponse.json({
    rtmpTarget: maskRtmp(rtmpTarget),
    playlistFile: buildConcatPlaylist(inputs),
    // the per-video command the REAL engine mode actually executes
    liveCommand: buildLiveStreamCommand({
      inputPath: first?.filePath ?? "video.mp4",
      rtmpTarget,
      hasAudio: true,
      broadcastId: "<broadcast-id>",
    }),
    loopCommand: buildLoopStreamCommand({ inputs, rtmpTarget }),
    sequentialScript: buildSequentialScript(inputs, rtmpTarget, playlist.loopEnabled),
    warnings: [
      ...(inputs.some((i) => i.filePath.startsWith("http"))
        ? ["URL-imported videos are streamed directly by FFmpeg — use direct .mp4/HLS links (platform page links will fail)."]
        : []),
      ...(platform === "TIKTOK"
        ? ["TikTok LIVE access is not guaranteed — it depends on account eligibility and regional availability."]
        : []),
    ],
  });
}
