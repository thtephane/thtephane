import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Filterable logs feed for the Reports view. */
export async function GET(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const url = new URL(req.url);
  const level = url.searchParams.get("level") ?? "";
  const broadcastId = url.searchParams.get("broadcastId") ?? "";
  const take = Math.min(500, Math.max(1, Number(url.searchParams.get("take") ?? 150)));

  const logs = await db.broadcastLog.findMany({
    where: {
      ...(level && ["INFO", "WARN", "ERROR"].includes(level) ? { level } : {}),
      ...(broadcastId ? { broadcastId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: { broadcast: { select: { playlist: { select: { name: true } } } } },
  });

  return NextResponse.json({
    logs: logs.map((l) => ({
      id: l.id,
      broadcastId: l.broadcastId,
      level: l.level,
      eventType: l.eventType,
      message: l.message,
      createdAt: l.createdAt,
      playlistName: l.broadcast?.playlist?.name ?? null,
    })),
  });
}
