import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const count = await db.user.count();
  const userId = await getSessionUserId();
  if (!userId) {
    return NextResponse.json({ user: null, needsSetup: count === 0 });
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, email: true, createdAt: true },
  });
  if (!user) {
    return NextResponse.json({ user: null, needsSetup: count === 0 });
  }
  return NextResponse.json({ user, needsSetup: count === 0 });
}
