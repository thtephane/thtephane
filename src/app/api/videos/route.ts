import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { getRunStatus } from "@/lib/engine";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const videos = await db.video.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      description: true,
      source: true,
      url: true,
      mimeType: true,
      fileSize: true,
      durationSec: true,
      thumbnail: true,
      status: true,
      createdAt: true,
      _count: { select: { playlistItems: true } },
    },
  });

  const run = getRunStatus();
  const activeVideoId = run?.current?.videoId ?? null;

  return NextResponse.json({
    videos: videos.map((v) => ({
      ...v,
      onAir: v.id === activeVideoId,
      rightsSet: false,
    })),
  });
}

/** URL import — add a video by link (mp4/HLS or any playable URL). */
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    title?: string;
    url?: string;
    description?: string;
    durationSec?: number;
    thumbnail?: string;
  } | null;

  const title = body?.title?.trim() ?? "";
  const url = body?.url?.trim() ?? "";
  const durationSec = Number(body?.durationSec ?? 0);

  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json(
      { error: "Please provide a valid http(s) video URL." },
      { status: 400 }
    );
  }
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return NextResponse.json(
      { error: "Duration is required for URL videos (we cannot read remote metadata reliably)." },
      { status: 400 }
    );
  }

  const video = await db.video.create({
    data: {
      title,
      description: body?.description?.trim() || null,
      source: "URL",
      url,
      durationSec,
      thumbnail: body?.thumbnail ?? null,
      status: "READY",
      uploadedById: userId,
    },
  });

  return NextResponse.json({ video }, { status: 201 });
}
