import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { pauseBroadcast, resumeBroadcast, stopBroadcast, EngineError, ensureEngine } from "@/lib/engine";
import { maskRtmp } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const broadcast = await db.broadcast.findUnique({
    where: { id },
    include: {
      playlist: { select: { id: true, name: true } },
      destinations: true,
      logs: { orderBy: { createdAt: "asc" }, take: 300 },
    },
  });
  if (!broadcast) return NextResponse.json({ error: "Broadcast not found." }, { status: 404 });
  // never expose full RTMP targets — they contain the stream keys
  return NextResponse.json({
    broadcast: {
      ...broadcast,
      destinations: broadcast.destinations.map((d) => ({
        ...d,
        rtmpTarget: d.rtmpTarget ? maskRtmp(d.rtmpTarget) : null,
      })),
    },
  });
}

/** Control: pause | resume | stop */
export async function POST(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  const action = body?.action;

  try {
    await ensureEngine();
    if (action === "pause") await pauseBroadcast(id);
    else if (action === "resume") await resumeBroadcast(id);
    else if (action === "stop") await stopBroadcast(id);
    else return NextResponse.json({ error: "action must be pause, resume or stop." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof EngineError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("[broadcasts/control] unexpected error", err);
    return NextResponse.json({ error: "Unexpected engine error." }, { status: 500 });
  }
}
