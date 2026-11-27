import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const PERMISSION_TYPES = ["OWNED", "LICENSED", "CREATIVE_COMMONS", "OTHER"];

export async function GET(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  const rights = await db.videoRights.findUnique({ where: { videoId: id } });
  return NextResponse.json({ rights });
}

/** Upsert the VIDEO_RIGHTS record (authorization tracking from the report). */
export async function PUT(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  const body = (await req.json().catch(() => null)) as {
    contentOwner?: string;
    permissionType?: string;
    permittedPlatforms?: string;
    commercialUseAllowed?: boolean;
    permissionExpiry?: string | null;
    proofUrl?: string;
    notes?: string;
  } | null;

  const permissionType =
    body?.permissionType && PERMISSION_TYPES.includes(body.permissionType)
      ? body.permissionType
      : null;

  const data = {
    contentOwner: body?.contentOwner?.trim() || null,
    permissionType,
    permittedPlatforms: body?.permittedPlatforms?.trim() || null,
    commercialUseAllowed: Boolean(body?.commercialUseAllowed),
    permissionExpiry: body?.permissionExpiry ? new Date(body.permissionExpiry) : null,
    proofUrl: body?.proofUrl?.trim() || null,
    notes: body?.notes?.trim() || null,
  };

  const rights = await db.videoRights.upsert({
    where: { videoId: id },
    update: data,
    create: { videoId: id, ...data },
  });

  return NextResponse.json({ rights });
}
