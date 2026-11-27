import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Add a video to a playlist (appends at the end). */
export async function POST(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as { videoId?: string } | null;
  const videoId = body?.videoId ?? "";

  const playlist = await db.playlist.findUnique({ where: { id } });
  if (!playlist) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });

  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  const existing = await db.playlistItem.findUnique({
    where: { playlistId_videoId: { playlistId: id, videoId } },
  });
  if (existing) {
    return NextResponse.json(
      { error: `"${video.title}" is already in this playlist.` },
      { status: 409 }
    );
  }

  const last = await db.playlistItem.findFirst({
    where: { playlistId: id },
    orderBy: { position: "desc" },
  });
  const position = (last?.position ?? -1) + 1;

  const item = await db.playlistItem.create({
    data: { playlistId: id, videoId, position },
    include: {
      video: { select: { id: true, title: true, durationSec: true, thumbnail: true } },
    },
  });

  return NextResponse.json({ item }, { status: 201 });
}
