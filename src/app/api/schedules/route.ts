import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const schedules = await db.schedule.findMany({
    orderBy: { startAt: "asc" },
    include: { playlist: { select: { name: true } } },
  });

  return NextResponse.json({
    schedules: schedules.map((s) => ({
      id: s.id,
      name: s.name,
      playlistId: s.playlistId,
      playlistName: s.playlist?.name ?? "(deleted)",
      startAt: s.startAt,
      recurrence: s.recurrence,
      weekday: s.weekday,
      enabled: s.enabled,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
      destinationIds: JSON.parse(s.destinationsJson || "[]") as string[],
    })),
  });
}

export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    playlistId?: string;
    startAt?: string;
    recurrence?: string;
    weekday?: number;
    destinationIds?: string[];
  } | null;

  const name = body?.name?.trim() ?? "";
  const playlistId = body?.playlistId ?? "";
  const recurrence = ["NONE", "DAILY", "WEEKLY"].includes(body?.recurrence ?? "")
    ? (body!.recurrence as string)
    : "NONE";
  const startAt = body?.startAt ? new Date(body.startAt) : null;

  if (name.length < 1) {
    return NextResponse.json({ error: "Schedule name is required." }, { status: 400 });
  }
  if (!startAt || Number.isNaN(startAt.getTime())) {
    return NextResponse.json({ error: "A valid start date/time is required." }, { status: 400 });
  }

  const playlist = await db.playlist.findUnique({
    where: { id: playlistId },
    include: { _count: { select: { items: true } } },
  });
  if (!playlist) return NextResponse.json({ error: "Playlist not found." }, { status: 404 });
  if (playlist._count.items === 0) {
    return NextResponse.json(
      { error: "That playlist has no videos yet — add videos first." },
      { status: 400 }
    );
  }

  const schedule = await db.schedule.create({
    data: {
      name,
      playlistId,
      startAt,
      recurrence,
      weekday: recurrence === "WEEKLY" && Number.isInteger(body?.weekday) ? body!.weekday : null,
      destinationsJson: JSON.stringify(Array.isArray(body?.destinationIds) ? body!.destinationIds : []),
      nextRunAt: startAt,
    },
  });

  return NextResponse.json({ schedule }, { status: 201 });
}
