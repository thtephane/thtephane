"use client";

/** Small client helpers: JSON API calls + video metadata probing. */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg =
      (body as { error?: string } | null)?.error ??
      `Request failed with status ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const apiGet = <T>(url: string) => request<T>(url);
export const apiPost = <T>(url: string, data?: unknown) =>
  request<T>(url, { method: "POST", body: JSON.stringify(data ?? {}) });
export const apiPatch = <T>(url: string, data?: unknown) =>
  request<T>(url, { method: "PATCH", body: JSON.stringify(data ?? {}) });
export const apiDelete = <T>(url: string) => request<T>(url, { method: "DELETE" });

/** Multipart upload with progress callback (XHR — fetch has no upload progress). */
export function uploadFile<T>(
  url: string,
  form: FormData,
  onProgress?: (pct: number) => void
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = null;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
      } else {
        reject(
          new ApiError(
            (body as { error?: string } | null)?.error ?? `Upload failed (${xhr.status})`,
            xhr.status
          )
        );
      }
    };
    xhr.onerror = () => reject(new ApiError("Network error during upload", 0));
    xhr.send(form);
  });
}

export interface ProbeResult {
  durationSec: number;
  thumbnail: string | null;
}

/**
 * Load a video (File or URL) in a hidden <video>, read its duration and
 * capture a small thumbnail frame via canvas. Never throws.
 */
export function probeVideo(src: File | string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";

    let settled = false;
    const finish = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      video.removeAttribute("src");
      video.load();
      resolve(r);
    };

    const timer = setTimeout(() => finish({ durationSec: 0, thumbnail: null }), 12000);

    const capture = () => {
      try {
        const canvas = document.createElement("canvas");
        const w = 320;
        const ratio = video.videoHeight && video.videoWidth ? video.videoHeight / video.videoWidth : 0.5625;
        canvas.width = w;
        canvas.height = Math.round(w * ratio);
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.6);
      } catch {
        return null;
      }
    };

    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      // try to grab a frame slightly in
      video.currentTime = Math.min(1, duration > 2 ? 1 : 0);
      video.onseeked = () => {
        clearTimeout(timer);
        finish({ durationSec: duration, thumbnail: capture() });
      };
      // some browsers may not fire seeked for currentTime=0
      setTimeout(() => {
        clearTimeout(timer);
        finish({ durationSec: duration, thumbnail: capture() });
      }, 2500);
    };
    video.onerror = () => {
      clearTimeout(timer);
      finish({ durationSec: 0, thumbnail: null });
    };

    video.src = typeof src === "string" ? src : URL.createObjectURL(src);
  });
}

/** "1:23" / "83" → seconds. Returns 0 when unparsable. */
export function parseDuration(input: string): number {
  const t = input.trim();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.max(0, parseFloat(t));
  const parts = t.split(":").map((p) => parseFloat(p));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}
