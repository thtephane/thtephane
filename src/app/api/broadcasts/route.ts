import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { startBroadcast, EngineError } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const broadcasts = await db.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      playlist: { select: { name: true } },
      destinations: true,
      _count: { select: { logs: true } },
    },
  });

  return NextResponse.json({
    broadcasts: broadcasts.map((b) => ({
      id: b.id,
      status: b.status,
      engineMode: b.engineMode,
      speed: b.speed,
      loopCount: b.loopCount,
      startedAt: b.startedAt,
      endedAt: b.endedAt,
      playlistName: b.playlist?.name ?? "(deleted)",
      destinations: b.destinations.map((d) => ({ platform: d.platform, destinationName: d.destinationName, status: d.status })),
    })),
  });
}

/** Start a broadcast: playlist + destinations + mode (SIM demo or real FFmpeg push). */
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    playlistId?: string;
    destinationIds?: string[];
    speed?: number;
    mode?: string;
  } | null;

  const playlistId = body?.playlistId ?? "";
  const destinationIds = Array.isArray(body?.destinationIds) ? body!.destinationIds : [];
  const mode = body?.mode === "FFMPEG" ? "FFMPEG" : "SIM";
  const speed = [1, 60, 300].includes(Number(body?.speed)) ? Number(body?.speed) : 1;

  try {
    const run = await startBroadcast({ playlistId, destinationIds, speed, mode });
    return NextResponse.json(
      { broadcastId: run.broadcastId, status: run.status, mode: run.mode },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof EngineError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[broadcasts/start] unexpected error", err);
    return NextResponse.json({ error: "Unexpected engine error." }, { status: 500 });
  }
}
