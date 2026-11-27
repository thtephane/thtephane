import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { buildAccountTarget, maskRtmp } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** Update stream settings for real FFmpeg broadcasting (ingest URL + stream key). */
export async function PATCH(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as {
    streamKey?: string | null;
    ingestUrl?: string | null;
  } | null;

  const account = await db.platformAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  const ingestUrl = body?.ingestUrl?.trim() ?? "";
  if (ingestUrl && !/^rtmp(s?):\/\//i.test(ingestUrl)) {
    return NextResponse.json({ error: "Ingest URL must start with rtmp:// or rtmps://." }, { status: 400 });
  }

  const updated = await db.platformAccount.update({
    where: { id },
    data: {
      // undefined keeps the current value; "" clears; otherwise the trimmed key
      streamKey:
        body?.streamKey === undefined ? undefined : body?.streamKey ? String(body.streamKey).trim() || null : null,
      ingestUrl: body?.ingestUrl === undefined ? undefined : ingestUrl || null,
    },
  });

  const target = buildAccountTarget(updated);
  return NextResponse.json({
    account: {
      id: updated.id,
      platform: updated.platform,
      platformAccountId: updated.platformAccountId,
      accountName: updated.accountName,
      tokenRef: updated.tokenRef,
      ingestUrl: updated.ingestUrl,
      hasStreamKey: !!updated.streamKey,
      targetPreview: target ? maskRtmp(target) : null,
      status: updated.status,
      connectedAt: updated.connectedAt,
    },
  });
}

export async function DELETE(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const account = await db.platformAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });

  // destination rows keep the platform/name snapshot (SetNull on the FK)
  await db.platformAccount.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
