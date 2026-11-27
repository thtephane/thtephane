import { NextResponse } from "next/server";
import { mkdir, writeFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UPLOAD_DIR = process.env.TV_UPLOAD_DIR
  ? path.resolve(process.env.TV_UPLOAD_DIR)
  : process.env.VERCEL === "1"
    ? "/tmp/tv-uploads"
    : path.resolve(process.cwd(), "uploads");
const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|avi|m4v|ts|flv|ogv)$/i;

type Params = { params: Promise<{ id: string }> };

/** Safe replacement: swap the file while keeping the video id (playlists untouched). */
export async function POST(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found." }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid upload request." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file received." }, { status: 400 });
  }
  const nameOk = (file.type && file.type.startsWith("video/")) || VIDEO_EXT_RE.test(file.name);
  if (!nameOk) {
    return NextResponse.json({ error: "Not a supported video file." }, { status: 400 });
  }

  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const ext = (file.name.match(VIDEO_EXT_RE)?.[0] ?? ".mp4").toLowerCase();
    const filename = `${video.id}${ext}`;
    const target = path.join(UPLOAD_DIR, filename);
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(target, buf);
    const st = await stat(target);

    // remove old file if it had a different name
    if (video.filePath && video.filePath !== `uploads/${filename}`) {
      await unlink(path.resolve(process.cwd(), video.filePath)).catch(() => undefined);
    }

    const durationSec = Number(form.get("durationSec") ?? 0);
    const thumbnail = (form.get("thumbnail") as string) || null;
    const updated = await db.video.update({
      where: { id },
      data: {
        filePath: `uploads/${filename}`,
        fileSize: st.size,
        mimeType: file.type || video.mimeType,
        status: "READY",
        ...(Number.isFinite(durationSec) && durationSec > 0 ? { durationSec } : {}),
        ...(thumbnail ? { thumbnail } : {}),
      },
    });
    return NextResponse.json({ video: updated });
  } catch (err) {
    console.error("[replace] failed", err);
    return NextResponse.json({ error: "Failed to replace the video file." }, { status: 500 });
  }
}
