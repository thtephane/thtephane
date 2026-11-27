import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string; id: string }> };

/** Remove a video from a playlist, then re-index the remaining positions. */
export async function DELETE(_req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { itemId, id } = await params;

  const item = await db.playlistItem.findUnique({ where: { id: itemId } });
  if (!item || item.playlistId !== id) {
    return NextResponse.json({ error: "Item not found in this playlist." }, { status: 404 });
  }

  await db.playlistItem.delete({ where: { id: itemId } });

  const remaining = await db.playlistItem.findMany({
    where: { playlistId: id },
    orderBy: { position: "asc" },
  });
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].position !== i) {
      await db.playlistItem.update({ where: { id: remaining[i].id }, data: { position: i } });
    }
  }

  return NextResponse.json({ ok: true });
}

/** Move an item up/down in the playback order. */
export async function PATCH(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { itemId, id } = await params;

  const body = (await req.json().catch(() => null)) as { direction?: "up" | "down" } | null;
  const direction = body?.direction;
  if (direction !== "up" && direction !== "down") {
    return NextResponse.json({ error: "direction must be 'up' or 'down'." }, { status: 400 });
  }

  const items = await db.playlistItem.findMany({
    where: { playlistId: id },
    orderBy: { position: "asc" },
  });
  const idx = items.findIndex((it) => it.id === itemId);
  if (idx < 0) return NextResponse.json({ error: "Item not found." }, { status: 404 });

  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= items.length) {
    return NextResponse.json({ ok: true, moved: false });
  }

  const a = items[idx];
  const b = items[swapIdx];
  await db.playlistItem.update({ where: { id: a.id }, data: { position: b.position } });
  await db.playlistItem.update({ where: { id: b.id }, data: { position: a.position } });

  return NextResponse.json({ ok: true, moved: true });
}
