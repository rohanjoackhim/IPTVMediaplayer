/**
 * RJ IPTV and Online Radio Player — Electron shell.
 * Serves the Vite `dist` folder over http://127.0.0.1 so playlist/stream fetches behave like a normal web origin
 * (avoids file:// + CORS issues). Uses a **stable port** when possible so `localStorage` (channels, favorites, settings)
 * stays on the same origin across restarts. Requires Windows 10 or later 64-bit (Electron/Chromium limitation).
 */
const { app, BrowserWindow, ipcMain, Menu, session, net, screen, shell } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { fileURLToPath, pathToFileURL } = require("url");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json",
};

/** All bound static servers (same handler); closed on window quit. */
let staticServers = [];
/** [primary, secondary] origins for /__proxy/stream — separate ports avoid browser per-host connection limits in split view. */
let streamProxyOriginsForIpc = null;

function assertPlaylistUrlForMain(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("Invalid playlist URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) playlist links are supported.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "169.254.169.254" || h === "metadata.google.internal") {
    throw new Error("That host is not allowed.");
  }
  return u.toString();
}

ipcMain.handle("iptv-fetch-playlist-text", async (_evt, rawUrl) => {
  const url = assertPlaylistUrlForMain(rawUrl);
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "IPTV-Player/1.0 (Electron)" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
    throw new Error(snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`);
  }
  return res.text();
});

const streamRecordings = new Map();

/** Set when the static server starts; used for same-origin tap URLs in IPC. */
let rendererOrigin = null;

function streamRecordHeaders(targetUrl) {
  const u = new URL(targetUrl);
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Referer: `${u.origin}/`,
  };
}

function isLikelyHlsRecordUrl(url) {
  return /\.m3u8($|\?)/i.test(String(url));
}

const ALLOW_RECORD_TAP_TYPES = new Set([
  "video/mp2t",
  "audio/mpeg",
  "audio/aac",
  "audio/ogg",
  "application/octet-stream",
]);

function normalizeRecordTapMime(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return ALLOW_RECORD_TAP_TYPES.has(s) ? s : "video/mp2t";
}

function normalizeRecordFilenameExt(raw) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (/^\.(mpeg|mp3|aac|ogg|opus|bin)$/.test(s)) return s;
  return ".mpeg";
}

ipcMain.handle("iptv-get-stream-proxy-origins", () => streamProxyOriginsForIpc ?? []);

ipcMain.handle("iptv-pick-record-dir", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "RJ IPTV and Online Radio Player — folder for recordings",
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  return r.filePaths[0];
});

function mimeForLocalAudioExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".mp3" || e === ".mpga" || e === ".mpeg") return "audio/mpeg";
  if (e === ".m4a" || e === ".m4b") return "audio/mp4";
  if (e === ".aac") return "audio/aac";
  if (e === ".ogg" || e === ".oga") return "audio/ogg";
  if (e === ".opus") return "audio/ogg";
  if (e === ".wav") return "audio/wav";
  if (e === ".flac") return "audio/flac";
  if (e === ".webm") return "audio/webm";
  return "";
}

/**
 * Native file picker + readFile in main (reliable on Windows vs renderer File / IndexedDB quirks).
 * Returns serializable rows for the renderer IndexedDB library.
 */
ipcMain.handle("iptv-pick-local-audio-files", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Audio",
        extensions: ["mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "wav", "flac", "webm", "mpga", "mpeg"],
      },
      { name: "All files", extensions: ["*"] },
    ],
    title: "RJ IPTV — add MP3 or audiobook files",
  });
  if (r.canceled || !r.filePaths?.length) return [];
  const out = [];
  const fsp = fs.promises;
  for (const fp of r.filePaths) {
    let stat;
    try {
      stat = await fsp.stat(fp);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const ext = path.extname(fp);
    const mime = mimeForLocalAudioExt(ext) || "application/octet-stream";
    const base = path.basename(fp);
    const name = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
    const buf = await fsp.readFile(fp);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const fpNorm = path.resolve(fp);
    const h = crypto
      .createHash("sha256")
      .update(`${fpNorm}\0${stat.size}\0${Number(stat.mtimeMs)}`)
      .digest("hex")
      .slice(0, 40);
    out.push({
      id: `lib-desk-${h}`,
      name,
      size: stat.size,
      lastModified: stat.mtimeMs,
      addedAt: Date.now(),
      mime,
      data: ab,
    });
  }
  return out;
});

/**
 * Desktop: pick video files and return `file://` URLs for native `<video>` playback (no full-file read).
 */
function mimeForLocalVideoExt(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".avi" || e === ".divx") return "video/x-msvideo";
  if (e === ".mkv") return "video/x-matroska";
  if (e === ".mpeg" || e === ".mpg" || e === ".mpe" || e === ".mpv" || e === ".m1v" || e === ".m2v") return "video/mpeg";
  if (e === ".m2ts" || e === ".mts" || e === ".ts") return "video/mp2t";
  if (e === ".webm") return "video/webm";
  if (e === ".mp4" || e === ".m4v") return "video/mp4";
  if (e === ".mov" || e === ".qt") return "video/quicktime";
  if (e === ".ogv") return "video/ogg";
  if (e === ".wmv") return "video/x-ms-wmv";
  if (e === ".asf" || e === ".wm") return "video/x-ms-asf";
  return "";
}

ipcMain.handle("iptv-pick-local-video-files", async () => {
  const { pathToFileURL } = require("url");
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Video",
        extensions: [
          "mp4",
          "webm",
          "mkv",
          "mov",
          "m4v",
          "ogv",
          "avi",
          "divx",
          "wmv",
          "mpeg",
          "mpg",
          "mpe",
          "mpv",
          "m1v",
          "m2v",
          "m2ts",
          "mts",
          "ts",
          "asf",
          "wm",
        ],
      },
      { name: "All files", extensions: ["*"] },
    ],
    title: "RJ IPTV — add local video files",
  });
  if (r.canceled || !r.filePaths?.length) return [];
  const fsp = fs.promises;
  const out = [];
  for (const fp of r.filePaths) {
    let stat;
    try {
      stat = await fsp.stat(fp);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const ext = path.extname(fp);
    const base = path.basename(fp);
    const name =
      ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
    const fpNorm = path.resolve(fp);
    const h = crypto
      .createHash("sha256")
      .update(`${fpNorm}\0${stat.size}\0${Number(stat.mtimeMs)}`)
      .digest("hex")
      .slice(0, 40);
    let href;
    try {
      href = pathToFileURL(fpNorm).href;
    } catch {
      continue;
    }
    const mime = mimeForLocalVideoExt(ext) || undefined;
    out.push({
      id: `local-video-${h}`,
      name,
      url: href,
      mime,
      originalFileName: base,
    });
  }
  return out;
});

function getBundledFfmpegPath() {
  try {
    let p = require("ffmpeg-static");
    if (typeof p !== "string" || !p.trim()) return null;
    p = path.normalize(p.trim());
    if (p.includes(`${path.sep}app.asar${path.sep}`) && !p.includes(`${path.sep}app.asar.unpacked${path.sep}`)) {
      const unpacked = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpacked)) p = unpacked;
    }
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

function runFfmpeg(ffmpegPath, args) {
  return new Promise((resolve, reject) => {
    const stderrChunks = [];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    child.stderr?.on("data", (d) => stderrChunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = Buffer.concat(stderrChunks)
          .toString("utf8")
          .replace(/\r/g, "")
          .trim()
          .slice(-1400);
        reject(new Error(tail ? `ffmpeg exited ${code}: ${tail}` : `ffmpeg exited with code ${code}`));
      }
    });
  });
}

/**
 * Matroska (.mkv) often uses codecs Chromium cannot decode (HEVC, DTS, etc.). Remux or transcode to H.264/AAC MP4
 * via bundled ffmpeg-static (first open may take a while; result is cached under the user temp folder).
 */
ipcMain.handle("iptv-prepare-mkv-playback", async (_evt, fileUrlRaw) => {
  const fileUrl = String(fileUrlRaw ?? "").trim();
  if (!/^file:/i.test(fileUrl)) {
    return { playUrl: fileUrl, mimeType: "video/mp4", usedTranscode: false };
  }
  let inPath;
  try {
    inPath = fileURLToPath(fileUrl);
  } catch {
    throw new Error("Invalid file URL.");
  }
  const ext = path.extname(inPath).toLowerCase();
  if (ext !== ".mkv" && ext !== ".mka") {
    return { playUrl: fileUrl, mimeType: undefined, usedTranscode: false };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not bundled with this app. MKV playback needs a packaged desktop build with ffmpeg-static."
    );
  }

  const fsp = fs.promises;
  let st;
  try {
    st = await fsp.stat(inPath);
  } catch {
    throw new Error("Could not read the video file from disk.");
  }
  if (!st.isFile() || st.size === 0) throw new Error("Video file is missing or empty.");

  const fpNorm = path.resolve(inPath);
  const cacheKey = crypto
    .createHash("sha256")
    .update(`${fpNorm}\0${st.size}\0${Number(st.mtimeMs)}`)
    .digest("hex")
    .slice(0, 48);
  const cacheDir = path.join(app.getPath("temp"), "rj-iptv-mkv-cache");
  await fsp.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.mp4`);

  try {
    const ost = await fsp.stat(outPath);
    if (ost.size > 32_000) {
      return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true, fromCache: true };
    }
  } catch {
    /* build */
  }

  const tryUnlink = async (p) => {
    try {
      await fsp.unlink(p);
    } catch {
      /* noop */
    }
  };

  await tryUnlink(outPath);

  const baseArgs = ["-nostdin", "-hide_banner", "-loglevel", "warning", "-y", "-i", fpNorm];

  const copyWithAudio = ["-map", "0:v:0", "-map", "0:a:0", "-c", "copy", "-movflags", "+faststart"];
  const copyVideoOnly = ["-map", "0:v:0", "-c", "copy", "-an", "-movflags", "+faststart"];
  const x264aac = [
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-b:a",
    "192k",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
  ];
  const x264an = ["-map", "0:v:0", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-an", "-movflags", "+faststart"];

  const tryEncode = async (extraArgs) => {
    await tryUnlink(outPath);
    await runFfmpeg(ffmpegPath, [...baseArgs, ...extraArgs, outPath]);
  };

  try {
    await tryEncode(copyWithAudio);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: false, remuxed: true };
  } catch {
    await tryUnlink(outPath);
  }

  try {
    await tryEncode(copyVideoOnly);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: false, remuxed: true };
  } catch {
    await tryUnlink(outPath);
  }

  try {
    await tryEncode(x264aac);
    return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true };
  } catch {
    await tryUnlink(outPath);
  }

  await tryEncode(x264an);
  return { playUrl: pathToFileURL(outPath).href, mimeType: "video/mp4", usedTranscode: true };
});

function attachRecordingFanout(id, upstream, ws, filePath, tapMime) {
  const handle = { upstream, ws, filePath, tapRes: null, tapMime: tapMime || "video/mp2t" };
  const bp = { fileOk: true, tapOk: true };

  const resumeIfReady = () => {
    if (!upstream.isPaused()) return;
    if (bp.fileOk && bp.tapOk) upstream.resume();
  };

  const fail = () => {
    teardownRecording(id, true);
  };

  upstream.on("data", (chunk) => {
    bp.fileOk = ws.write(chunk) !== false;
    if (handle.tapRes && !handle.tapRes.writableEnded) {
      try {
        bp.tapOk = handle.tapRes.write(chunk) !== false;
      } catch {
        bp.tapOk = true;
        try {
          handle.tapRes.removeAllListeners("drain");
          handle.tapRes.destroy();
        } catch {
          /* noop */
        }
        handle.tapRes = null;
      }
    } else {
      bp.tapOk = true;
    }
    if (!bp.fileOk || !bp.tapOk) upstream.pause();
  });

  upstream.on("error", fail);
  ws.on("error", fail);

  upstream.on("end", () => {
    try {
      ws.end();
    } catch {
      /* noop */
    }
    try {
      if (handle.tapRes && !handle.tapRes.writableEnded) {
        handle.tapRes.removeAllListeners("drain");
        handle.tapRes.end();
      }
    } catch {
      /* noop */
    }
    streamRecordings.delete(id);
  });

  ws.on("drain", () => {
    bp.fileOk = true;
    resumeIfReady();
  });

  handle._onTapDrain = () => {
    bp.tapOk = true;
    resumeIfReady();
  };

  streamRecordings.set(id, handle);
}

function teardownRecording(id, removeMap) {
  const h = streamRecordings.get(id);
  if (!h) return;
  try {
    h.upstream.destroy();
  } catch {
    /* noop */
  }
  try {
    h.ws.end();
  } catch {
    /* noop */
  }
  try {
    if (h.tapRes && !h.tapRes.writableEnded) {
      h.tapRes.removeAllListeners("drain");
      h.tapRes.end();
    }
  } catch {
    /* noop */
  }
  if (removeMap) streamRecordings.delete(id);
}

ipcMain.handle("iptv-start-stream-record", async (_evt, payload) => {
  const outDir = typeof payload?.outDir === "string" ? payload.outDir.trim() : "";
  if (!outDir) throw new Error("No output folder.");
  const url = assertPlaylistUrlForMain(payload?.url);
  if (isLikelyHlsRecordUrl(url)) {
    throw new Error(
      "HLS (.m3u8) cannot be saved as one raw .mpeg file from this app. Use a continuous TS-style URL or record with ffmpeg/VLC."
    );
  }
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tapMime = normalizeRecordTapMime(payload?.tapContentType);
  const filenameExt = normalizeRecordFilenameExt(payload?.filenameExt);
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}${filenameExt}`;
  const filePath = path.join(outDir, name);
  const ws = fs.createWriteStream(filePath, { flags: "w", highWaterMark: 4 * 1024 * 1024 });
  let res;
  try {
    res = await net.fetch(url, { headers: streamRecordHeaders(url) });
  } catch (e) {
    ws.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    throw new Error(e instanceof Error ? e.message : "Network error");
  }
  if (!res.ok) {
    ws.destroy();
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* noop */
    }
    throw new Error(`HTTP ${res.status}`);
  }
  if (!res.body) {
    ws.end();
    return { ok: true, id, filePath, playbackUrl: null };
  }
  const upstream = Readable.fromWeb(res.body);
  attachRecordingFanout(id, upstream, ws, filePath, tapMime);
  const playbackUrl =
    rendererOrigin != null ? `${rendererOrigin}/__tap/stream?id=${encodeURIComponent(id)}` : null;
  return { ok: true, id, filePath, playbackUrl };
});

ipcMain.handle("iptv-stop-stream-record", async (_evt, id) => {
  const h = streamRecordings.get(id);
  if (!h) return { ok: true };
  teardownRecording(id, true);
  return { ok: true, filePath: h.filePath };
});

/** Open File Explorer with the recorded file selected (Windows shell). */
ipcMain.handle("iptv-show-record-in-folder", async (_evt, rawPath) => {
  const fp = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!fp) throw new Error("No file path.");
  const resolved = path.resolve(fp);
  if (resolved.length < 4) throw new Error("Invalid path.");
  shell.showItemInFolder(resolved);
  return { ok: true };
});

app.on("before-quit", () => {
  for (const id of [...streamRecordings.keys()]) {
    teardownRecording(id, true);
  }
});

app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  try {
    const u = new URL(url);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") {
      callback(false);
      return;
    }
  } catch {
    callback(false);
    return;
  }
  /* Many IPTV panels use HTTPS with incomplete chains / self-signed certs. */
  event.preventDefault();
  callback(true);
});

/** Many IPTV CDNs reject the default Electron/Chromium UA on media XHR. */
function installStreamRequestHeaderTweaks() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const { url } = details;
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("devtools://") ||
      url.startsWith("chrome-extension://")
    ) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const headers = { ...details.requestHeaders };
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
    if (!headers["User-Agent"] && !headers["User-agent"]) {
      headers["User-Agent"] = ua;
    }
    if (!headers.Referer && !headers.referer) {
      try {
        const u = new URL(url);
        headers.Referer = `${u.protocol}//${u.host}/`;
      } catch {
        /* ignore */
      }
    }
    callback({ requestHeaders: headers });
  });
}

/**
 * Chromium and Firefox apply CORS to fetch() (mpegts.js). Many IPTV hosts omit
 * Access-Control-Allow-Origin, so the renderer cannot read the body. We also
 * patch responses for direct cross-origin fetches (e.g. HLS). MPEG-TS is
 * proxied through /__proxy/stream on the local static server when possible.
 */
function installStreamResponseCorsPatch() {
  const resourceTypes = new Set(["xhr", "media", "other", "ping"]);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const { url } = details;
    if (
      url.startsWith("http://127.0.0.1") ||
      url.startsWith("http://localhost") ||
      url.startsWith("devtools://")
    ) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    if (!resourceTypes.has(details.resourceType)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const rh = { ...details.responseHeaders };
    for (const key of Object.keys(rh)) {
      if (key.toLowerCase() === "cross-origin-resource-policy") {
        delete rh[key];
      }
    }
    const lower = Object.fromEntries(
      Object.entries(rh).map(([k, v]) => [k.toLowerCase(), v])
    );
    if (!lower["access-control-allow-origin"]) {
      rh["Access-Control-Allow-Origin"] = ["*"];
    }
    callback({ responseHeaders: rh });
  });
}

function installElectronNetworkCompat() {
  installStreamRequestHeaderTweaks();
  installStreamResponseCorsPatch();
}

function distDir() {
  return path.join(__dirname, "..", "dist");
}

function assertStreamProxyTarget(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("Only http(s) targets are allowed.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "169.254.169.254" || h === "metadata.google.internal") {
    throw new Error("Host blocked.");
  }
  return u.toString();
}

async function tryServeStreamProxy(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__proxy/stream") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }
  const target = u.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing url query parameter.");
    return true;
  }
  let validated;
  try {
    validated = assertStreamProxyTarget(target);
  } catch (e) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end(e.message);
    return true;
  }
  const tObj = new URL(validated);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Referer: `${tObj.origin}/`,
  };
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  let up;
  try {
    up = await net.fetch(validated, { method: req.method, headers });
  } catch (e) {
    res
      .writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
      .end(e instanceof Error ? e.message : "Upstream fetch failed");
    return true;
  }

  const out = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  const ct = up.headers.get("content-type");
  if (ct) out["Content-Type"] = ct;
  const cl = up.headers.get("content-length");
  if (cl) out["Content-Length"] = cl;
  const cr = up.headers.get("content-range");
  if (cr) out["Content-Range"] = cr;
  const ar = up.headers.get("accept-ranges");
  if (ar) out["Accept-Ranges"] = ar;

  if (req.method === "HEAD" || up.status === 204 || !up.body) {
    res.writeHead(up.status, out).end();
    return true;
  }

  res.writeHead(up.status, out);
  const nodeStream = Readable.fromWeb(up.body);
  nodeStream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  nodeStream.pipe(res);
  return true;
}

/** Live fan-out of the single upstream used for recording: same bytes as disk, for the in-page player. */
async function tryServeStreamTap(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__tap/stream") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "*",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }

  const id = u.searchParams.get("id");
  if (!id) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Missing id query parameter.");
    return true;
  }

  const handle = streamRecordings.get(id);
  if (!handle) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Recording session not found.");
    return true;
  }

  if (req.method === "HEAD") {
    const tapCt = handle.tapMime || "video/mp2t";
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "Content-Type": tapCt,
    });
    res.end();
    return true;
  }

  if (handle.tapRes && !handle.tapRes.writableEnded) {
    try {
      handle.tapRes.removeAllListeners("drain");
      handle.tapRes.removeAllListeners("close");
      handle.tapRes.destroy();
    } catch {
      /* noop */
    }
    handle.tapRes = null;
  }

  const tapCt = handle.tapMime || "video/mp2t";
  const out = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": tapCt,
  };
  res.writeHead(200, out);
  handle.tapRes = res;
  res.on("drain", handle._onTapDrain);
  res.once("close", () => {
    if (handle.tapRes === res) {
      try {
        res.removeAllListeners("drain");
      } catch {
        /* noop */
      }
      handle.tapRes = null;
    }
  });
  handle._onTapDrain();
  return true;
}

function safeFilePath(root, reqUrl) {
  let pathname = "/";
  try {
    pathname = new URL(reqUrl, "http://127.0.0.1").pathname || "/";
  } catch {
    return null;
  }
  if (pathname === "/__proxy/stream" || pathname === "/__tap/stream") return null;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.resolve(path.join(root, rel));
  const rootResolved = path.resolve(root);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

/** Same origin each launch → browser localStorage for channels/favorites persists. */
const STATIC_SERVER_PREFERRED_PORT = 48752;
const STATIC_SERVER_PORT_TRIES = 40;

function createStaticRequestHandler(root) {
  return (req, res) => {
    void (async () => {
      try {
        if (await tryServeStreamTap(req, res)) return;
        if (await tryServeStreamProxy(req, res)) return;
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        }
        res.end(e instanceof Error ? e.message : "Proxy error");
        return;
      }

      const filePath = safeFilePath(root, req.url || "/");
      if (!filePath) {
        res.writeHead(403).end();
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404).end("Not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.writeHead(200).end(data);
      });
    })();
  };
}

function startStaticServers(root) {
  const requestHandler = createStaticRequestHandler(root);

  function listenOnPort(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer(requestHandler);
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeAllListeners("error");
        server.on("error", (err) => {
          console.error("IPTV static server error:", err);
        });
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        resolve({ server, url: `http://127.0.0.1:${actualPort}/` });
      });
    });
  }

  return (async () => {
    for (let i = 0; i < STATIC_SERVER_PORT_TRIES; i++) {
      const port1 = STATIC_SERVER_PREFERRED_PORT + i;
      try {
        const first = await listenOnPort(port1);
        let second = null;
        for (let k = 1; k <= 96; k++) {
          try {
            second = await listenOnPort(port1 + k);
            break;
          } catch (e) {
            if (e && e.code === "EADDRINUSE") continue;
            throw e;
          }
        }
        if (!second) {
          try {
            second = await listenOnPort(0);
          } catch {
            /* one server only */
          }
        }
        const servers = [first.server];
        const origins = [new URL(first.url).origin];
        if (second) {
          servers.push(second.server);
          origins.push(new URL(second.url).origin);
        } else {
          origins.push(origins[0]);
        }
        streamProxyOriginsForIpc = origins;
        return { servers, appUrl: first.url, streamProxyOrigins: origins };
      } catch (e) {
        if (e && e.code === "EADDRINUSE") continue;
        throw e;
      }
    }
    const first = await listenOnPort(0);
    let second = null;
    try {
      second = await listenOnPort(0);
    } catch {
      /* noop */
    }
    const servers = [first.server];
    const origins = [new URL(first.url).origin];
    if (second) {
      servers.push(second.server);
      origins.push(new URL(second.url).origin);
    } else {
      origins.push(origins[0]);
    }
    streamProxyOriginsForIpc = origins;
    return { servers, appUrl: first.url, streamProxyOrigins: origins };
  })();
}

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState() {
  try {
    const p = windowStateFile();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function clampWindowBounds(raw) {
  if (!raw || typeof raw.width !== "number" || typeof raw.height !== "number") return null;
  const primary = screen.getPrimaryDisplay();
  const WA = primary.workArea;
  const minW = 900;
  const minH = 600;
  const width = Math.max(minW, Math.min(Math.floor(raw.width), WA.width));
  const height = Math.max(minH, Math.min(Math.floor(raw.height), WA.height));
  let x = typeof raw.x === "number" ? Math.floor(raw.x) : WA.x;
  let y = typeof raw.y === "number" ? Math.floor(raw.y) : WA.y;
  const minVisible = 120;
  if (x + width < WA.x + minVisible) x = WA.x;
  if (x > WA.x + WA.width - minVisible) x = WA.x + WA.width - width;
  if (y + height < WA.y + minVisible) y = WA.y;
  if (y > WA.y + WA.height - minVisible) y = WA.y + WA.height - height;
  return { x, y, width, height, isMaximized: !!raw.isMaximized };
}

/** First launch or missing window-state: fill primary monitor work area at native resolution. */
function defaultWindowBoundsFromDisplay() {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    x: wa.x,
    y: wa.y,
    width: Math.max(900, Math.floor(wa.width)),
    height: Math.max(600, Math.floor(wa.height)),
    isMaximized: true,
  };
}

function installAppMenu() {
  const isMac = process.platform === "darwin";
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
          { label: "File", submenu: [{ role: "close" }] },
        ]
      : [{ label: "File", submenu: [{ role: "quit", label: "Exit" }] }]),
    {
      label: "View",
      submenu: [{ role: "togglefullscreen", label: "Full screen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const data = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      isMaximized: win.isMaximized(),
    };
    fs.writeFileSync(windowStateFile(), JSON.stringify(data));
  } catch {
    /* noop */
  }
}

async function createWindow() {
  const root = distDir();
  if (!fs.existsSync(path.join(root, "index.html"))) {
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "RJ IPTV and Online Radio Player",
      "Built UI not found (missing dist/index.html). Run npm run build first, then rebuild the desktop app."
    );
    app.quit();
    return;
  }

  const { servers, appUrl, streamProxyOrigins } = await startStaticServers(root);
  staticServers = servers;
  try {
    rendererOrigin = new URL(appUrl).origin;
  } catch {
    rendererOrigin = null;
  }

  const preloadPath = path.join(__dirname, "preload.cjs");

  const wb = clampWindowBounds(loadWindowState()) ?? defaultWindowBoundsFromDisplay();

  const win = new BrowserWindow({
    width: wb.width,
    height: wb.height,
    x: wb.x,
    y: wb.y,
    minWidth: 900,
    minHeight: 600,
    title: "RJ IPTV and Online Radio Player",
    fullscreenable: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      /* IPTV streams and M3U hosts often lack CORS; desktop shell matches typical IPTV desktop players. */
      webSecurity: false,
    },
    show: false,
  });

  win.once("ready-to-show", () => {
    if (wb.isMaximized) win.maximize();
    win.show();
  });
  await win.loadURL(appUrl);

  win.on("close", () => saveWindowState(win));

  win.on("closed", () => {
    for (const s of staticServers) {
      try {
        s.close();
      } catch {
        /* noop */
      }
    }
    staticServers = [];
  });
}

app.whenReady().then(() => {
  installElectronNetworkCompat();
  installAppMenu();
  return createWindow();
});

app.on("window-all-closed", () => {
  for (const s of staticServers) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  staticServers = [];
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
