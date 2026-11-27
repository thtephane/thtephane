import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { ensureEngine, getRunStatusWithDestinations } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** Aggregates for the dashboard. */
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  await ensureEngine();

  const [videoCount, playlistCount, channelCount, broadcastCount] = await Promise.all([
    db.video.count(),
    db.playlist.count(),
    db.platformAccount.count(),
    db.broadcast.count(),
  ]);

  const [completed, failed] = await Promise.all([
    db.broadcast.count({ where: { status: "COMPLETED" } }),
    db.broadcast.count({ where: { status: { in: ["FAILED", "STOPPED"] } } }),
  ]);

  const finished = await db.broadcast.findMany({
    where: { status: { in: ["COMPLETED", "STOPPED", "FAILED"] }, endedAt: { not: null } },
    select: { startedAt: true, endedAt: true },
  });
  const totalAirtimeSec = finished.reduce(
    (acc, b) => acc + Math.max(0, (b.endedAt!.getTime() - b.startedAt.getTime()) / 1000),
    0
  );

  const recentBroadcasts = await db.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 5,
    include: { playlist: { select: { name: true } } },
  });

  const recentLogs = await db.broadcastLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  const active = await getRunStatusWithDestinations();

  return NextResponse.json({
    counts: { videos: videoCount, playlists: playlistCount, channels: channelCount, broadcasts: broadcastCount, completed, failed, totalAirtimeSec },
    recentBroadcasts: recentBroadcasts.map((b) => ({
      id: b.id,
      status: b.status,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      playlistName: b.playlist?.name ?? "(deleted)",
    })),
    recentLogs,
    active,
  });
}
