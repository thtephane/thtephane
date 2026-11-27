import { NextResponse } from "next/server";
import { unlink } from "node:fs/promises";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { getRunStatus } from "@/lib/engine";
import { resolveStoredPath } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const video = await db.video.findUnique({
    where: { id },
    include: {
      rights: true,
      _count: { select: { playlistItems: true } },
      playlistItems: { include: { playlist: { select: { id: true, name: true } } } },
    },
  });
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  const run = getRunStatus();
  return NextResponse.json({
    video: {
      ...video,
      onAir: run?.current?.videoId === id,
      playlists: video.playlistItems.map((pi) => pi.playlist),
      playlistItems: undefined,
    },
  });
}

export async function PATCH(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as {
    title?: string;
    description?: string | null;
  } | null;

  const data: { title?: string; description?: string | null } = {};
  if (body?.title !== undefined) {
    const t = body.title.trim();
    if (!t) return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
    data.title = t;
  }
  if (body?.description !== undefined) {
    data.description = body.description?.trim() || null;
  }

  const video = await db.video.update({ where: { id }, data });
  return NextResponse.json({ video });
}

/**
 * SAFE DELETE — the behaviour required by the report:
 * warn and block when the video is in a playlist or an active broadcast.
 */
export async function DELETE(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const video = await db.video.findUnique({
    where: { id },
    include: {
      playlistItems: { include: { playlist: { select: { name: true } } } },
    },
  });
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  const run = getRunStatus();
  if (run?.current?.videoId === id) {
    return NextResponse.json(
      {
        error: `This video is ON AIR right now in "${run.playlistName}". Stop the broadcast or let it advance before deleting.`,
        usedInPlaylists: [],
        onAir: true,
      },
      { status: 409 }
    );
  }

  if (video.playlistItems.length > 0) {
    const names = video.playlistItems.map((pi) => pi.playlist.name);
    return NextResponse.json(
      {
        error: `This video is used in ${names.length} playlist(s): ${names.join(", ")}. Remove it from the playlist(s) first to prevent accidental deletion.`,
        usedInPlaylists: names,
        onAir: false,
      },
      { status: 409 }
    );
  }

  if (video.filePath) {
    await unlink(resolveStoredPath(video.filePath)).catch(() => undefined);
  }
  await db.video.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
