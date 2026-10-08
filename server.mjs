// Snapzo render server — run on your own VPS (needs yt-dlp + ffmpeg; see Dockerfile).
// Env: SECRET (same value as RENDER_SERVER_SECRET in the app), PORT (default 8787).
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = process.env.SECRET;
const PORT = Number(process.env.PORT || 8787);
if (!SECRET) throw new Error("SECRET env var is required");

// Hard limits so one stalled download can never freeze the whole machine.
const DOWNLOAD_MS = 420000; // 7 min for grabbing the section from YouTube
const RENDER_MS = 300000; // 5 min for cropping + captioning

const run = (cmd, args, timeoutMs) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], timeout: timeoutMs });
    let err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    p.on("close", (c) => {
      if (c === 0) return res();
      const last = err.split("\n").filter(Boolean).pop();
      rej(new Error(c === null ? `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s` : `${cmd} failed: ${last ?? c}`));
    });
  });

const esc = (t) => t.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%");

async function render(job) {
  const dir = await mkdtemp(join(tmpdir(), "snapzo-"));
  try {
    const src = join(dir, "src.mp4");
    const out = join(dir, "out.mp4");
    const start = Math.max(0, Number(job.start));
    const end = Math.max(start + 1, Number(job.end));
    await run(
      "yt-dlp",
      [
        "--no-playlist",
        "--socket-timeout", "20",
        "--retries", "3",
        "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
        "--download-sections", `*${start}-${end}`,
        "--force-keyframes-at-cuts",
        "--merge-output-format", "mp4",
        "-o", src,
        job.sourceUrl,
      ],
      DOWNLOAD_MS,
    );
    const [W, H] = job.vertical ? [1080, 1920] : [1920, 1080];
    let vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
    if (job.caption) {
      await writeFile(join(dir, "cap.txt"), String(job.caption).toUpperCase());
      vf += `,drawtext=textfile='${esc(join(dir, "cap.txt"))}':fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:fontsize=${Math.round(W * 0.065)}:fontcolor=white:borderw=8:bordercolor=black:x=(w-text_w)/2:y=h*${Number(job.captionY) / 100}`;
    }
    await run(
      "ffmpeg",
      ["-y", "-i", src, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out],
      RENDER_MS,
    );
    const up = await fetch(job.uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: await readFile(out) });
    if (!up.ok) throw new Error(`Upload failed (${up.status})`);
    await callback(job, { ok: true });
  } catch (e) {
    await callback(job, { ok: false, error: String(e.message || e).slice(0, 480) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const callback = (job, r) =>
  fetch(job.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ clipId: job.clipId, exportPath: job.exportPath, ...r }),
  }).catch(() => {});

// Simple queue: render one video at a time
const queue = [];
let current = null;
let busy = false;
const next = async () => {
  if (busy || !queue.length) return;
  busy = true;
  current = queue.shift();
  current.startedAt = Date.now();
  try {
    await render(current);
  } finally {
    current = null;
    busy = false;
    next();
  }
};

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") return res.end("ok");
    if (req.method === "GET" && req.url === "/jobs") {
      return res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          busy,
          queued: queue.length,
          making: current ? { clipId: current.clipId, seconds: Math.round((Date.now() - current.startedAt) / 1000) } : null,
        }),
      );
    }
    if (req.method !== "POST" || req.url !== "/render") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${SECRET}`) return res.writeHead(401).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const job = JSON.parse(body);
        if (!/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(job.sourceUrl)) throw new Error("Only YouTube links");
        queue.push(job);
        next();
        res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify({ queued: queue.length }));
      } catch (e) {
        res.writeHead(400).end(String(e.message));
      }
    });
  })
  .listen(PORT, () => console.log(`Snapzo render server on :${PORT}`));
