import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { hashPassword, setSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** First-run setup: creates THE administrator account. Blocked afterwards. */
export async function POST(req: Request) {
  const count = await db.user.count();
  if (count > 0) {
    return NextResponse.json(
      { error: "Setup is already completed. Please log in." },
      { status: 403 }
    );
  }

  const body = (await req.json().catch(() => null)) as {
    username?: string;
    email?: string;
    password?: string;
  } | null;

  const username = body?.username?.trim() ?? "";
  const email = body?.email?.trim().toLowerCase() ?? "";
  const password = body?.password ?? "";

  if (username.length < 3 || username.length > 40) {
    return NextResponse.json({ error: "Username must be 3-40 characters." }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters." },
      { status: 400 }
    );
  }

  const user = await db.user.create({
    data: {
      username,
      email,
      passwordHash: hashPassword(password),
      role: "ADMIN",
    },
    select: { id: true, username: true, email: true, createdAt: true },
  });

  await setSessionCookie(user.id);
  return NextResponse.json({ user });
}
