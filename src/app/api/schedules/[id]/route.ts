import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as {
    name?: string;
    startAt?: string;
    recurrence?: string;
    weekday?: number;
    enabled?: boolean;
    destinationIds?: string[];
  } | null;

  const existing = await db.schedule.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Schedule not found." }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body?.name !== undefined) {
    const n = body.name.trim();
    if (!n) return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
    data.name = n;
  }
  if (body?.startAt !== undefined) {
    const d = new Date(body.startAt);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json({ error: "Invalid start date/time." }, { status: 400 });
    }
    data.startAt = d;
    data.nextRunAt = d;
  }
  if (body?.recurrence !== undefined && ["NONE", "DAILY", "WEEKLY"].includes(body.recurrence)) {
    data.recurrence = body.recurrence;
  }
  if (body?.weekday !== undefined) data.weekday = Number.isInteger(body.weekday) ? body.weekday : null;
  if (body?.enabled !== undefined) data.enabled = body.enabled;
  if (body?.destinationIds !== undefined) {
    data.destinationsJson = JSON.stringify(Array.isArray(body.destinationIds) ? body.destinationIds : []);
  }

  const schedule = await db.schedule.update({ where: { id }, data: data as never });
  return NextResponse.json({ schedule });
}

export async function DELETE(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  await db.schedule.delete({ where: { id } }).catch(() => undefined);
  return NextResponse.json({ ok: true });
}
