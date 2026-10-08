// Snapzo render server — turns a YouTube link + start/end into a clean 9:16 MP4 and uploads it to Snapzo.
// Start with: SECRET=<same as RENDER_SERVER_SECRET> bash start.sh   (start.sh installs everything)
// Env: SECRET, PORT (default 8787), YTDLP (path to yt-dlp, default "yt-dlp").
import http from "node:http";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SECRET = process.env.SECRET;
const PORT = Number(process.env.PORT || 8787);
const YTDLP = process.env.YTDLP || "yt-dlp";
const COOKIES = join(homedir(), ".snapzo-cookies.txt");
if (!SECRET) throw new Error("SECRET env var is required");

// Hard limits so one stalled download can never freeze the whole machine.
const DOWNLOAD_MS = 420000;
const RENDER_MS = 300000;

const run = (cmd, args, timeoutMs, keepOut = false) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ["ignore", keepOut ? "pipe" : "ignore", "pipe"], timeout: timeoutMs });
    let err = "";
    let out = "";
    p.stdout?.on("data", (d) => (out = (out + d).slice(-4000)));
    p.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    p.on("error", (e) => rej(e));
    p.on("close", (c) => {
      if (c === 0) return res(out);
      const last = err.split("\n").filter((l) => /error/i.test(l)).pop() ?? err.split("\n").filter(Boolean).pop();
      rej(new Error(c === null ? `${cmd} timed out after ${Math.round(timeoutMs / 1000)}s` : `${last ?? c}`));
    });
  });

// Different ways of asking YouTube for the file. A PO-token helper (bgutil, started by start.sh)
// plus Node as JS runtime makes YouTube treat the machine like a normal browser.
const STRATEGIES = [
  [],
  ["--extractor-args", "youtube:player_client=mweb"],
  ["--extractor-args", "youtube:player_client=tv"],
  ["--extractor-args", "youtube:player_client=web_safari"],
];

// Convert a JSON cookie export to Netscape format (browser extensions often give JSON).
const toNetscape = (raw) => {
  const t = raw.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return raw;
  const list = t.startsWith("{") ? JSON.parse(t).cookies || [] : JSON.parse(t);
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of list) {
    const domain = c.domain || "";
    lines.push([domain, domain.startsWith(".") ? "TRUE" : "FALSE", c.path || "/", c.secure ? "TRUE" : "FALSE", Math.floor(c.expirationDate || c.expires || 0), c.name || "", c.value || ""].join("\t"));
  }
  return lines.join("\n") + "\n";
};

const baseArgs = async () => {
  const a = ["--no-playlist", "--no-warnings", "--socket-timeout", "20", "--retries", "3", "--js-runtimes", "node"];
  try {
    const raw = await readFile(COOKIES, "utf8");
    const fixed = toNetscape(raw);
    if (fixed !== raw) await writeFile(COOKIES, fixed);
    a.push("--cookies", COOKIES);
  } catch {}
  return a;
};

async function download(url, start, end, src) {
  const errors = [];
  for (const extra of STRATEGIES) {
    try {
      await rm(src, { force: true });
      await run(
        YTDLP,
        [
          ...(await baseArgs()),
          ...extra,
          "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b",
          "--download-sections", `*${start}-${end}`,
          "--force-keyframes-at-cuts",
          "--merge-output-format", "mp4",
          "-o", src,
          url,
        ],
        DOWNLOAD_MS,
      );
      return;
    } catch (e) {
      errors.push(String(e.message || e));
      console.log("download attempt failed:", extra.join(" ") || "default", "-", e.message);
    }
  }
  throw new Error(`YouTube download failed: ${errors.pop()}`);
}

const esc = (t) => t.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%");

async function render(job) {
  const dir = await mkdtemp(join(tmpdir(), "snapzo-"));
  try {
    const src = join(dir, "src.mp4");
    const out = join(dir, "out.mp4");
    const start = Math.max(0, Number(job.start));
    const end = Math.max(start + 1, Number(job.end));
    await download(job.sourceUrl, start, end, src);
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
    console.log("done", job.clipId);
  } catch (e) {
    console.log("failed", job.clipId, e.message);
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

const authed = (req) => req.headers.authorization === `Bearer ${SECRET}`;
const json = (res, code, obj) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(obj));
const readBody = (req) =>
  new Promise((r) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => r(b));
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/health") return res.end("ok");
    if (req.method === "GET" && url.pathname === "/jobs") {
      return json(res, 200, {
        busy,
        queued: queue.length,
        making: current ? { clipId: current.clipId, seconds: Math.round((Date.now() - current.startedAt) / 1000) } : null,
      });
    }
    if (!authed(req)) return res.writeHead(401).end();

    // Quick check: can this machine fetch a short piece of a YouTube video right now?
    if (req.method === "POST" && url.pathname === "/selftest") {
      const { sourceUrl, start = 30, end = 33 } = JSON.parse((await readBody(req)) || "{}");
      const dir = await mkdtemp(join(tmpdir(), "snapzo-test-"));
      const t = Date.now();
      // Report what this machine has, so problems are visible without terminal access.
      const diag = {};
      try { diag.ytdlp = (await run(YTDLP, ["--version"], 15000, true)).trim(); } catch (e) { diag.ytdlp = `missing: ${e.message}`; }
      try { diag.potPlugin = (await run(join(dirname(YTDLP), "pip"), ["show", "bgutil-ytdlp-pot-provider"], 15000, true)).split("\n").find((l) => l.startsWith("Version")) || "not installed"; } catch { diag.potPlugin = "not installed"; }
      try {
        const raw = await readFile(COOKIES, "utf8");
        const names = raw.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t")[5]).filter(Boolean);
        diag.cookies = true;
        diag.cookieCount = names.length;
        diag.hasAuthCookie = names.includes("__Secure-3PSID") || names.includes("SID");
        diag.cookieNames = names.slice(0, 40);
      } catch { diag.cookies = false; }
      try { const h = await fetch("http://127.0.0.1:4416/ping", { signal: AbortSignal.timeout(3000) }); diag.potServer = h.ok; } catch { diag.potServer = false; }
      if (!sourceUrl) return json(res, 200, { diag });
      try {
        await download(sourceUrl, start, end, join(dir, "t.mp4"));
        return json(res, 200, { ok: true, seconds: Math.round((Date.now() - t) / 1000), diag });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e), diag });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // Save YouTube cookies sent from Snapzo, used for every download.
    // Accepts Netscape text or JSON (from browser extensions) and always stores Netscape.
    if (req.method === "POST" && url.pathname === "/cookies") {
      await writeFile(COOKIES, toNetscape(await readBody(req)));
      return json(res, 200, { ok: true });
    }

    // Pull the latest code from GitHub and restart (start.sh loop brings it back up).
    if (req.method === "POST" && url.pathname === "/update") {
      if (busy) return json(res, 409, { ok: false, error: "busy" });
      json(res, 200, { ok: true });
      return setTimeout(() => process.exit(0), 300);
    }

    if (req.method !== "POST" || url.pathname !== "/render") return res.writeHead(404).end();
    try {
      const job = JSON.parse(await readBody(req));
      if (!/^https:\/\/(www\.|m\.)?(youtube\.com|youtu\.be)\//.test(job.sourceUrl)) throw new Error("Only YouTube links");
      queue.push(job);
      next();
      json(res, 202, { queued: queue.length });
    } catch (e) {
      res.writeHead(400).end(String(e.message));
    }
  })
  .listen(PORT, () => console.log(`Snapzo render server on :${PORT}`));
