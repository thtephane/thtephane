import { NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { getSessionUserId } from "@/lib/auth";
import { resolveStoredPath } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Streams an uploaded video with HTTP Range support so <video> seeking works. */
export async function GET(req: Request, { params }: Params) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;

  const video = await db.video.findUnique({ where: { id } });
  if (!video || video.source !== "UPLOAD" || !video.filePath) {
    return NextResponse.json({ error: "Video file not found." }, { status: 404 });
  }

  const filePath = resolveStoredPath(video.filePath);
  const st = await stat(filePath).catch(() => null);
  if (!st || !st.isFile()) {
    return NextResponse.json({ error: "File is missing on disk." }, { status: 404 });
  }

  const contentType = video.mimeType?.startsWith("video/") ? video.mimeType : "video/mp4";
  const range = req.headers.get("range");

  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        return new NextResponse(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${st.size}` },
        });
      }
      const stream = createReadStream(filePath, { start, end });
      return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${st.size}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        },
      });
    }
  }

  const stream = createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(st.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
