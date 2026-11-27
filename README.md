# 24/7 Internet TV — automated social-media live studio

A self-hosted dashboard that turns a folder of videos into a continuous channel:
upload or import videos, build playlists, connect your YouTube / TikTok live
accounts, and the broadcasting engine plays the playlist on loop — automatically
advancing to the next video, 24/7.

## Features

- **Studio dashboard** — dark "streaming-control-room" UI: library, playlists,
  channels, broadcast control, scheduler, reports.
- **Video library** — file upload (≤200 MB) or direct URL import (.mp4/.m3u8),
  durations, thumbnails, content-rights records, safe delete.
- **Playlists** — ordered items, move up/down, loop toggle, total duration.
- **Channels** — YouTube/TikTok accounts with RTMP ingest URL + stream key
  (stored server-side, always masked in API responses).
- **Broadcasting engine, two modes**
  - **SIM** — the full state machine on simulated time (1x / 60x / 300x) for
    demos and testing: auto-advance, looping, pause/resume/stop, logs,
    recovery after restarts.
  - **FFMPEG (real)** — spawns one supervised `ffmpeg` process per destination,
    pushes RTMP to the platform ingest URLs, live fps/bitrate stats, bounded
    crash retries, orphan cleanup after server restarts.
- **Scheduler** — one-time / daily / weekly auto-start of a playlist.
- **Reports** — broadcast history, durations, failures, filterable log explorer.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · shadcn/ui · Prisma
(SQLite locally, Postgres in production) · FFmpeg.

## Run locally

```bash
bun install
bunx prisma db push          # creates db/custom.db
bun dev                      # http://localhost:3000
```

First visit shows the admin setup screen — create your account and you are in.
Copy `.env.example` to `.env` if you want to change defaults (auth secret,
stream canvas/bitrate, upload dir).

## Deploy

- **Vercel** — import the repo, add `DATABASE_URL` (Postgres: Supabase/Neon),
  `DIRECT_URL` and `AUTH_SECRET`; the build creates the tables automatically.
  See [DEPLOYMENT.md](./DEPLOYMENT.md) → Section 3.
- **Real 24/7 streaming** — serverless hosts cannot run `ffmpeg` forever; run
  the same repo on a VPS / Railway / your PC for the real engine.
  [DEPLOYMENT.md](./DEPLOYMENT.md) → Section 4.

## Testing real streaming without going live

A local MediaMTX relay ships in `scripts/relay/` — point a channel's ingest URL
at `rtmp://127.0.0.1:1935/live` and watch the push without touching YouTube/TikTok.

## Content rules

Only broadcast content you own or have licensed for livestreaming on the target
platforms. Permission to upload ≠ permission to livestream. Track rights in
Video Library → Content rights.
