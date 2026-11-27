import path from "node:path";

/**
 * Directory for uploaded video files.
 *
 * Serverless hosts (Vercel) have a read-only filesystem except /tmp, and /tmp
 * is ephemeral — prefer URL-imported videos there. Locally the default keeps
 * files in ./uploads next to the project. Override with TV_UPLOAD_DIR.
 */
export const UPLOAD_DIR = process.env.TV_UPLOAD_DIR
  ? path.resolve(process.env.TV_UPLOAD_DIR)
  : process.env.VERCEL === "1"
    ? "/tmp/tv-uploads"
    : path.resolve("uploads");

/** Resolve a stored file path (relative "uploads/x.mp4" or absolute) against cwd. */
export function resolveStoredPath(p: string): string {
  return path.resolve(process.cwd(), p);
}
