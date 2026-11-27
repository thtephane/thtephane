import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { buildAccountTarget, maskRtmp } from "@/lib/ffmpeg";

export const dynamic = "force-dynamic";

/** Serialize an account for the client — the stream key itself never leaves the server. */
function publicAccount(acc: {
  id: string;
  platform: string;
  platformAccountId: string;
  accountName: string;
  tokenRef: string | null;
  ingestUrl: string | null;
  streamKey: string | null;
  status: string;
  connectedAt: Date;
}) {
  const target = buildAccountTarget(acc);
  return {
    id: acc.id,
    platform: acc.platform,
    platformAccountId: acc.platformAccountId,
    accountName: acc.accountName,
    tokenRef: acc.tokenRef,
    ingestUrl: acc.ingestUrl,
    hasStreamKey: !!acc.streamKey,
    // masked preview of the full push target, e.g. rtmp://a.rtmp.youtube.com/live2/••••••••
    targetPreview: target ? maskRtmp(target) : null,
    status: acc.status,
    connectedAt: acc.connectedAt,
  };
}

export async function GET() {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const accounts = await db.platformAccount.findMany({ orderBy: { connectedAt: "desc" } });
  return NextResponse.json({ accounts: accounts.map(publicAccount) });
}

/**
 * Connect a channel. For REAL FFmpeg streaming also store the RTMP ingest
 * URL (optional — platform defaults are used otherwise) and the stream key.
 * The key is kept server-side only; API responses expose just a masked target.
 */
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    platform?: string;
    accountName?: string;
    platformAccountId?: string;
    streamKey?: string;
    ingestUrl?: string;
  } | null;

  const platform = body?.platform ?? "";
  const accountName = body?.accountName?.trim() ?? "";
  if (platform !== "YOUTUBE" && platform !== "TIKTOK") {
    return NextResponse.json({ error: "Platform must be YOUTUBE or TIKTOK." }, { status: 400 });
  }
  if (accountName.length < 1) {
    return NextResponse.json({ error: "Account name is required." }, { status: 400 });
  }
  const ingestUrl = body?.ingestUrl?.trim() ?? "";
  if (ingestUrl && !/^rtmp(s?):\/\//i.test(ingestUrl)) {
    return NextResponse.json({ error: "Ingest URL must start with rtmp:// or rtmps://." }, { status: 400 });
  }

  const account = await db.platformAccount.create({
    data: {
      platform,
      accountName,
      platformAccountId: body?.platformAccountId?.trim() || "pending-oauth",
      tokenRef: `vault://${platform.toLowerCase()}/${randomBytes(8).toString("hex")}`,
      ingestUrl: ingestUrl || null,
      streamKey: body?.streamKey?.trim() || null,
      status: "CONNECTED",
    },
  });

  return NextResponse.json({ account: publicAccount(account) }, { status: 201 });
}
