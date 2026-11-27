import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Lightweight auth: scrypt password hashing + HMAC-signed session cookie.
 * No external dependency required. In production set AUTH_SECRET in the env.
 */
const SECRET = process.env.AUTH_SECRET ?? "internet-tv-dev-secret-change-me-in-production";
export const SESSION_COOKIE = "tv_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function sign(data: string): string {
  return createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function createSessionToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + SESSION_TTL_SEC * 1000 })
  ).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      uid?: string;
      exp?: number;
    };
    if (typeof data.uid !== "string" || typeof data.exp !== "number") return null;
    if (Date.now() > data.exp) return null;
    return data.uid;
  } catch {
    return null;
  }
}

export async function getSessionUserId(): Promise<string | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export async function setSessionCookie(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}
