import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const playlists = await db.playlist.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          video: {
            select: { id: true, title: true, durationSec: true, thumbnail: true, status: true },
          },
        },
      },
      _count: { select: { items: true } },
    },
  });

  return NextResponse.json({
    playlists: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      loopEnabled: p.loopEnabled,
      createdAt: p.createdAt,
      itemCount: p._count.items,
      totalDurationSec: p.items.reduce((acc, it) => acc + it.video.durationSec, 0),
      items: p.items,
    })),
  });
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    description?: string;
    loopEnabled?: boolean;
  } | null;

  const name = body?.name?.trim() ?? "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: "Playlist name must be 1-80 characters." }, { status: 400 });
  }

  const playlist = await db.playlist.create({
    data: {
      name,
      description: body?.description?.trim() || null,
      loopEnabled: body?.loopEnabled ?? true,
    },
  });
  return NextResponse.json({ playlist }, { status: 201 });
}
