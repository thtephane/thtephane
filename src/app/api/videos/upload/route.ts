import { NextResponse } from "next/server";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { probeMedia } from "@/lib/probe";
import { UPLOAD_DIR } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIDEO_EXT_RE = /\.(mp4|mkv|mov|webm|avi|m4v|ts|flv|ogv)$/i;

/** Upload a video file into the library (multipart: file, title, description, durationSec, thumbnail). */
export async function POST(req: Request) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

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
  const title = String(form.get("title") ?? "").trim() || file.name.replace(/\.[^.]+$/, "");

  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
    const ext = (file.name.match(VIDEO_EXT_RE)?.[0] ?? ".mp4").toLowerCase();
    const filename = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}${ext}`;
    const target = path.join(UPLOAD_DIR, filename);
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(target, buf);
    const st = await stat(target);

    // client-side probe first; ffprobe fallback for codecs the browser can't read
    let durationSec = Number(form.get("durationSec") ?? 0);
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      durationSec = (await probeMedia(target)).durationSec ?? 0;
    }

    const video = await db.video.create({
      data: {
        title,
        description: String(form.get("description") ?? "").trim() || null,
        source: "UPLOAD",
        filePath: target,
        mimeType: file.type || "video/mp4",
        fileSize: st.size,
        durationSec: durationSec > 0 ? durationSec : 180,
        thumbnail: (form.get("thumbnail") as string) || null,
        status: "READY",
        uploadedById: userId,
      },
    });

    return NextResponse.json({ video }, { status: 201 });
  } catch (err) {
    console.error("[videos/upload] failed", err);
    return NextResponse.json({ error: "Could not save the uploaded file." }, { status: 500 });
  }
}
