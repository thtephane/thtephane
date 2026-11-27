import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { ensureEngine, getRunStatusWithDestinations } from "@/lib/engine";

export const dynamic = "force-dynamic";

/** Live status for the dashboard monitor + top bar pill. */
export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  await ensureEngine();
  const active = await getRunStatusWithDestinations();
  let logs: unknown[] = [];
  if (active) {
    logs = await db.broadcastLog.findMany({
      where: { broadcastId: active.broadcastId },
      orderBy: { createdAt: "desc" },
      take: 30,
    });
  }
  return NextResponse.json({ active, logs });
}
