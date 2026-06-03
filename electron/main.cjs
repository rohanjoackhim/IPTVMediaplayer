/**
 * Player — Electron shell.
 * Serves the Vite `dist` folder over http://127.0.0.1 so playlist/stream fetches behave like a normal web origin
 * (avoids file:// + CORS issues). Uses a **stable port** when possible so `localStorage` (channels, favorites, settings)
 * stays on the same origin across restarts. Desktop targets: recent Windows (x64), macOS (arm64 / Intel per build).
 */
const { app, BrowserWindow, ipcMain, Menu, clipboard, session, net, screen, shell } = require("electron");
const path = require("path");
const fs = require("fs");

/** Load `.env` from several locations (dev, packaged, cwd) so `DEEPSEEK_API_KEY` / `GEMINI_*` are visible to IPC. */
function loadEnvFromProjectRoot() {
  try {
    const dotenv = require("dotenv");
    const candidates = [
      path.join(__dirname, "..", ".env"),
      path.join(process.cwd(), ".env"),
    ];
    if (app && typeof app.isPackaged === "boolean" && app.isPackaged) {
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, ".env"));
      }
      try {
        candidates.push(path.join(path.dirname(process.execPath), ".env"));
      } catch {
        /* noop */
      }
    }
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          dotenv.config({ path: p });
          return;
        }
      } catch {
        /* try next */
      }
    }
  } catch {
    /* dotenv is optional */
  }
}
loadEnvFromProjectRoot();
const http = require("http");
const nodeNet = require("net");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const { Readable, PassThrough } = require("stream");
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
let streamProxySessionToken = null;
let splitScreenPreferenceEnabled = false;
/** Exact recording output files the renderer may reveal in the file manager. */
const allowedRecordRevealPaths = new Set();
/** Recording output folders chosen in the native picker. */
const allowedRecordOutputDirs = new Set();

const BLOCKED_FETCH_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "169.254.169.254",
]);

function parseIpv4Host(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1, 5).map((n) => Number(n));
  if (parts.some((n) => n > 255)) return null;
  return parts;
}

/** Block loopback, link-local, and cloud metadata. RFC1918 LAN hosts stay allowed for IPTV. */
function isBlockedFetchHostname(hostname) {
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (BLOCKED_FETCH_HOSTNAMES.has(h)) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = parseIpv4Host(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function assertSafeFetchUrl(raw, label = "URL") {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    throw new Error(`Invalid ${label}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) ${label} is supported.`);
  }
  if (isBlockedFetchHostname(u.hostname)) {
    throw new Error("That host is not allowed.");
  }
  if (u.username || u.password) {
    throw new Error("URLs with embedded credentials are not allowed.");
  }
  return u.toString();
}

function assertPlaylistUrlForMain(raw) {
  return assertSafeFetchUrl(raw, "playlist URL");
}

function assertStreamProxySessionToken(reqUrl) {
  if (!streamProxySessionToken) return;
  let u;
  try {
    u = new URL(reqUrl || "/", "http://127.0.0.1");
  } catch {
    throw new Error("Invalid proxy request.");
  }
  const token = u.searchParams.get("token");
  if (token !== streamProxySessionToken) {
    throw new Error("Forbidden.");
  }
}

function assertUserAccessibleMediaPath(resolvedPath) {
  const resolved = path.resolve(resolvedPath);
  const roots = [
    app.getPath("home"),
    app.getPath("videos"),
    app.getPath("music"),
    app.getPath("downloads"),
    app.getPath("documents"),
    app.getPath("desktop"),
    app.getPath("temp"),
  ]
    .map((p) => {
      try {
        return path.resolve(p);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error("Media file must be under your user folders.");
  }
  return resolved;
}

function assertAllowedRecordRevealPath(rawPath) {
  const resolved = path.resolve(String(rawPath ?? "").trim());
  if (resolved.length < 4) throw new Error("Invalid path.");
  if (allowedRecordRevealPaths.has(resolved)) return resolved;
  for (const dir of allowedRecordOutputDirs) {
    if (resolved === dir || resolved.startsWith(`${dir}${path.sep}`)) return resolved;
  }
  throw new Error("That file path is not from an app recording.");
}

const APP_CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:* https:; media-src 'self' blob: file: http: https:; connect-src 'self' http://127.0.0.1:* https: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-src https:; form-action 'none';";

/**
 * Fetch playlist text using a hidden BrowserWindow to solve Cloudflare JS challenges.
 * Strategy: load the URL in a real Chromium context, wait for CF to clear, then
 * re-fetch using net.fetch (which now has the cf_clearance cookie in the session).
 * If that still fails, extract the page source directly.
 */
function fetchPlaylistViaHiddenWindow(url) {
  return new Promise((resolve, reject) => {
    const timeout = 45_000;
    const win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    let settled = false;
    let loadCount = 0;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      win.destroy();
      reject(new Error("Timed out waiting for playlist (Cloudflare challenge may have failed)."));
    }, timeout);

    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.destroy();
      if (!text || !text.trim()) {
        reject(new Error("Empty response from server."));
        return;
      }
      resolve(text);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      win.destroy();
      reject(err);
    };

    win.webContents.on("did-finish-load", async () => {
      loadCount++;
      try {
        // Wait a moment for any final JS redirect
        await new Promise((r) => setTimeout(r, 2000));
        if (settled) return;

        // Try net.fetch again now that cf_clearance cookie should be set in the session
        try {
          const res2 = await net.fetch(url, { method: "GET", redirect: "follow", bypassCustomProtocolHandlers: true });
          if (res2.ok) {
            const t = await res2.text();
            if (t.includes("#EXTINF") || t.includes("#EXTM3U") || /^https?:\/\//m.test(t)) {
              finish(t);
              return;
            }
          }
        } catch { /* fall through to page extraction */ }

        if (settled) return;

        // Fallback: extract raw page source (preserves #EXTINF lines unlike innerText)
        const src = await win.webContents.executeJavaScript(
          `(function(){
            var pre = document.querySelector("pre");
            if (pre) return pre.textContent;
            return document.body.textContent || document.body.innerText || "";
          })()`
        );
        if (settled) return;

        if (src && (src.includes("#EXTINF") || src.includes("#EXTM3U") || /^https?:\/\//m.test(src))) {
          finish(src);
          return;
        }

        // If first load was likely the CF challenge page, wait for redirect
        if (loadCount <= 1) return; // will fire did-finish-load again after redirect

        finish(src);
      } catch (e) {
        fail(e);
      }
    });

    win.webContents.on("did-fail-load", (_event, code, desc) => {
      // -3 = aborted (redirect), ignore
      if (code === -3) return;
      fail(new Error(`Failed to load playlist: ${desc} (code ${code})`));
    });

    win.loadURL(url).catch(fail);
  });
}

/** Detect Xtream get.php URL and extract server/username/password for API fallback. */
function parseXtreamGetPhpUrl(url) {
  try {
    const u = new URL(url);
    if (!u.pathname.endsWith("/get.php")) return null;
    const username = u.searchParams.get("username");
    const password = u.searchParams.get("password");
    if (!username || !password) return null;
    return { base: `${u.protocol}//${u.host}`, username, password };
  } catch { return null; }
}

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "*/*",
};

/** Safely fetch JSON from Xtream API, returning [] on failure. */
async function xtreamJsonFetch(url) {
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/** Escape value for M3U attribute (strip quotes). */
function m3uAttr(val) { return String(val ?? "").replace(/"/g, ""); }

/** Build M3U text from Xtream player_api.php JSON endpoints (live + VOD + series). */
async function buildM3uFromXtreamApi(base, username, password) {
  const apiBase = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  /* ---------- Live channels ---------- */
  console.log("[IPTV] Xtream API: fetching categories…");
  const catRes = await fetch(`${apiBase}&action=get_live_categories`, {
    headers: FETCH_HEADERS, signal: AbortSignal.timeout(30_000),
  });
  const categories = catRes.ok ? await catRes.json() : [];
  const catMap = {};
  if (Array.isArray(categories)) {
    for (const c of categories) catMap[String(c.category_id)] = c.category_name || "";
  }

  console.log("[IPTV] Xtream API: fetching live streams…");
  const streamRes = await fetch(`${apiBase}&action=get_live_streams`, {
    headers: FETCH_HEADERS, signal: AbortSignal.timeout(120_000),
  });
  if (!streamRes.ok) {
    throw new Error(`Xtream API error: HTTP ${streamRes.status}`);
  }
  const streams = await streamRes.json();
  if (!Array.isArray(streams) || !streams.length) {
    throw new Error("Xtream API returned no channels.");
  }

  const outputFmt = "ts";
  const lines = ["#EXTM3U"];
  for (const s of streams) {
    const name = s.name || `Stream ${s.stream_id}`;
    const group = catMap[String(s.category_id)] || "";
    const logo = s.stream_icon || "";
    const epgId = s.epg_channel_id || "";
    const sid = s.stream_id;
    lines.push(
      `#EXTINF:-1 tvg-id="${m3uAttr(epgId)}" tvg-logo="${m3uAttr(logo)}" group-title="${m3uAttr(group)}" content-type="live",${name}`
    );
    lines.push(`${base}/${username}/${password}/${sid}.${outputFmt}`);
  }
  console.log("[IPTV] Xtream API: built M3U with", streams.length, "live channels");

  /* ---------- VOD (Movies) ---------- */
  console.log("[IPTV] Xtream API: fetching VOD categories…");
  const vodCats = await xtreamJsonFetch(`${apiBase}&action=get_vod_categories`);
  const vodCatMap = {};
  for (const c of vodCats) vodCatMap[String(c.category_id)] = c.category_name || "";

  console.log("[IPTV] Xtream API: fetching VOD streams…");
  const vodStreams = await xtreamJsonFetch(`${apiBase}&action=get_vod_streams`);
  let vodCount = 0;
  for (const v of vodStreams) {
    const name = v.name || `Movie ${v.stream_id}`;
    const group = vodCatMap[String(v.category_id)] || "Movies";
    const logo = v.stream_icon || "";
    const ext = v.container_extension || "mp4";
    const sid = v.stream_id;
    const rating = v.rating || "";
    const year = v.release_date || v.releaseDate || v.year || "";
    const genre = v.genre || "";
    const plot = (v.plot || "").replace(/"/g, "'").slice(0, 500);
    lines.push(
      `#EXTINF:-1 tvg-logo="${m3uAttr(logo)}" group-title="${m3uAttr(group)}" content-type="movie" rating="${m3uAttr(rating)}" release-year="${m3uAttr(year)}" genre="${m3uAttr(genre)}" plot="${m3uAttr(plot)}" container-ext="${m3uAttr(ext)}",${name}`
    );
    lines.push(`${base}/movie/${username}/${password}/${sid}.${ext}`);
    vodCount++;
  }
  console.log("[IPTV] Xtream API:", vodCount, "movies");

  /* ---------- Series ---------- */
  console.log("[IPTV] Xtream API: fetching series categories…");
  const seriesCats = await xtreamJsonFetch(`${apiBase}&action=get_series_categories`);
  const seriesCatMap = {};
  for (const c of seriesCats) seriesCatMap[String(c.category_id)] = c.category_name || "";

  console.log("[IPTV] Xtream API: fetching series list…");
  const seriesList = await xtreamJsonFetch(`${apiBase}&action=get_series`);

  /* Add each series as a single show-level entry.
     Episode details are fetched lazily via IPC when the user drills into a show. */
  for (const show of seriesList) {
    if (!show || !show.series_id) continue;
    const seriesId = show.series_id;
    const showName = show.name || `Series ${seriesId}`;
    const showGroup = seriesCatMap[String(show.category_id)] || "Series";
    const showLogo = show.cover || "";
    const showGenre = show.genre || "";
    const showPlot = (show.plot || "").replace(/"/g, "'").slice(0, 500);
    const showRating = show.rating || "";
    const showYear = show.releaseDate || show.release_date || show.year || "";
    lines.push(
      `#EXTINF:-1 tvg-logo="${m3uAttr(showLogo)}" group-title="${m3uAttr(showGroup)}" content-type="series" series-name="${m3uAttr(showName)}" series-id="${seriesId}" genre="${m3uAttr(showGenre)}" plot="${m3uAttr(showPlot)}" rating="${m3uAttr(showRating)}" release-year="${m3uAttr(showYear)}",${showName}`
    );
    lines.push(`${base}/series/${username}/${password}/${seriesId}.ts`);
  }
  console.log("[IPTV] Xtream API:", seriesList.length, "series (episodes loaded on demand)");

  console.log("[IPTV] Xtream API: total M3U entries:", streams.length + vodCount + seriesList.length);
  return lines.join("\n");
}

/** Fetch episode list for a single Xtream series on demand. */
ipcMain.handle("iptv-fetch-series-episodes", async (_evt, payload) => {
  const { server, username, password, seriesId } = payload ?? {};
  if (!server || !username || !password || !seriesId) return { episodes: [] };
  const base = String(server).replace(/\/+$/, "");
  const apiBase = `${base}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  try {
    const res = await fetch(`${apiBase}&action=get_series_info&series_id=${seriesId}`, {
      headers: FETCH_HEADERS, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { episodes: [] };
    const info = await res.json();
    const episodes = info?.episodes;
    if (!episodes || typeof episodes !== "object") return { episodes: [] };

    const result = [];
    for (const [seasonNum, epList] of Object.entries(episodes)) {
      if (!Array.isArray(epList)) continue;
      const sn = parseInt(seasonNum, 10) || 0;
      for (const ep of epList) {
        const epId = ep.id || ep.stream_id || ep.episode_id || 0;
        const ext = ep.container_extension || "mp4";
        const epNum = ep.episode_num != null ? parseInt(String(ep.episode_num), 10) : 0;
        const epTitle = ep.title || ep.name || `Episode ${epNum || "?"}`;
        const epLogo = ep.info?.movie_image || ep.info?.cover_big || "";
        const epPlot = (ep.info?.plot || "").slice(0, 500);
        const epRating = ep.info?.rating || "";
        result.push({
          id: epId,
          season: sn,
          episode: epNum,
          title: epTitle,
          logo: epLogo,
          plot: epPlot,
          rating: epRating,
          ext,
          url: `${base}/series/${username}/${password}/${epId}.${ext}`,
        });
      }
    }
    return { episodes: result };
  } catch (e) {
    console.error("[IPTV] fetch series episodes error:", e?.message);
    return { episodes: [] };
  }
});

ipcMain.handle("iptv-fetch-playlist-text", async (_evt, rawUrl) => {
  const url = assertPlaylistUrlForMain(rawUrl);
  console.log("[IPTV] Fetching playlist:", url.slice(0, 120) + (url.length > 120 ? "…" : ""));

  // Try Node fetch first — works for most servers and handles status codes > 599
  // that Electron's net.fetch cannot represent (e.g. Cloudflare 530).
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(120_000),
    });
    console.log("[IPTV] fetch status:", res.status);
    if (res.ok) {
      const text = await res.text();
      console.log("[IPTV] fetch OK, length:", text.length, "starts:", text.slice(0, 80).replace(/\s+/g, " "));
      // If the response looks like valid M3U, return it
      if (text.includes("#EXTINF") || text.includes("#EXTM3U") || /^https?:\/\//m.test(text)) {
        return text;
      }
      // Otherwise the response might be HTML/JSON — fall through
      console.log("[IPTV] Response is not M3U, trying Xtream API…");
    } else {
      console.log("[IPTV] Blocked (HTTP", res.status + "), trying fallbacks…");
    }
  } catch (e) {
    console.log("[IPTV] fetch error:", e?.message);
  }

  // Fallback: if this is an Xtream get.php URL, use the player_api.php JSON endpoints
  const xtream = parseXtreamGetPhpUrl(url);
  if (xtream) {
    try {
      return await buildM3uFromXtreamApi(xtream.base, xtream.username, xtream.password);
    } catch (e) {
      console.log("[IPTV] Xtream API fallback failed:", e?.message);
      // Fall through to hidden window
    }
  }

  // Last resort: load in a real browser context to solve Cloudflare challenge
  return fetchPlaylistViaHiddenWindow(url);
});

function parseXmltvTimestampMain(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{4}))?/.exec(s);
  if (!m) return null;
  if (!m[7]) {
    const local = new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      parseInt(m[4], 10),
      parseInt(m[5], 10),
      parseInt(m[6], 10)
    );
    const ms = local.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const sign = m[7][0] === "-" ? -1 : 1;
  const offH = parseInt(m[7].slice(1, 3), 10);
  const offM = parseInt(m[7].slice(3, 5), 10);
  const offsetMs = sign * (offH * 3600 + offM * 60) * 1000;
  const ms = Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10)
  );
  return Number.isFinite(ms) ? ms - offsetMs : null;
}

function parseProgrammeBlockMain(block, channelId, fromMs, toMs) {
  if (!block.includes(`channel="${channelId}"`)) return null;
  const startM = /start="([^"]+)"/.exec(block);
  const stopM = /stop="([^"]+)"/.exec(block);
  if (!startM || !stopM) return null;
  const start = parseXmltvTimestampMain(startM[1]);
  const stop = parseXmltvTimestampMain(stopM[1]);
  if (start == null || stop == null || stop <= start) return null;
  if (stop <= fromMs || start >= toMs) return null;
  const titleM = /<title[^>]*>([^<]*)<\/title>/i.exec(block);
  const descM = /<desc[^>]*>([^<]*)<\/desc>/i.exec(block);
  return {
    channelId,
    start,
    stop,
    title: (titleM?.[1] ?? "Programme").trim() || "Programme",
    description: descM?.[1]?.trim() || undefined,
  };
}

const epgProgrammeCache = new Map();
/** Dedupe identical in-flight EPG requests. */
const epgScanInflight = new Map();

async function streamExtractProgrammes(url, channelId, fromMs, toMs) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "IPTV-Player/1.0 (Electron)" },
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    throw new Error(`EPG HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("EPG response has no body.");
  }

  const programmes = [];
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx = buf.indexOf("<programme");
    while (idx !== -1) {
      const end = buf.indexOf("</programme>", idx);
      if (end === -1) break;
      const block = buf.slice(idx, end + 12);
      buf = buf.slice(end + 12);
      const row = parseProgrammeBlockMain(block, channelId, fromMs, toMs);
      if (row) programmes.push(row);
      idx = buf.indexOf("<programme");
    }
    if (buf.length > 1_500_000) buf = buf.slice(-300_000);
  }

  programmes.sort((a, b) => a.start - b.start);
  return programmes;
}

/** Stream-scan large XMLTV and return programmes for one channel id in a time window. */
ipcMain.handle("iptv-extract-epg-programmes", async (_evt, payload) => {
  const url = assertPlaylistUrlForMain(payload?.url);
  const channelId = String(payload?.channelId ?? "").trim();
  if (!channelId) throw new Error("Missing EPG channel id.");
  const fromMs = Number(payload?.fromMs);
  const toMs = Number(payload?.toMs);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) throw new Error("Invalid EPG time window.");

  const cacheKey = `${url}\0${channelId}\0${Math.floor(fromMs / 3_600_000)}`;
  const hit = epgProgrammeCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 25 * 60 * 1000) {
    return { ok: true, programmes: hit.programmes };
  }

  let scan = epgScanInflight.get(cacheKey);
  if (!scan) {
    scan = streamExtractProgrammes(url, channelId, fromMs, toMs).finally(() => {
      epgScanInflight.delete(cacheKey);
    });
    epgScanInflight.set(cacheKey, scan);
  }
  const programmes = await scan;
  epgProgrammeCache.set(cacheKey, { at: Date.now(), programmes });
  if (epgProgrammeCache.size > 80) {
    const oldest = epgProgrammeCache.keys().next().value;
    if (oldest) epgProgrammeCache.delete(oldest);
  }
  return { ok: true, programmes };
});

const epgChannelIndexCache = new Map();

/** Read only the `<channel>` section of a large XMLTV file (stops at first `<programme`). */
async function streamBuildEpgChannelIndex(url) {
  const hit = epgChannelIndexCache.get(url);
  if (hit && Date.now() - hit.at < 45 * 60 * 1000) {
    return hit.channelNames;
  }

  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: { "User-Agent": "IPTV-Player/1.0 (Electron)" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(`EPG HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("EPG response has no body.");
  }

  const decoder = new TextDecoder();
  let buf = "";
  const MAX_INDEX_BYTES = 12_000_000;
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      if (buf.includes("<programme") || buf.length >= MAX_INDEX_BYTES) break;
    }
  } finally {
    try {
      await res.body.cancel();
    } catch {
      /* ignore */
    }
  }

  const channelNames = {};
  const chRe = /<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/gi;
  let m;
  while ((m = chRe.exec(buf)) !== null) {
    const id = m[1]?.trim();
    if (!id) continue;
    const block = m[2] ?? "";
    const names = [];
    const dnRe = /<display-name[^>]*>([^<]*)<\/display-name>/gi;
    let dn;
    while ((dn = dnRe.exec(block)) !== null) {
      const t = dn[1]?.trim();
      if (t) names.push(t);
    }
    channelNames[id] = names.length ? names : [id];
  }

  epgChannelIndexCache.set(url, { at: Date.now(), channelNames });
  if (epgChannelIndexCache.size > 12) {
    const oldest = epgChannelIndexCache.keys().next().value;
    if (oldest) epgChannelIndexCache.delete(oldest);
  }
  return channelNames;
}

ipcMain.handle("iptv-fetch-epg-channel-index", async (_evt, rawUrl) => {
  const url = assertPlaylistUrlForMain(rawUrl);
  const channelNames = await streamBuildEpgChannelIndex(url);
  return { ok: true, channelNames };
});

function assertYoutubeSearchQuery(raw) {
  const s = String(raw ?? "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 180);
  if (!s) throw new Error("Empty search query.");
  return s;
}

function unescapeYoutubeTitleJsonFragment(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .replace(/\\n/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\u([0-9a-fA-F]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim()
    .slice(0, 280);
}

/** First organic result: video id + watch page title (for lyrics / display). */
function extractYoutubeFirstSearchResult(html) {
  const idx = html.indexOf('"videoRenderer":');
  if (idx === -1) return null;
  const slice = html.slice(idx, idx + 18_000);
  const vm = slice.match(/"videoId"\s*:\s*"([\w-]{11})"/);
  if (!vm) return null;
  const tm = slice.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"([^"]{1,600})"/);
  const titleRaw = tm ? tm[1] : "";
  const title = titleRaw ? unescapeYoutubeTitleJsonFragment(titleRaw) : "";
  return { videoId: vm[1], title: title || null };
}

ipcMain.handle("iptv-youtube-first-video-id", async (_evt, rawQuery) => {
  const q = assertYoutubeSearchQuery(rawQuery);
  const u = new URL("https://www.youtube.com/results");
  u.searchParams.set("search_query", q);
  u.searchParams.set("hl", "en");
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`YouTube returned HTTP ${res.status}.`);
  }
  const html = await res.text();
  if (!html.includes("videoRenderer")) {
    throw new Error(
      "Could not read YouTube search results (consent or network page). Try again in a moment or search on youtube.com manually."
    );
  }
  const meta = extractYoutubeFirstSearchResult(html);
  if (!meta?.videoId) {
    throw new Error("No video results found for that search.");
  }
  return { videoId: meta.videoId, title: meta.title };
});

function assertLyricsHttpGetUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Invalid URL.");
  }
  if (u.protocol !== "https:") throw new Error("Only https URLs are allowed.");
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (host === "lrclib.net" && path.startsWith("/api/")) return u.toString();
  if (host === "api.mymemory.translated.net" && path === "/get") return u.toString();
  throw new Error("URL host is not allowed for lyrics fetch.");
}

const MAX_ALBUM_ART_BYTES = 512 * 1024;

function normalizeItunesArtworkUrl(urlRaw) {
  const u = String(urlRaw ?? "").trim();
  if (!u.startsWith("https://")) return "";
  return u.replace(/100x100bb/g, "600x600bb").replace(/100x100/g, "600x600");
}

function scoreItunesHit(hit, artist, title) {
  if (!hit || typeof hit !== "object") return -1;
  const wantA = String(artist ?? "")
    .trim()
    .toLowerCase();
  const wantT = String(title ?? "")
    .trim()
    .toLowerCase();
  const a = String(hit.artistName ?? "")
    .toLowerCase();
  const t = String(hit.trackName ?? "")
    .toLowerCase();
  const coll = String(hit.collectionName ?? "")
    .toLowerCase();
  let score = 0;
  if (hit.artworkUrl100 || hit.artworkUrl60) score += 2;
  if (wantT && t === wantT) score += 12;
  else if (wantT && t.includes(wantT)) score += 8;
  if (wantA && a === wantA) score += 12;
  else if (wantA && a.includes(wantA)) score += 7;
  if (wantT && coll.includes(wantT)) score += 3;
  return score;
}

function pickItunesArtworkUrl(results, artist, title) {
  if (!Array.isArray(results) || !results.length) return "";
  let best = "";
  let bestScore = -1;
  for (const hit of results) {
    const score = scoreItunesHit(hit, artist, title);
    const url = normalizeItunesArtworkUrl(hit.artworkUrl100 || hit.artworkUrl60 || "");
    if (!url) continue;
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

async function itunesSearchArtworkUrl(artist, title, album, entity) {
  const parts = [artist, title, album].map((s) => String(s ?? "").trim()).filter(Boolean);
  const term = parts.join(" ").slice(0, 180);
  if (term.length < 2) return "";
  const u = new URL("https://itunes.apple.com/search");
  u.searchParams.set("term", term);
  u.searchParams.set("entity", entity);
  u.searchParams.set("limit", "8");
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return "";
  const data = await res.json();
  const results = data && typeof data === "object" ? data.results : null;
  return pickItunesArtworkUrl(results, artist, title);
}

function assertMzstaticImageUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error("Invalid artwork URL.");
  }
  if (u.protocol !== "https:") throw new Error("Artwork URL must be https.");
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".mzstatic.com")) throw new Error("Artwork host not allowed.");
  return u.toString();
}

ipcMain.handle("iptv-fetch-album-art-online", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const artist = typeof p.artist === "string" ? p.artist.trim().slice(0, 200) : "";
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  const album = typeof p.album === "string" ? p.album.trim().slice(0, 200) : "";
  if (!artist && !title && !album) {
    return { ok: false, error: "No artist or title for artwork lookup." };
  }
  try {
    let artUrl = await itunesSearchArtworkUrl(artist, title, album, "song");
    if (!artUrl) {
      artUrl = await itunesSearchArtworkUrl(artist, title, album, "album");
    }
    if (!artUrl) {
      return { ok: false, error: "No artwork found on iTunes." };
    }
    const safeUrl = assertMzstaticImageUrl(artUrl);
    const imgRes = await fetch(safeUrl, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "image/*", "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0" },
      signal: AbortSignal.timeout(25_000),
    });
    if (!imgRes.ok) {
      return { ok: false, error: `Artwork download HTTP ${imgRes.status}` };
    }
    const buf = await imgRes.arrayBuffer();
    if (!buf || buf.byteLength < 32) {
      return { ok: false, error: "Artwork file was empty." };
    }
    const trimmed = buf.byteLength > MAX_ALBUM_ART_BYTES ? buf.slice(0, MAX_ALBUM_ART_BYTES) : buf;
    const mimeRaw = imgRes.headers.get("content-type") || "image/jpeg";
    const mime = mimeRaw.split(";")[0].trim().toLowerCase() || "image/jpeg";
    return { ok: true, mime, data: trimmed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.slice(0, 200) };
  }
});

ipcMain.handle("iptv-http-get-json", async (_evt, rawUrl) => {
  const url = assertLyricsHttpGetUrl(rawUrl);
  let parsedHost = "";
  try {
    parsedHost = new URL(url).hostname.toLowerCase();
  } catch {
    /* assertLyricsHttpGetUrl already validated */
  }
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    signal: AbortSignal.timeout(35_000),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 429 && parsedHost === "api.mymemory.translated.net") {
      throw new Error(
        "MyMemory free quota exceeded (HTTP 429). Add Google Cloud or Azure Translator in app settings, wait, or try again later."
      );
    }
    throw new Error(text ? `HTTP ${res.status}: ${text.slice(0, 160).replace(/\s+/g, " ")}` : `HTTP ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Lyrics service returned non-JSON.");
  }
});

async function postLibreTranslateToUrl(urlStr, bodyObj) {
  const res = await fetch(urlStr, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`LibreTranslate returned non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const err =
      typeof data === "object" && data && typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
    throw new Error(String(err).slice(0, 200));
  }
  if (typeof data.translatedText !== "string") {
    throw new Error("LibreTranslate response missing translatedText.");
  }
  return data.translatedText;
}

/** Same parsing as `src/utils/parseGoogleGtxTranslate.ts` (kept inline: main is CommonJS). */
function parseGoogleGtxTranslateMain(data) {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Bad Google Translate response.");
  }
  const head = data[0];
  if (!Array.isArray(head)) {
    throw new Error("Bad Google Translate response.");
  }
  let out = "";
  for (const item of head) {
    if (Array.isArray(item) && typeof item[0] === "string") {
      out += item[0];
    }
  }
  if (!out) {
    throw new Error("Google Translate response had no text.");
  }
  return out;
}

function normalizeTranslateLangCode(raw, fallback = "en") {
  const t = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(t)) return fallback;
  return t;
}

async function fetchGoogleGtxTranslated(q, sl, tl = "en") {
  const u = new URL("https://translate.googleapis.com/translate_a/single");
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", normalizeTranslateLangCode(sl, "auto"));
  u.searchParams.set("tl", normalizeTranslateLangCode(tl, "en"));
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", q);
  const res = await fetch(u.toString(), {
    method: "GET",
    redirect: "follow",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Google Translate HTTP ${res.status}`);
  }
  const cleaned = text.replace(/^\)\]\}'\d*\n?/, "").trimStart();
  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    throw new Error("Google Translate returned non-JSON.");
  }
  return parseGoogleGtxTranslateMain(data);
}

const LYRICS_CHAT_KEY_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-api-key.txt");
const LYRICS_CHAT_BASE_URL_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-base-url.txt");
const LYRICS_CHAT_MODEL_PATH = () => path.join(app.getPath("userData"), "lyrics-chat-translate-model.txt");
const GEMINI_KEY_PATH = () => path.join(app.getPath("userData"), "gemini-api-key.txt");
const GEMINI_MODEL_PATH = () => path.join(app.getPath("userData"), "gemini-model.txt");

function getLyricsChatTranslateApiKey() {
  // Priority: saved Settings file → `.env` / shell env. This lets users test an in-app key
  // without restarting Electron after editing `.env`.
  const saved = getSavedLyricsChatTranslateApiKey();
  if (saved) return saved;
  return getLyricsChatTranslateEnvApiKey();
}

function getLyricsChatTranslateEnvApiKey() {
  return String(
    process.env.DEEPSEEK_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.OPENAI_COMPATIBLE_LYRICS_API_KEY ??
      ""
  ).trim();
}

function getSavedLyricsChatTranslateApiKey() {
  return readSavedLyricsChatText(LYRICS_CHAT_KEY_PATH);
}

function getSavedGeminiApiKey() {
  return readSavedLyricsChatText(GEMINI_KEY_PATH);
}

function readSavedLyricsChatText(pathFn) {
  try {
    const p = pathFn();
    if (fs.existsSync(p)) {
      const t = String(fs.readFileSync(p, "utf8") ?? "").trim();
      if (t) return t;
    }
  } catch {
    /* noop */
  }
  return "";
}

function maskApiKeyForPreview(raw) {
  const key = String(raw ?? "").trim();
  if (!key) return "";
  if (key.length <= 6) return "x".repeat(key.length);
  return `${key.slice(0, 3)}${"x".repeat(Math.max(4, key.length - 6))}${key.slice(-3)}`;
}

function getLyricsChatTranslateKeyStatusDetails() {
  const envKey = getLyricsChatTranslateEnvApiKey();
  const savedKey = getSavedLyricsChatTranslateApiKey();
  const activeKey = savedKey || envKey;
  return {
    key: activeKey,
    keySource: savedKey ? "app" : envKey ? "env" : "",
    keyPreview: maskApiKeyForPreview(activeKey),
  };
}

function getGeminiApiKeyFromEnv() {
  return String(
    process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_AI_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
      ""
  ).trim();
}

function getGeminiApiKey() {
  const saved = getSavedGeminiApiKey();
  if (saved) return saved;
  return getGeminiApiKeyFromEnv();
}

function getGeminiKeyStatusDetails() {
  const envKey = getGeminiApiKeyFromEnv();
  const savedKey = getSavedGeminiApiKey();
  const activeKey = savedKey || envKey;
  return {
    key: activeKey,
    keySource: savedKey ? "app" : envKey ? "env" : "",
    keyPreview: maskApiKeyForPreview(activeKey),
  };
}

function getLyricsChatTranslateBaseUrlRaw() {
  if (getSavedLyricsChatTranslateApiKey()) {
    return readSavedLyricsChatText(LYRICS_CHAT_BASE_URL_PATH);
  }
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_BASE_URL ?? "").trim();
  if (fromEnv) return fromEnv;
  return readSavedLyricsChatText(LYRICS_CHAT_BASE_URL_PATH);
}

function getLyricsChatTranslateModelRaw() {
  if (getSavedLyricsChatTranslateApiKey()) {
    return readSavedLyricsChatText(LYRICS_CHAT_MODEL_PATH);
  }
  const fromEnv = String(process.env.OPENAI_COMPATIBLE_LYRICS_MODEL ?? "").trim();
  if (fromEnv) return fromEnv;
  return readSavedLyricsChatText(LYRICS_CHAT_MODEL_PATH);
}

function getGeminiModelRaw() {
  const savedKey = getSavedGeminiApiKey();
  const raw = savedKey
    ? readSavedLyricsChatText(GEMINI_MODEL_PATH)
    : String(process.env.GEMINI_MODEL ?? process.env.GOOGLE_AI_MODEL ?? "").trim() ||
      readSavedLyricsChatText(GEMINI_MODEL_PATH);
  const core = (raw || "gemini-2.5-flash").replace(/^models\//, "");
  if (core.length > 96 || !/^[a-zA-Z0-9._-]+$/.test(core)) {
    throw new Error("Invalid Gemini model id.");
  }
  return core;
}

function assertLyricsChatApiKeyInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  if (t.length < 8 || t.length > 512 || /[\s\x00-\x1f]/.test(t)) {
    throw new Error("API key looks invalid (length or characters).");
  }
  return t;
}

function assertLyricsChatBaseUrlInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  let u;
  try {
    u = new URL(t);
  } catch {
    throw new Error("Base URL is not a valid URL.");
  }
  if (u.protocol !== "https:") {
    throw new Error("Base URL must use https.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]") {
    throw new Error("Base URL host is not allowed.");
  }
  return u.toString().replace(/\/+$/, "");
}

function assertLyricsChatModelInput(raw) {
  const t = typeof raw === "string" ? raw.trim() : "";
  if (!t) return "";
  if (t.length > 80 || !/^[a-zA-Z0-9._-]+$/.test(t)) {
    throw new Error("Model id looks invalid.");
  }
  return t;
}

const DEEPSEEK_LLM_BASE = "https://api.deepseek.com";
const OPENAI_LLM_BASE = "https://api.openai.com/v1";

function savedCompatibleBaseLower() {
  return String(getLyricsChatTranslateBaseUrlRaw() || "").trim().toLowerCase();
}

function isOpenAiCompatibleBase(baseLower) {
  return baseLower.includes("openai.com");
}

/** DeepSeek slot: saved key with non-OpenAI base, or `DEEPSEEK_API_KEY` in env. */
function resolveDeepSeekLlmSlot() {
  const saved = getSavedLyricsChatTranslateApiKey();
  const baseLower = savedCompatibleBaseLower();
  const model = getLyricsChatTranslateModelRaw() || "deepseek-chat";
  if (saved && !isOpenAiCompatibleBase(baseLower)) {
    const baseUrl = getLyricsChatTranslateBaseUrlRaw() || DEEPSEEK_LLM_BASE;
    let host = "api.deepseek.com";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* keep default */
    }
    return { id: "deepseek", label: "DeepSeek", apiKey: saved, baseUrl, model, host };
  }
  const envKey = String(process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (envKey) {
    return {
      id: "deepseek",
      label: "DeepSeek",
      apiKey: envKey,
      baseUrl: DEEPSEEK_LLM_BASE,
      model: "deepseek-chat",
      host: "api.deepseek.com",
    };
  }
  return null;
}

/** OpenAI slot: saved key with OpenAI base, or `OPENAI_*` env when DeepSeek env is unset. */
function resolveOpenAiLlmSlot() {
  const saved = getSavedLyricsChatTranslateApiKey();
  const baseLower = savedCompatibleBaseLower();
  const model = getLyricsChatTranslateModelRaw() || "gpt-4o-mini";
  if (saved && isOpenAiCompatibleBase(baseLower)) {
    const baseUrl = getLyricsChatTranslateBaseUrlRaw() || OPENAI_LLM_BASE;
    let host = "api.openai.com";
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      /* keep default */
    }
    return { id: "openai", label: "OpenAI", apiKey: saved, baseUrl, model, host };
  }
  const envKey = String(
    process.env.OPENAI_API_KEY ?? process.env.OPENAI_COMPATIBLE_LYRICS_API_KEY ?? ""
  ).trim();
  if (envKey && !String(process.env.DEEPSEEK_API_KEY ?? "").trim()) {
    return {
      id: "openai",
      label: "OpenAI",
      apiKey: envKey,
      baseUrl: OPENAI_LLM_BASE,
      model: "gpt-4o-mini",
      host: "api.openai.com",
    };
  }
  return null;
}

function resolveGeminiLlmSlot() {
  const apiKey = getGeminiApiKey();
  if (!apiKey) return null;
  let model = "gemini-2.5-flash";
  try {
    model = getGeminiModelRaw();
  } catch {
    /* keep default */
  }
  return {
    id: "gemini",
    label: "Google Gemini",
    apiKey,
    host: "generativelanguage.googleapis.com",
    model,
  };
}

/** App-wide order: DeepSeek → Gemini → OpenAI. */
function listLlmProvidersInOrder(opts = {}) {
  const skipGemini = opts.skipGemini === true;
  const out = [];
  const deepseek = resolveDeepSeekLlmSlot();
  if (deepseek) out.push(deepseek);
  if (!skipGemini) {
    const gemini = resolveGeminiLlmSlot();
    if (gemini) out.push(gemini);
  }
  const openai = resolveOpenAiLlmSlot();
  if (openai) out.push(openai);
  return out;
}

function firstLlmProviderInOrder(opts = {}) {
  return listLlmProvidersInOrder(opts)[0] ?? null;
}

function llmMetaFromSlot(slot, purpose) {
  if (!slot) return { llmModel: "", llmHost: "", llmPurpose: purpose };
  if (slot.id === "gemini") {
    return {
      llmModel: slot.model,
      llmHost: slot.host,
      llmPurpose: `${purpose} (${slot.label})`,
    };
  }
  return {
    llmModel: slot.model,
    llmHost: slot.host,
    llmPurpose: `${purpose} (${slot.label})`,
  };
}

/** Build `…/v1/chat/completions` from API root (DeepSeek, OpenAI, OpenRouter, etc.). */
function lyricsChatCompletionsEndpoint(baseRaw) {
  const defaultBase = "https://api.deepseek.com";
  const raw = String(baseRaw ?? "").trim() || defaultBase;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid base URL.");
  }
  if (u.protocol !== "https:") {
    throw new Error("Base URL must be https.");
  }
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1") {
    throw new Error("Base URL host is not allowed.");
  }
  let path = u.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path)) {
    return `${u.origin}${path}`;
  }
  if (!path) {
    return `${u.origin}/v1/chat/completions`;
  }
  if (path.endsWith("/v1")) {
    return `${u.origin}${path}/chat/completions`;
  }
  return `${u.origin}${path}/v1/chat/completions`;
}

function stripLlmMarkdownFences(text) {
  let t = String(text ?? "").trim();
  if (!t) return t;
  const block = /^```(?:[a-zA-Z0-9_-]*)?\r?\n([\s\S]*?)\r?\n```\s*$/;
  const m = t.match(block);
  if (m) return m[1].trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-zA-Z0-9_-]*\r?\n?/, "").replace(/\r?\n?```\s*$/u, "").trim();
  }
  return t;
}

function getLyricsLlmConfig() {
  const slot = firstLlmProviderInOrder();
  if (slot) return { model: slot.model, host: slot.host };
  return { model: "deepseek-chat", host: "api.deepseek.com" };
}

/** Human-readable error: which feature failed and which model/host was used. */
function formatLyricsLlmError(purpose, message) {
  const { model, host } = getLyricsLlmConfig();
  const clean = String(message ?? "")
    .replace(/^LLM(\s*\([^)]*\))?:\s*/i, "")
    .replace(/\s*\[model:[^\]]+\]\s*$/i, "")
    .trim();
  return `LLM (${purpose}): ${clean || "request failed"} [model: ${model} @ ${host}]`;
}

function lyricsLlmMetaFields(purpose, slot) {
  const s = slot || firstLlmProviderInOrder();
  return llmMetaFromSlot(s, purpose);
}

async function postLyricsLlmChatCompletionForSlot(slot, bodyObj, purpose = "LLM request") {
  if (!slot?.apiKey) {
    throw new Error("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY");
  }
  const endpoint = lyricsChatCompletionsEndpoint(slot.baseUrl || DEEPSEEK_LLM_BASE);
  const model =
    typeof bodyObj.model === "string" && bodyObj.model.trim() ? bodyObj.model.trim() : slot.model;
  const body = JSON.stringify({ ...bodyObj, model });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${slot.apiKey}`,
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });
  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`LLM: non-JSON (HTTP ${res.status}).`);
  }
  if (!res.ok) {
    const msg =
      data && typeof data === "object" && data.error && typeof data.error.message === "string"
        ? data.error.message
        : bodyText.slice(0, 280).replace(/\s+/g, " ");
    throw new Error(formatLyricsLlmError(purpose, msg));
  }
  const choice = data && typeof data === "object" ? data.choices : null;
  const first = Array.isArray(choice) && choice.length ? choice[0] : null;
  const msgObj = first && typeof first === "object" ? first.message : null;
  const content =
    msgObj && typeof msgObj === "object" && typeof msgObj.content === "string" ? msgObj.content : null;
  if (!content || !String(content).trim()) {
    throw new Error("LLM: empty content.");
  }
  return stripLlmMarkdownFences(content);
}

/** Try DeepSeek → Gemini → OpenAI chat completions; returns first success. */
async function tryChatCompletionInProviderOrder(bodyObj, purpose = "LLM request", opts = {}) {
  const providers = listLlmProvidersInOrder(opts);
  if (!providers.length) {
    throw new Error("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY");
  }
  let lastErr;
  for (const slot of providers) {
    try {
      const text = await postLyricsLlmChatCompletionForSlot(slot, bodyObj, purpose);
      return { text, slot, meta: llmMetaFromSlot(slot, purpose) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function postLyricsLlmChatCompletion(bodyObj, purpose = "LLM request") {
  const { text } = await tryChatCompletionInProviderOrder(bodyObj, purpose);
  return text;
}

/** Text generation with provider order (chat slots + Gemini). */
async function tryLlmTextInProviderOrder({
  system,
  user,
  purpose,
  chatBody = {},
  geminiGenerationConfig = {},
  skipGemini = false,
}) {
  const providers = listLlmProvidersInOrder({ skipGemini });
  if (!providers.length) {
    throw new Error("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY");
  }
  let lastErr;
  for (const slot of providers) {
    try {
      if (slot.id === "gemini") {
        const text = await postGeminiGenerateContent(system, user, purpose, geminiGenerationConfig);
        return { text, slot, meta: llmMetaFromSlot(slot, purpose) };
      }
      const text = await postLyricsLlmChatCompletionForSlot(
        slot,
        {
          ...chatBody,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        purpose
      );
      return { text, slot, meta: llmMetaFromSlot(slot, purpose) };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function parseLlmUnifiedLyricsJsonText(text, displayName) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    const i = text.indexOf("{");
    const j = text.lastIndexOf("}");
    if (i < 0 || j <= i) {
      throw new Error("LLM unified: response was not valid JSON.");
    }
    obj = JSON.parse(text.slice(i, j + 1));
  }
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "Bad JSON root", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  if (obj.ok !== true) {
    const msg = typeof obj.message === "string" ? obj.message.trim().slice(0, 220) : "No lyrics from model.";
    return { ok: false, error: msg, pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  const pairsIn = obj.pairs;
  if (!Array.isArray(pairsIn) || pairsIn.length === 0) {
    return { ok: false, error: "Model returned no lyric lines.", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  const pairs = [];
  const maxLines = 120;
  for (let i = 0; i < Math.min(pairsIn.length, maxLines); i++) {
    const row = pairsIn[i];
    if (!row || typeof row !== "object") continue;
    const orig = typeof row.orig === "string" ? row.orig.replace(/\r\n/g, "\n").trimEnd() : "";
    let en = typeof row.en === "string" ? row.en.replace(/\r\n/g, "\n").trimEnd() : "";
    if (!orig) continue;
    if (!en) en = orig;
    pairs.push({ orig, en });
  }
  if (!pairs.length) {
    return { ok: false, error: "No valid orig/en pairs.", pairs: [], detectedFranc3: "und", headline: "", lrclibTrack: "" };
  }
  let detected = typeof obj.detectedFranc3 === "string" ? obj.detectedFranc3.trim().toLowerCase() : "und";
  if (!/^[a-z]{3}$/.test(detected)) detected = "und";
  const lrclibTrack =
    typeof obj.lrclibTrack === "string" && obj.lrclibTrack.trim()
      ? obj.lrclibTrack.trim().slice(0, 240)
      : String(displayName ?? "").trim().slice(0, 240) || "LLM";
  const headlineBase =
    typeof obj.headline === "string" && obj.headline.trim()
      ? obj.headline.trim().slice(0, 200)
      : lrclibTrack;
  const headline = `LLM: ${headlineBase} · find + translate in one step (verify; may differ from official lyrics)`;
  return { ok: true, error: "", pairs, detectedFranc3: detected, headline, lrclibTrack };
}

function buildLyricsIdentityUserPrompt(p, extraLines = []) {
  const metaArtist = typeof p.metaArtist === "string" ? p.metaArtist.trim().slice(0, 200) : "";
  const metaTitle = typeof p.metaTitle === "string" ? p.metaTitle.trim().slice(0, 200) : "";
  const metaAlbum = typeof p.metaAlbum === "string" ? p.metaAlbum.trim().slice(0, 200) : "";
  const displayName = typeof p.displayName === "string" ? p.displayName.trim().slice(0, 400) : "";
  const sourceFileName = typeof p.sourceFileName === "string" ? p.sourceFileName.trim().slice(0, 240) : "";
  const altArtist = typeof p.altArtist === "string" ? p.altArtist.trim().slice(0, 200) : "";
  const altTitle = typeof p.altTitle === "string" ? p.altTitle.trim().slice(0, 200) : "";
  const playerHeaderLabel =
    typeof p.playerHeaderLabel === "string" ? p.playerHeaderLabel.trim().slice(0, 240) : "";
  const durationSec =
    typeof p.durationSec === "number" && Number.isFinite(p.durationSec) && p.durationSec >= 0
      ? Math.floor(p.durationSec)
      : null;
  const altLine =
    altArtist || altTitle
      ? `Alternative artist/title from file or library name (use when tags look corrupted or misspelled): ${[altArtist, altTitle].filter(Boolean).join(" - ")}`
      : "";

  const panelHeader =
    playerHeaderLabel ||
    (metaArtist && metaTitle ? `${metaArtist} — ${metaTitle}` : metaTitle || metaArtist || "");

  return [
    displayName ? `Library display name: ${displayName}` : "",
    panelHeader ? `Name shown at top of lyrics panel: ${panelHeader}` : "",
    `Artist from file tags (ID3 / FLAC Vorbis / MP4): ${metaArtist || "unknown"}`,
    `Title from file tags: ${metaTitle || "unknown"}`,
    metaAlbum ? `Album from file tags: ${metaAlbum}` : "",
    sourceFileName ? `Original file name on disk: ${sourceFileName}` : "",
    altLine,
    `Approximate duration (seconds): ${durationSec != null ? String(durationSec) : "unknown"}`,
    "",
    "Use the library display name and lyrics panel title above when they match what a listener would search (e.g. on Google).",
    "Identify the correct song using the tagged artist and title when they look trustworthy.",
    'If the tagged title looks misspelled, garbled, or not a real song title, prefer the library display name, panel title, file name, or alternative artist/title above (same spelling as a Google search: "Artist - Title").',
    "Return lyrics only for that exact recording, not a remix, live version, or different song unless clearly indicated.",
    ...extraLines,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseGeminiLyricsMeaningJsonText(text, displayName) {
  let obj;
  const raw = stripLlmMarkdownFences(text);
  try {
    obj = JSON.parse(raw);
  } catch (firstErr) {
    const i = raw.indexOf("{");
    const j = raw.lastIndexOf("}");
    if (i < 0 || j <= i) {
      throw new Error("Gemini lyrics: response was not valid JSON.");
    }
    try {
      obj = JSON.parse(raw.slice(i, j + 1));
    } catch {
      const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(`Gemini lyrics: response JSON was malformed (${detail}). Try Gemini lyrics again.`);
    }
  }
  const parsed = parseLlmUnifiedLyricsJsonText(JSON.stringify(obj), displayName);
  const meaning =
    obj && typeof obj === "object" && typeof obj.meaning === "string"
      ? obj.meaning.trim().slice(0, 6000)
      : "";
  return { ...parsed, meaning };
}

function previewLyricsChatBaseHost() {
  const base = getLyricsChatTranslateBaseUrlRaw();
  try {
    if (base) return new URL(base).host;
    return "api.deepseek.com (default)";
  } catch {
    return "(invalid saved URL)";
  }
}

function previewGeminiModel(hasGeminiKey) {
  if (!hasGeminiKey) return "";
  try {
    return getGeminiModelRaw();
  } catch {
    return "(invalid model)";
  }
}

ipcMain.handle("iptv-lyrics-chat-translate-key-status", async () => {
  const deepseek = resolveDeepSeekLlmSlot();
  const openai = resolveOpenAiLlmSlot();
  const geminiStatus = getGeminiKeyStatusDetails();
  const hasGeminiKey = !!geminiStatus.key;
  const hasDeepSeekKey = !!deepseek;
  const hasOpenAiKey = !!openai;
  const hasCompatibleKey = hasDeepSeekKey || hasOpenAiKey;
  const primary = firstLlmProviderInOrder();
  const primaryPreview =
    primary?.id === "gemini"
      ? geminiStatus.keyPreview
      : primary
        ? maskApiKeyForPreview(primary.apiKey)
        : "";
  const primarySource =
    primary?.id === "gemini"
      ? geminiStatus.keySource
      : primary?.id === "deepseek"
        ? deepseek && getSavedLyricsChatTranslateApiKey()
          ? "app"
          : process.env.DEEPSEEK_API_KEY
            ? "env"
            : ""
        : primary?.id === "openai"
          ? openai && getSavedLyricsChatTranslateApiKey()
            ? "app"
            : "env"
          : "";
  return {
    hasKey: hasCompatibleKey,
    hasDeepSeekKey,
    hasOpenAiKey,
    hasSongMeaningKey: hasCompatibleKey || hasGeminiKey,
    primaryLlmProvider: primary?.id ?? "",
    hasGeminiFromEnv: geminiStatus.keySource === "env",
    hasGeminiKey,
    geminiKeyPreview: geminiStatus.keyPreview,
    geminiKeySource: geminiStatus.keySource,
    geminiModelPreview: previewGeminiModel(hasGeminiKey),
    keyPreview: primaryPreview,
    keySource: primarySource,
    apiBasePreview: primary ? `${primary.host} (${primary.label})` : previewLyricsChatBaseHost(),
    modelPreview: primary?.model || "deepseek-chat (default)",
  };
});

ipcMain.handle("iptv-lyrics-chat-translate-save-credentials", async (_evt, raw) => {
  const p = raw && typeof raw === "object" ? raw : {};
  const hasOpenAiPayload =
    Object.prototype.hasOwnProperty.call(p, "key") ||
    Object.prototype.hasOwnProperty.call(p, "baseUrl") ||
    Object.prototype.hasOwnProperty.call(p, "model");
  const hasGeminiPayload =
    Object.prototype.hasOwnProperty.call(p, "geminiKey") ||
    Object.prototype.hasOwnProperty.call(p, "geminiModel");
  if (hasGeminiPayload && !hasOpenAiPayload) {
    const geminiKey = assertLyricsChatApiKeyInput(typeof p.geminiKey === "string" ? p.geminiKey : "");
    const geminiModel = assertLyricsChatModelInput(typeof p.geminiModel === "string" ? p.geminiModel : "");
    if (!geminiKey) {
      try {
        fs.unlinkSync(GEMINI_KEY_PATH());
      } catch {
        /* missing */
      }
      try {
        fs.unlinkSync(GEMINI_MODEL_PATH());
      } catch {
        /* missing */
      }
    } else {
      fs.writeFileSync(GEMINI_KEY_PATH(), geminiKey, "utf8");
      if (geminiModel) fs.writeFileSync(GEMINI_MODEL_PATH(), geminiModel, "utf8");
      else {
        try {
          fs.unlinkSync(GEMINI_MODEL_PATH());
        } catch {
          /* missing */
        }
      }
    }
    const openAi = getLyricsChatTranslateKeyStatusDetails();
    const gemini = getGeminiKeyStatusDetails();
    return {
      ok: true,
      hasKey: !!openAi.key,
      keyPreview: openAi.keyPreview,
      keySource: openAi.keySource,
      apiBasePreview: previewLyricsChatBaseHost(),
      modelPreview: getLyricsChatTranslateModelRaw() || "deepseek-chat (default)",
      hasSongMeaningKey: !!openAi.key || !!gemini.key,
      hasGeminiKey: !!gemini.key,
      geminiKeyPreview: gemini.keyPreview,
      geminiKeySource: gemini.keySource,
      geminiModelPreview: previewGeminiModel(!!gemini.key),
    };
  }
  const key = assertLyricsChatApiKeyInput(typeof p.key === "string" ? p.key : "");
  const baseUrl = assertLyricsChatBaseUrlInput(typeof p.baseUrl === "string" ? p.baseUrl : "");
  const model = assertLyricsChatModelInput(typeof p.model === "string" ? p.model : "");
  const keyPath = LYRICS_CHAT_KEY_PATH();
  const basePath = LYRICS_CHAT_BASE_URL_PATH();
  const modelPath = LYRICS_CHAT_MODEL_PATH();
  if (!key) {
    try {
      fs.unlinkSync(keyPath);
    } catch {
      /* missing */
    }
    try {
      fs.unlinkSync(basePath);
    } catch {
      /* missing */
    }
    try {
      fs.unlinkSync(modelPath);
    } catch {
      /* missing */
    }
    const active = getLyricsChatTranslateKeyStatusDetails();
    const gemini = getGeminiKeyStatusDetails();
    const base = getLyricsChatTranslateBaseUrlRaw();
    const modelAfterClear = getLyricsChatTranslateModelRaw();
    let apiBasePreviewAfterClear = "";
    try {
      if (base) {
        apiBasePreviewAfterClear = new URL(base).host;
      } else if (active.key) {
        apiBasePreviewAfterClear = "api.deepseek.com (default)";
      }
    } catch {
      apiBasePreviewAfterClear = "(invalid saved URL)";
    }
    return {
      ok: true,
      hasKey: !!active.key,
      keyPreview: active.keyPreview,
      keySource: active.keySource,
      hasSongMeaningKey: !!active.key || !!gemini.key,
      hasGeminiKey: !!gemini.key,
      geminiKeyPreview: gemini.keyPreview,
      geminiKeySource: gemini.keySource,
      geminiModelPreview: previewGeminiModel(!!gemini.key),
      apiBasePreview: apiBasePreviewAfterClear,
      modelPreview: active.key ? modelAfterClear || "deepseek-chat (default)" : "",
    };
  }
  fs.writeFileSync(keyPath, key, "utf8");
  if (baseUrl) {
    fs.writeFileSync(basePath, baseUrl, "utf8");
  } else {
    try {
      fs.unlinkSync(basePath);
    } catch {
      /* missing */
    }
  }
  if (model) {
    fs.writeFileSync(modelPath, model, "utf8");
  } else {
    try {
      fs.unlinkSync(modelPath);
    } catch {
      /* missing */
    }
  }
  const active = getLyricsChatTranslateKeyStatusDetails();
  const gemini = getGeminiKeyStatusDetails();
  let apiBasePreview = "";
  try {
    const u = new URL(baseUrl || "https://api.deepseek.com");
    apiBasePreview = u.host;
  } catch {
    apiBasePreview = "";
  }
  return {
    ok: true,
    hasKey: !!active.key,
    keyPreview: active.keyPreview,
    keySource: active.keySource,
    hasSongMeaningKey: !!active.key || !!gemini.key,
    hasGeminiKey: !!gemini.key,
    geminiKeyPreview: gemini.keyPreview,
    geminiKeySource: gemini.keySource,
    geminiModelPreview: previewGeminiModel(!!gemini.key),
    apiBasePreview,
    modelPreview: model || "deepseek-chat (default)",
  };
});

/**
 * OpenAI-compatible `POST /v1/chat/completions` (DeepSeek, OpenAI, OpenRouter, etc.).
 * Key: `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, or `OPENAI_COMPATIBLE_LYRICS_API_KEY`, or saved file.
 */
ipcMain.handle("iptv-lyrics-llm-unified-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const displayName = typeof p.displayName === "string" ? p.displayName.trim() : "";
  if (!displayName || displayName.length > 400) {
    throw new Error("Invalid display name for LLM lyrics.");
  }
  const system = [
    "You help a music player show bilingual song lyrics.",
    "You must respond with ONLY a single JSON object (no markdown fences, no commentary before or after).",
    'Shape A success: {"ok":true,"detectedFranc3":"spa","lrclibTrack":"Artist — Title","headline":"short label","pairs":[{"orig":"line in original language","en":"English line"},...]}',
    'Shape B failure: {"ok":false,"message":"one short reason","pairs":[]}',
    "detectedFranc3 must be ISO 639-3 (three lowercase letters) when you can infer language, else use \"und\".",
    "pairs: each object needs \"orig\" and \"en\" strings; same number of logical lines; no empty orig.",
    "If you are not confident you have the correct official lyrics for that exact artist and title, set ok:false.",
    "Never substitute lyrics from a different song by the same artist or a similarly titled track.",
    "Do not exceed 120 pairs. No LRC timestamps in strings.",
  ].join(" ");

  const user = buildLyricsIdentityUserPrompt(p, [
    "Find the best-matching official lyrics, then supply each line in the original language with an accurate English translation in the same array position.",
  ]);

  const llmPurpose = "lyrics find + translate";
  try {
    const { text: rawText, meta } = await tryChatCompletionInProviderOrder(
      {
        temperature: 0.2,
        max_tokens: 8192,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      },
      llmPurpose
    );
    const parsed = parseLlmUnifiedLyricsJsonText(rawText, displayName);
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.pairs) || !parsed.pairs.length) {
      return { ...parsed, ...meta };
    }
    return { ...parsed, ...meta };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) throw e;
    const fallbackMeta = lyricsLlmMetaFields(llmPurpose);
    return {
      ok: false,
      error: msg.includes("[model:") ? msg : formatLyricsLlmError(llmPurpose, msg),
      pairs: [],
      detectedFranc3: "und",
      headline: "",
      lrclibTrack: "",
      ...fallbackMeta,
    };
  }
});

/**
 * @returns `{ text }` — throws on HTTP / empty model output
 */
async function postGeminiGenerateContent(systemPrompt, userPrompt, purpose, generationConfig = {}) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    throw new Error("IPTV_GEMINI_NO_KEY");
  }
  const modelId = getGeminiModelRaw();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:generateContent`;

  const body = {
    systemInstruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: userPrompt }],
      },
    ],
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 1024,
      ...generationConfig,
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-goog-api-key": apiKey,
      "User-Agent": "RJ-IPTV-and-Online-Radio-Player/1.0",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  const bodyText = await res.text();
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error(`Gemini: non-JSON (HTTP ${res.status}).`);
  }

  if (!res.ok) {
    const gm =
      data && typeof data === "object" && data.error && typeof data.error.message === "string"
        ? data.error.message
        : bodyText.slice(0, 240).replace(/\s+/g, " ");
    throw new Error(`Gemini (${purpose}): ${gm || `HTTP ${res.status}`} [model: ${modelId} @ generativelanguage.googleapis.com]`);
  }

  const cand = Array.isArray(data?.candidates) && data.candidates.length ? data.candidates[0] : null;
  const parts =
    cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const texts = [];
  for (const part of parts) {
    if (part && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
  }
  const combined = texts.join("\n").trim();
  if (!combined) {
    throw new Error(
      `Gemini (${purpose}): empty or blocked response [model: ${modelId} @ generativelanguage.googleapis.com]`
    );
  }
  return stripLlmMarkdownFences(combined);
}

async function postGeminiGenerateSongMeaning(systemPrompt, userPrompt) {
  return postGeminiGenerateContent(systemPrompt, userPrompt, "song meaning", {
    temperature: 0.35,
    maxOutputTokens: 1024,
  });
}

async function postGeminiChannelEpg(systemPrompt, userPrompt) {
  return postGeminiGenerateContent(systemPrompt, userPrompt, "TV EPG", {
    temperature: 0.25,
    maxOutputTokens: 2048,
  });
}

ipcMain.handle("iptv-lyrics-gemini-unified-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const displayName = typeof p.displayName === "string" ? p.displayName.trim() : "";
  if (!displayName || displayName.length > 400) {
    throw new Error("Invalid display name for Gemini lyrics.");
  }
  const system = [
    "You help a music player show bilingual song lyrics and a short song meaning.",
    "You must respond with ONLY a single JSON object (no markdown fences, no commentary before or after).",
    'Success shape: {"ok":true,"detectedFranc3":"spa","lrclibTrack":"Artist — Title","headline":"short label","pairs":[{"orig":"line in original language","en":"English line"},...],"meaning":"2-4 short English paragraphs explaining the song"}',
    'Failure shape: {"ok":false,"message":"one short reason","pairs":[],"meaning":""}',
    "detectedFranc3 must be ISO 639-3 (three lowercase letters) when you can infer language, else use \"und\".",
    "pairs: each object needs \"orig\" and \"en\" strings; same number of logical lines; no empty orig.",
    "If you are not confident you have the correct official lyrics, set ok:false.",
    "Do not exceed 120 pairs. No LRC timestamps in strings. Do not quote or invent full extra lyrics in meaning.",
  ].join(" ");
  const user = buildLyricsIdentityUserPrompt(p, [
    "Find the best-matching official lyrics, translate each line to English, and include a concise explanation of what the song is about.",
  ]);
  const purpose = "lyrics find + translate + meaning (Google Gemini)";
  try {
    const rawText = await postGeminiGenerateContent(system, user, purpose, {
      temperature: 0.2,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          ok: { type: "BOOLEAN" },
          detectedFranc3: { type: "STRING" },
          lrclibTrack: { type: "STRING" },
          headline: { type: "STRING" },
          pairs: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                orig: { type: "STRING" },
                en: { type: "STRING" },
              },
              required: ["orig", "en"],
            },
          },
          meaning: { type: "STRING" },
          message: { type: "STRING" },
        },
        required: ["ok", "pairs"],
      },
    });
    const parsed = parseGeminiLyricsMeaningJsonText(rawText, displayName);
    const model = getGeminiModelRaw();
    return {
      ...parsed,
      llmPurpose: "lyrics find + translate (Google Gemini)",
      llmModel: model,
      llmHost: "generativelanguage.googleapis.com",
      songMeaningLlmPurpose: "song meaning (Google Gemini)",
      songMeaningLlmModel: model,
      songMeaningLlmHost: "generativelanguage.googleapis.com",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_GEMINI_NO_KEY")) throw e;
    return {
      ok: false,
      error: msg.slice(0, 440),
      pairs: [],
      detectedFranc3: "und",
      headline: "",
      lrclibTrack: "",
      meaning: "",
      llmPurpose: "lyrics find + translate (Google Gemini)",
      llmModel: previewGeminiModel(true),
      llmHost: "generativelanguage.googleapis.com",
      songMeaningLlmPurpose: "song meaning (Google Gemini)",
      songMeaningLlmModel: previewGeminiModel(true),
      songMeaningLlmHost: "generativelanguage.googleapis.com",
    };
  }
});

ipcMain.handle("iptv-lyrics-song-meaning-fetch", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const artist = typeof p.artist === "string" ? p.artist.trim().slice(0, 200) : "";
  const title = typeof p.title === "string" ? p.title.trim().slice(0, 200) : "";
  const album = typeof p.album === "string" ? p.album.trim().slice(0, 200) : "";
  const displayName = typeof p.displayName === "string" ? p.displayName.trim().slice(0, 400) : "";
  const forceOpenAiCompatible = p.forceOpenAiCompatible === true;
  if (!title && !artist && !displayName) {
    return { ok: false, meaning: "", error: "No song title or artist to look up." };
  }
  const songLabel =
    artist && title
      ? `${artist} — ${title}`
      : title || artist || displayName;
  const albumLine = album ? `Album: ${album}` : "";

  const system = [
    "You explain what songs mean for listeners who just read the lyrics.",
    "Write in clear English: 2–4 short paragraphs.",
    "Cover themes, story, mood, and what the songwriter is expressing.",
    "If you are not confident this is the correct recording, say so briefly and still give your best interpretation.",
    "Do not quote or invent full lyrics. No markdown headings or bullet lists.",
  ].join(" ");

  const user = [
    `Song: ${songLabel}`,
    albumLine,
    displayName && displayName !== songLabel ? `File / library name: ${displayName}` : "",
    "",
    "What is this song about?",
  ]
    .filter(Boolean)
    .join("\n");

  const llmPurpose = "song meaning";
  try {
    const { text, meta } = await tryLlmTextInProviderOrder({
      system,
      user,
      purpose: llmPurpose,
      chatBody: { temperature: 0.35, max_tokens: 900 },
      skipGemini: forceOpenAiCompatible,
    });
    const trimmed = String(text ?? "").trim();
    if (!trimmed) {
      return {
        ok: false,
        meaning: "",
        error: formatLyricsLlmError(llmPurpose, "empty response"),
        ...meta,
      };
    }
    return { ok: true, meaning: trimmed.slice(0, 6000), ...meta };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) {
      return {
        ok: false,
        meaning: "",
        error: "Add an LLM API key in Settings (DeepSeek, Gemini, or OpenAI).",
        ...lyricsLlmMetaFields(llmPurpose),
      };
    }
    return {
      ok: false,
      meaning: "",
      error: (msg.includes("[model:") ? msg : formatLyricsLlmError(llmPurpose, msg)).slice(0, 400),
      ...lyricsLlmMetaFields(llmPurpose),
    };
  }
});

const LYRICS_TARGET_LANG_NAMES = {
  en: "English",
  zh: "Chinese (Simplified)",
  hi: "Hindi",
  es: "Spanish",
  fr: "French",
  ar: "Arabic",
  bn: "Bengali",
  pt: "Portuguese",
  ru: "Russian",
  ur: "Urdu",
  id: "Indonesian",
  de: "German",
  ja: "Japanese",
  tr: "Turkish",
  ko: "Korean",
  vi: "Vietnamese",
  it: "Italian",
  pl: "Polish",
  nl: "Dutch",
  th: "Thai",
};

ipcMain.handle("iptv-channel-epg-llm", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const name = typeof p.name === "string" ? p.name.trim().slice(0, 200) : "";
  const tvgId = typeof p.tvgId === "string" ? p.tvgId.trim().slice(0, 120) : "";
  const country = typeof p.country === "string" ? p.country.trim().slice(0, 80) : "";
  const group = typeof p.group === "string" ? p.group.trim().slice(0, 120) : "";
  if (!name) {
    return { ok: false, error: "Missing channel name.", programmes: [], rawJson: "" };
  }
  const todayLabel = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const system = [
    "You are a TV electronic program guide assistant.",
    "Return ONLY valid JSON (no markdown, no code fences):",
    '{"programmes":[{"title":"string","start":"HH:MM","stop":"HH:MM","description":"optional"}],"disclaimer":"string"}',
    `Estimate today's TV schedule (${todayLabel}) for the channel in local time for its region.`,
    "Include 6–12 entries covering morning through late night if plausible.",
    'If you cannot estimate, return {"programmes":[],"disclaimer":"brief reason"}.',
    "Times must be 24-hour HH:MM. Mark approximate data in disclaimer.",
  ].join(" ");
  const user = [
    `Channel name: ${name}`,
    tvgId ? `M3U tvg-id: ${tvgId}` : "",
    country ? `Country: ${country}` : "",
    group ? `Group: ${group}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const { text: rawJson, meta } = await tryLlmTextInProviderOrder({
      system,
      user,
      purpose: "TV EPG lookup",
      chatBody: { temperature: 0.25, max_tokens: 1800 },
      geminiGenerationConfig: { temperature: 0.25, maxOutputTokens: 2048 },
    });
    const trimmed = String(rawJson ?? "").trim();
    if (!trimmed) {
      return { ok: false, error: "LLM returned empty EPG data.", rawJson: "", ...meta };
    }
    return {
      ok: true,
      rawJson: trimmed.slice(0, 12_000),
      disclaimer: "",
      llmPurpose: meta.llmPurpose,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("IPTV_LYRICS_CHAT_TRANSLATE_NO_KEY")) {
      return {
        ok: false,
        error: "Add an LLM API key in Settings (DeepSeek, Gemini, or OpenAI).",
        rawJson: "",
      };
    }
    return { ok: false, error: msg.slice(0, 440), rawJson: "" };
  }
});

ipcMain.handle("iptv-lyrics-chat-translate", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 12_000) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const targetName = LYRICS_TARGET_LANG_NAMES[target] ?? target;
  const system = [
    `You translate song lyrics into ${targetName} (ISO 639-1: ${target}).`,
    "Preserve line breaks and the exact line count: do not merge lines, do not add blank lines, do not add headings or quotes.",
    "Output only the translated lyrics, no preamble or explanation.",
  ].join(" ");
  const user = `Source language (ISO 639-1): ${source}\nTarget language (ISO 639-1): ${target}\n\nLyrics:\n${q}`;
  const maxTokens = Math.min(8192, Math.max(512, Math.ceil(q.length * 0.45) + 400));
  const { text: translatedText, meta } = await tryChatCompletionInProviderOrder(
    {
      temperature: 0.15,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    "lyrics line translation"
  );
  return { translatedText, ...meta };
});

/**
 * Google Translate web-style GET (`client=gtx`) for lyric batches under ~700 chars in the renderer.
 * Unofficial; may change. Renderer falls back to LibreTranslate + MyMemory.
 */
ipcMain.handle("iptv-google-translate-gtx", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 1_200) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const translatedText = await fetchGoogleGtxTranslated(q, source, target);
  return { translatedText };
});

/**
 * LibreTranslate POST (public instances). Used for lyric line batches; falls back to MyMemory in the renderer if needed.
 */
ipcMain.handle("iptv-libre-translate", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const q = typeof p.q === "string" ? p.q : "";
  const source = typeof p.source === "string" ? p.source.trim().toLowerCase() : "";
  const target = normalizeTranslateLangCode(p.target, "en");
  if (!q || q.length > 12_000) {
    throw new Error("Invalid translation text.");
  }
  if (!/^[a-z]{2}(-[a-z0-9]{1,8})?$/.test(source)) {
    throw new Error("Invalid translation source language.");
  }
  const body = { q, source, target, format: "text" };
  const urls = ["https://libretranslate.com/translate", "https://translate.argosopentech.com/translate"];
  let lastErr;
  for (const url of urls) {
    try {
      const translatedText = await postLibreTranslateToUrl(url, body);
      return { translatedText };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
});

const streamRecordings = new Map();

/** One upstream fetch per stream URL — used for MPEG-TS PVR keep-alive recording only. */
const upstreamHubs = new Map();
const PVR_RECORD_PENDING_MAX_BYTES = 48 * 1024 * 1024;

function getOrCreateUpstreamHub(url) {
  const key = assertPlaylistUrlForMain(url);
  let hub = upstreamHubs.get(key);
  if (!hub) {
    hub = {
      key,
      url: key,
      upstream: null,
      clients: new Set(),
      keepAliveRefs: 0,
      connecting: false,
      reconnectTimer: null,
      reconnectFails: 0,
      destroyed: false,
    };
    upstreamHubs.set(key, hub);
  }
  return hub;
}

function hubAddKeepAliveRef(hub) {
  hub.keepAliveRefs += 1;
}

function hubReleaseKeepAliveRef(hub) {
  hub.keepAliveRefs = Math.max(0, hub.keepAliveRefs - 1);
  if (hub.keepAliveRefs === 0 && hub.clients.size === 0) hubDestroy(hub);
}

function hubDestroy(hub) {
  if (!hub || hub.destroyed) return;
  hub.destroyed = true;
  if (hub.reconnectTimer) {
    clearTimeout(hub.reconnectTimer);
    hub.reconnectTimer = null;
  }
  if (hub.upstream) {
    try {
      hub.upstream.removeAllListeners();
      hub.upstream.destroy();
    } catch {
      /* noop */
    }
    hub.upstream = null;
  }
  for (const client of hub.clients) {
    try {
      client.onHubDestroy?.();
    } catch {
      /* noop */
    }
  }
  hub.clients.clear();
  upstreamHubs.delete(hub.key);
}

function hubScheduleReconnect(hub) {
  if (hub.destroyed || hub.reconnectTimer) return;
  const attempt = hub.reconnectFails || 0;
  if (attempt > 120) {
    hubDestroy(hub);
    return;
  }
  const delay = Math.min(15_000, 1200 + attempt * 400);
  hub.reconnectTimer = setTimeout(() => {
    hub.reconnectTimer = null;
    void hubConnectUpstream(hub);
  }, delay);
}

function hubOnUpstreamLost(hub) {
  if (hub.destroyed) return;
  if (hub.keepAliveRefs > 0 || hub.clients.size > 0) {
    hubScheduleReconnect(hub);
    return;
  }
  hubDestroy(hub);
}

async function hubConnectUpstream(hub) {
  if (hub.destroyed) return;
  if (hub.upstream && !hub.upstream.destroyed) return;
  if (hub.connecting) return;
  hub.connecting = true;
  try {
    if (hub.upstream) {
      try {
        hub.upstream.removeAllListeners();
        hub.upstream.destroy();
      } catch {
        /* noop */
      }
      hub.upstream = null;
    }
    console.log(`[PVR-Hub] Connecting upstream: ${hub.url.slice(0, 120)}`);
    const res = await net.fetch(hub.url, { headers: streamRecordHeaders(hub.url) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    console.log(`[PVR-Hub] Connected OK, HTTP ${res.status}`);
    const upstream = Readable.fromWeb(res.body);
    hub.upstream = upstream;
    hub.reconnectFails = 0;
    let hubDataBytes = 0;
    upstream.on("data", (chunk) => {
      hubDataBytes += chunk.length;
      if (hubDataBytes < 200000 || hubDataBytes % 5000000 < chunk.length) {
        console.log(`[PVR-Hub] Data: ${(hubDataBytes / 1024).toFixed(0)} KB total, ${hub.clients.size} client(s)`);
      }
      for (const client of hub.clients) {
        try {
          client.onData(chunk);
        } catch {
          /* noop */
        }
      }
    });
    upstream.on("error", () => {
      hub.upstream = null;
      hub.reconnectFails = (hub.reconnectFails || 0) + 1;
      hubOnUpstreamLost(hub);
    });
    upstream.on("end", () => {
      hub.upstream = null;
      hub.reconnectFails = (hub.reconnectFails || 0) + 1;
      hubOnUpstreamLost(hub);
    });
  } catch {
    hub.reconnectFails = (hub.reconnectFails || 0) + 1;
    hubOnUpstreamLost(hub);
  } finally {
    hub.connecting = false;
  }
}

function hubSubscribe(hub, client) {
  hub.clients.add(client);
  void hubConnectUpstream(hub);
}

function hubUnsubscribe(hub, client) {
  hub.clients.delete(client);
  if (hub.keepAliveRefs === 0 && hub.clients.size === 0) hubDestroy(hub);
}

/** Fan-out hub bytes into a PassThrough for recording; survives upstream reconnects without ending. */
function createHubRecordingStream(url, keepAlive) {
  const hub = getOrCreateUpstreamHub(url);
  if (keepAlive) hubAddKeepAliveRef(hub);
  const pt = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
  let pending = [];
  let pendingBytes = 0;
  const flushPending = () => {
    while (pending.length && pt.write(pending[0]) !== false) {
      pendingBytes -= pending[0].length;
      pending.shift();
    }
    if (!pending.length) pendingBytes = 0;
  };
  pt.on("drain", flushPending);
  const client = {
    onData(chunk) {
      if (pt.destroyed) return;
      if (pt.write(chunk) === false) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        while (pendingBytes > PVR_RECORD_PENDING_MAX_BYTES && pending.length > 1) {
          pendingBytes -= pending.shift().length;
        }
      }
    },
    onHubDestroy() {
      try {
        pt.destroy();
      } catch {
        /* noop */
      }
    },
  };
  hubSubscribe(hub, client);
  const teardown = () => {
    hubUnsubscribe(hub, client);
    if (keepAlive) hubReleaseKeepAliveRef(hub);
  };
  return { stream: pt, hubKey: hub.key, teardown };
}

/** Set when the static server starts; used for same-origin tap URLs in IPC. */
let rendererOrigin = null;

function streamRecordHeaders(targetUrl) {
  const u = new URL(targetUrl);
  const isVod = /\.(mkv|mp4|avi|mov|mka)/i.test(targetUrl);
  // Use VLC-like user agent for VOD files - some IPTV servers block browsers
  return {
    "User-Agent": isVod
      ? "VLC/3.0.18 LibVLC/3.0.18"
      : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    Referer: `${u.origin}/`,
    ...(isVod ? { Accept: "*/*", "Icy-MetaData": "1" } : {}),
  };
}

function isLikelyHlsRecordUrl(url) {
  return /\.m3u8($|\?)/i.test(String(url));
}

const ALLOW_RECORD_TAP_TYPES = new Set([
  "video/mp2t",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
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
  if (/^\.(mp4|m4v|webm|ogv|mov|mpeg|mp3|aac|ogg|opus|bin)$/.test(s)) return s;
  return ".mpeg";
}

function normalizeRecordMode(raw, url, tapMime) {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s === "hls" || s === "mpegts" || s === "raw") return s;
  if (isLikelyHlsRecordUrl(url)) return "hls";
  return tapMime === "video/mp2t" ? "mpegts" : "raw";
}

ipcMain.handle("iptv-get-stream-proxy-origins", () => ({
  origins: streamProxyOriginsForIpc ?? [],
  token: streamProxySessionToken ?? "",
}));

// Helper to test if direct URL works (bypass proxy for MKV debugging)
ipcMain.handle("iptv-test-direct-url", async (_evt, url) => {
  try {
    console.log(`[DirectURL] Testing: ${url?.slice(0, 120)}`);
    const u = new URL(url);
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: `${u.origin}/`,
    };
    const res = await net.fetch(url, { method: "HEAD", headers, timeout: 15000 });
    console.log(`[DirectURL] Response: ${res.status} ${res.statusText}`);
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  } catch (e) {
    console.error(`[DirectURL] Failed:`, e instanceof Error ? e.message : String(e));
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("iptv-set-split-screen-preference", (_evt, enabled) => {
  splitScreenPreferenceEnabled = !!enabled;
  const item = Menu.getApplicationMenu()?.getMenuItemById("split-screen-preference");
  if (item) item.checked = splitScreenPreferenceEnabled;
  return { ok: true };
});

ipcMain.handle("iptv-pick-record-dir", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Player — folder for recordings",
    buttonLabel: "Save",
  });
  if (r.canceled || !r.filePaths?.[0]) return null;
  allowedRecordOutputDirs.add(path.resolve(r.filePaths[0]));
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

function mimeForLibraryExt(ext) {
  const audio = mimeForLocalAudioExt(ext);
  if (audio) return audio;
  const e = String(ext || "").toLowerCase();
  if (e === ".pdf") return "application/pdf";
  if (e === ".epub") return "application/epub+zip";
  if (e === ".txt" || e === ".md" || e === ".markdown") return "text/plain";
  if (e === ".html" || e === ".htm" || e === ".xhtml") return "text/html";
  return "";
}

/**
 * Native folder picker + readFile in main (reliable on Windows vs renderer File / IndexedDB quirks).
 * Recursively imports supported audio, audiobook, and ebook files into the renderer IndexedDB library.
 */
const MAX_DESKTOP_LIBRARY_PICK_COUNT = 500;
const MAX_DESKTOP_LIBRARY_FILE_BYTES = 512 * 1024 * 1024;

const LIBRARY_IMPORT_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".m4b",
  ".aac",
  ".ogg",
  ".oga",
  ".opus",
  ".wav",
  ".flac",
  ".webm",
  ".mpga",
  ".mpeg",
  ".pdf",
  ".epub",
  ".txt",
  ".md",
  ".markdown",
  ".html",
  ".htm",
  ".xhtml",
]);

function isLibraryImportPath(fp) {
  const base = path.basename(fp);
  if (!base || base.startsWith(".")) return false;
  return LIBRARY_IMPORT_EXTENSIONS.has(path.extname(fp).toLowerCase());
}

async function collectLibraryFilePathsUnderDir(rootDir, maxCount) {
  const fsp = fs.promises;
  const out = [];
  async function walk(dir) {
    if (out.length >= maxCount) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    for (const ent of entries) {
      if (out.length >= maxCount) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".")) continue;
        await walk(full);
      } else if (ent.isFile() && isLibraryImportPath(full)) {
        out.push(full);
      }
    }
  }
  await walk(path.resolve(rootDir));
  return out;
}

async function readLibraryPickFromPath(fp, fsp) {
  let stat;
  try {
    stat = await fsp.stat(fp);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0) return null;
  if (stat.size > MAX_DESKTOP_LIBRARY_FILE_BYTES) {
    return { skip: `${path.basename(fp)} exceeds ${Math.round(MAX_DESKTOP_LIBRARY_FILE_BYTES / (1024 * 1024))} MB and was skipped.` };
  }
  const ext = path.extname(fp);
  const mime = mimeForLibraryExt(ext) || "application/octet-stream";
  const base = path.basename(fp);
  const name = ext && base.toLowerCase().endsWith(ext.toLowerCase()) ? base.slice(0, -ext.length) : base;
  const buf = await fsp.readFile(fp);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    row: {
      fileName: base,
      name,
      size: stat.size,
      lastModified: stat.mtimeMs,
      addedAt: Date.now(),
      mime,
      data: ab,
    },
  };
}

async function readLibraryPicksFromPaths(filePaths, dialog) {
  const out = [];
  const skipped = [];
  const fsp = fs.promises;
  for (const fp of filePaths) {
    if (out.length >= MAX_DESKTOP_LIBRARY_PICK_COUNT) {
      skipped.push(`Only the first ${MAX_DESKTOP_LIBRARY_PICK_COUNT} files were imported.`);
      break;
    }
    const result = await readLibraryPickFromPath(fp, fsp);
    if (!result) continue;
    if (result.skip) {
      skipped.push(result.skip);
      continue;
    }
    out.push(result.row);
  }
  if (skipped.length && dialog) {
    void dialog.showMessageBox({
      type: "warning",
      title: "Some library files were skipped",
      message: "Not every file in the folder could be added.",
      detail: skipped.slice(0, 8).join("\n"),
    });
  }
  return out;
}

ipcMain.handle("iptv-pick-local-audio-files", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Add folder to library — audio, audiobooks, ebooks",
    buttonLabel: "Add",
  });
  if (r.canceled || !r.filePaths?.[0]) return [];
  const rootDir = r.filePaths[0];
  const filePaths = await collectLibraryFilePathsUnderDir(rootDir, MAX_DESKTOP_LIBRARY_PICK_COUNT);
  if (!filePaths.length) {
    void dialog.showMessageBox({
      type: "info",
      title: "No supported files found",
      message: "That folder does not contain any supported audio, audiobook, or ebook files.",
      detail: `Supported types: ${[...LIBRARY_IMPORT_EXTENSIONS].join(", ")}`,
    });
    return [];
  }
  return readLibraryPicksFromPaths(filePaths, dialog);
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

ipcMain.handle("iptv-pick-m3u-playlist-file", async () => {
  const { dialog } = require("electron");
  const r = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "IPTV playlists", extensions: ["m3u", "m3u8", "txt", "ts"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePaths?.length) return { ok: false, cancelled: true };
  const filePath = r.filePaths[0];
  try {
    let text = await fs.promises.readFile(filePath, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!text.trim()) {
      return { ok: false, error: "Playlist file is empty." };
    }
    return { ok: true, text, fileName: path.basename(filePath) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not read playlist file." };
  }
});

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
    title: "Player — add local video files",
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

function attachFfmpegStderr(child) {
  const MAX_STDERR_BYTES = 256 * 1024;
  let stderrSize = 0;
  const stderrChunks = [];
  child.stderr?.on("data", (d) => {
    if (stderrSize >= MAX_STDERR_BYTES) return;
    stderrChunks.push(d);
    stderrSize += d.length;
  });
  return () =>
    Buffer.concat(stderrChunks)
      .toString("utf8")
      .replace(/\r/g, "")
      .trim()
      .slice(-1400);
}

function spawnFfmpegProcess(ffmpegPath, args) {
  const child = spawn(ffmpegPath, args, { windowsHide: process.platform === "win32" });
  const readStderrTail = attachFfmpegStderr(child);
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        const tail = readStderrTail();
        reject(new Error(tail ? `ffmpeg exited ${code}: ${tail}` : `ffmpeg exited with code ${code}`));
      }
    });
  });
  done.catch(() => {});
  return { child, done, readStderrTail };
}

function runFfmpeg(ffmpegPath, args) {
  const { done } = spawnFfmpegProcess(ffmpegPath, args);
  return done;
}

const whisperStt = require("./whisperStt.cjs");
whisperStt.initWhisperStt({
  app,
  getFfmpegPath: getBundledFfmpegPath,
  runFfmpeg: (ffmpegPath, args) => runFfmpeg(ffmpegPath, args),
});

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mp4FileLooksPlayable(outPath) {
  const fsp = fs.promises;
  try {
    const st = await fsp.stat(outPath);
    if (st.size < 262_144) return false;
    const fh = await fsp.open(outPath, "r");
    try {
      const readLen = Math.min(st.size, 524_288);
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, 0);
      const head = buf.toString("latin1");
      const hasFtyp = head.includes("ftyp");
      const hasIndex = head.includes("moov") || head.includes("moof");
      return hasFtyp && hasIndex;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/** Wait until fragmented MP4 has a moov/ftyp and enough data to start `<video>` while ffmpeg still runs. */
async function waitForPlayableMp4File(outPath, child, timeoutMs) {
  const start = Date.now();
  let closedCode = null;
  child.once("close", (code) => {
    closedCode = code;
  });
  while (Date.now() - start < timeoutMs) {
    if (closedCode != null && closedCode !== 0) {
      throw new Error(`ffmpeg exited ${closedCode} before playback was ready.`);
    }
    if (await mp4FileLooksPlayable(outPath)) return;
    await sleepMs(400);
  }
  throw new Error(
    "Timed out preparing MKV for playback (the stream may be slow or blocked). Try again in a moment."
  );
}

/** Wait until FFmpeg has written an HLS playlist plus at least one playable segment. */
async function waitForPlayableHls(hlsDir, child, timeoutMs) {
  const playlistPath = path.join(hlsDir, "index.m3u8");
  const start = Date.now();
  let closedCode = null;
  if (child) {
    child.once("close", (code) => {
      closedCode = code;
    });
  }
  while (Date.now() - start < timeoutMs) {
    if (closedCode != null && closedCode !== 0) {
      throw new Error(`ffmpeg exited ${closedCode} before HLS playback was ready.`);
    }
    try {
      const pst = await fs.promises.stat(playlistPath);
      if (pst.size > 16) {
        const text = await fs.promises.readFile(playlistPath, "utf8");
        if (text.includes("#EXTINF")) {
          const names = await fs.promises.readdir(hlsDir);
          for (const name of names) {
            if (!/^seg\d+\.ts$/i.test(name)) continue;
            const segSt = await fs.promises.stat(path.join(hlsDir, name));
            if (segSt.size > 48_000) return;
          }
        }
      }
    } catch {
      /* not ready yet */
    }
    await sleepMs(400);
  }
  throw new Error(
    "Timed out preparing MKV for playback (the stream may be slow or blocked). Try again in a moment."
  );
}

const mkvPrepareInFlight = new Map();
const mkvPrepareChildren = new Map();
/** Active or recently finished MKV remux jobs — used to serve growing MP4 over HTTP Range (file:// freezes size). */
const mkvPlaybackSessions = new Map();

function mkvCacheDir() {
  return path.join(app.getPath("temp"), "rj-iptv-mkv-cache");
}

function mkvCacheFilePath(cacheKey) {
  const key = String(cacheKey ?? "").trim();
  if (!/^[a-f0-9]{48}$/i.test(key)) return null;
  const fp = path.join(mkvCacheDir(), `${key}.mp4`);
  const cacheResolved = path.resolve(mkvCacheDir());
  const fileResolved = path.resolve(fp);
  if (fileResolved !== cacheResolved && !fileResolved.startsWith(`${cacheResolved}${path.sep}`)) return null;
  return fileResolved;
}

function mkvCacheHlsDir(cacheKey) {
  const key = String(cacheKey ?? "").trim();
  if (!/^[a-f0-9]{48}$/i.test(key)) return null;
  const dir = path.join(mkvCacheDir(), key);
  const cacheResolved = path.resolve(mkvCacheDir());
  const dirResolved = path.resolve(dir);
  if (dirResolved !== cacheResolved && !dirResolved.startsWith(`${cacheResolved}${path.sep}`)) return null;
  return dirResolved;
}

function mkvHlsFilePath(cacheKey, fileName) {
  const dir = mkvCacheHlsDir(cacheKey);
  if (!dir) return null;
  const base = path.basename(String(fileName ?? ""));
  if (base !== "index.m3u8" && !/^seg\d+\.ts$/i.test(base)) return null;
  const fp = path.join(dir, base);
  if (!path.resolve(fp).startsWith(`${dir}${path.sep}`)) return null;
  return fp;
}

function mkvHttpHlsPlayUrl(cacheKey) {
  const origin = streamProxyOriginsForIpc?.[0];
  const token = streamProxySessionToken;
  const key = String(cacheKey ?? "").trim();
  if (!origin || !token || !/^[a-f0-9]{48}$/i.test(key)) return null;
  const base = String(origin).replace(/\/$/, "");
  const qs = new URLSearchParams({ token });
  return `${base}/__mkv-playback/${key}/index.m3u8?${qs.toString()}`;
}

function resolveMkvPlaybackPlayUrl(cacheKey, outPath, streaming) {
  if (streaming) {
    const httpUrl = mkvHttpHlsPlayUrl(cacheKey);
    if (httpUrl) return httpUrl;
  }
  return pathToFileURL(outPath).href;
}

function stopMkvPrepareChild(cacheKey) {
  const child = mkvPrepareChildren.get(cacheKey);
  if (!child) return;
  mkvPrepareChildren.delete(cacheKey);
  try {
    child.kill("SIGKILL");
  } catch {
    /* noop */
  }
}

const MKV_MP4_FRAG_FLAGS = ["-movflags", "frag_keyframe+empty_moov+default_base_moof"];
const MKV_CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;

async function cleanupMkvCache() {
  const cacheDir = mkvCacheDir();
  let entries;
  try {
    entries = await fs.promises.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".mp4")) {
      const fp = path.join(cacheDir, entry.name);
      try {
        const st = await fs.promises.stat(fp);
        files.push({ fp, size: st.size, mtimeMs: st.mtimeMs, isDir: false });
      } catch {
        /* ignore */
      }
    } else if (entry.isDirectory() && /^[a-f0-9]{48}$/i.test(entry.name)) {
      const dir = path.join(cacheDir, entry.name);
      try {
        const st = await fs.promises.stat(dir);
        let dirSize = 0;
        const inner = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const f of inner) {
          if (!f.isFile()) continue;
          try {
            dirSize += (await fs.promises.stat(path.join(dir, f.name))).size;
          } catch {
            /* ignore */
          }
        }
        files.push({ fp: dir, size: dirSize, mtimeMs: st.mtimeMs, isDir: true });
      } catch {
        /* ignore */
      }
    }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= MKV_CACHE_MAX_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (total <= MKV_CACHE_MAX_BYTES * 0.8) break;
    try {
      if (file.isDir) {
        await fs.promises.rm(file.fp, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(file.fp);
      }
      total -= file.size;
    } catch {
      /* best-effort cache cleanup */
    }
  }
}

async function remuxMkvInputToCachedMp4(ffmpegPath, baseArgs, outPath, opts = {}) {
  const fsp = fs.promises;
  const tryUnlink = async (p) => {
    try {
      await fsp.unlink(p);
    } catch {
      /* noop */
    }
  };

  const movFlags = ["-movflags", "+faststart"];
  const copyWithAudio = ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", ...movFlags];
  const copyVideoOnly = ["-map", "0:v:0?", "-c", "copy", "-an", ...movFlags];
  const x264aac = [
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
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
    ...movFlags,
  ];
  const x264an = ["-map", "0:v:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-an", ...movFlags];

  const encodeAttempts = [
    { extra: copyWithAudio, usedTranscode: false, remuxed: true },
    { extra: copyVideoOnly, usedTranscode: false, remuxed: true },
    { extra: x264aac, usedTranscode: true, remuxed: false },
    { extra: x264an, usedTranscode: true, remuxed: false },
  ];

  let lastErr = null;
  for (const attempt of encodeAttempts) {
    await tryUnlink(outPath);
    const args = [...baseArgs, ...attempt.extra, outPath];
    try {
      await runFfmpeg(ffmpegPath, args);
      return {
        playUrl: pathToFileURL(outPath).href,
        mimeType: "video/mp4",
        playbackFormat: "mp4",
        usedTranscode: attempt.usedTranscode,
        remuxed: attempt.remuxed,
      };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Could not prepare MKV for playback.");
}

/** Remote IPTV VOD: remux to growing HLS (hls.js) — avoids fragmented MP4 duration caps in `<video>`. */
async function remuxMkvInputToHls(ffmpegPath, baseArgs, hlsDir, opts = {}) {
  const fsp = fs.promises;
  const resetHlsDir = async () => {
    try {
      await fsp.rm(hlsDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
    await fsp.mkdir(hlsDir, { recursive: true });
  };

  const hlsTail = [
    "-f",
    "hls",
    "-hls_time",
    "6",
    "-hls_list_size",
    "0",
    "-hls_flags",
    "independent_segments+append_list+omit_endlist",
    "-hls_segment_filename",
    path.join(hlsDir, "seg%05d.ts"),
    path.join(hlsDir, "index.m3u8"),
  ];

  const copyWithAudio = ["-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy", ...hlsTail];
  const copyVideoOnly = ["-map", "0:v:0?", "-c", "copy", "-an", ...hlsTail];
  const x264aac = [
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
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
    ...hlsTail,
  ];
  const x264an = [
    "-map",
    "0:v:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "21",
    "-an",
    ...hlsTail,
  ];

  const encodeAttempts = [
    { extra: copyWithAudio, usedTranscode: false, remuxed: true },
    { extra: copyVideoOnly, usedTranscode: false, remuxed: true },
    { extra: x264aac, usedTranscode: true, remuxed: false },
    { extra: x264an, usedTranscode: true, remuxed: false },
  ];

  let lastErr = null;
  const cacheKey = opts.cacheKey;
  const directUrl = opts.directUrl; // Fallback direct URL if proxy fails

  // Try with proxy first, then fallback to direct URL if provided
  const attempts = [{ useProxy: true }];
  if (directUrl) attempts.push({ useProxy: false, directUrl });

  for (const { useProxy, directUrl: attemptDirect } of attempts) {
    for (let ai = 0; ai < encodeAttempts.length; ai++) {
      const attempt = encodeAttempts[ai];
      await resetHlsDir();
      // Rebuild base args if using direct URL
      let inputUrl;
      let args;
      if (useProxy) {
        args = [...baseArgs, ...attempt.extra];
        console.log(`[MKV-HLS] Attempt ${ai + 1}/${encodeAttempts.length} (proxy): transcode=${attempt.usedTranscode}`);
      } else {
        // Rebuild args with direct URL
        const directBaseArgs = mkvRemoteInputArgs(attemptDirect, attemptDirect);
        args = [...directBaseArgs, ...attempt.extra];
        console.log(`[MKV-HLS] Attempt ${ai + 1}/${encodeAttempts.length} (direct): transcode=${attempt.usedTranscode}`);
        console.log(`[MKV-HLS] Direct URL:`, attemptDirect?.slice(0, 150));
      }
      if (cacheKey) stopMkvPrepareChild(cacheKey);
      const { child, done, readStderrTail } = spawnFfmpegProcess(ffmpegPath, args);
      if (cacheKey) {
        mkvPrepareChildren.set(cacheKey, child);
        mkvPlaybackSessions.set(cacheKey, { hlsDir, child });
      }
      try {
        await waitForPlayableHls(hlsDir, child, opts.prepareTimeoutMs ?? 120_000);
        console.log(`[MKV-HLS] Attempt ${ai + 1} SUCCEEDED — HLS segments ready.`);
        void done.finally(() => {
          if (cacheKey) {
            mkvPrepareChildren.delete(cacheKey);
            const session = mkvPlaybackSessions.get(cacheKey);
            if (session) session.child = null;
          }
          void cleanupMkvCache();
        });
        const httpPlayUrl = cacheKey ? mkvHttpHlsPlayUrl(cacheKey) : null;
        console.log("[MKV-HLS] playUrl:", httpPlayUrl?.slice(0, 200));
        if (!httpPlayUrl || !/^https?:\/\//i.test(httpPlayUrl)) {
          throw new Error("MKV HLS playback URL is not ready (restart the desktop app).");
        }
        return {
          playUrl: httpPlayUrl,
          mimeType: "application/vnd.apple.mpegurl",
          playbackFormat: "hls",
          usedTranscode: attempt.usedTranscode,
          remuxed: attempt.remuxed,
          streaming: true,
        };
      } catch (e) {
        const stderr = typeof readStderrTail === "function" ? readStderrTail() : "";
        console.error(`[MKV-HLS] Attempt ${ai + 1} FAILED:`, e?.message || e);
        if (stderr) console.error(`[MKV-HLS] FFmpeg stderr:\n${stderr.slice(-600)}`);
        try {
          child.kill("SIGKILL");
        } catch {
          /* noop */
        }
        if (cacheKey) mkvPrepareChildren.delete(cacheKey);
        lastErr = e;
      }
    }
  }

  throw lastErr instanceof Error
    ? lastErr
    : new Error("Could not prepare MKV for playback.");
}

function upstreamUrlFromProxyInput(inputUrl) {
  try {
    const u = new URL(inputUrl);
    if (u.pathname === "/__proxy/stream") {
      const inner = u.searchParams.get("url");
      if (inner && /^https?:\/\//i.test(inner)) return inner.trim();
    }
  } catch {
    /* noop */
  }
  return String(inputUrl ?? "").trim();
}

/** Same-origin proxy so FFmpeg can read IPTV hosts that block direct desktop fetches. */
function localProxyStreamUrl(upstreamUrl) {
  if (!/^https?:\/\//i.test(upstreamUrl)) return upstreamUrl;
  const origin = streamProxyOriginsForIpc?.[0];
  const token = streamProxySessionToken;
  if (!origin || !token) return upstreamUrl;
  const base = String(origin).replace(/\/$/, "");
  const qs = new URLSearchParams({ url: upstreamUrl, token });
  return `${base}/__proxy/stream?${qs.toString()}`;
}

function mkvRemoteInputArgs(inputUrl, headerForUrl) {
  const headersTarget = headerForUrl || inputUrl;
  return [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-fflags",
    "+genpts",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "5",
    "-probesize",
    "32M",
    "-analyzeduration",
    "10M",
    "-headers",
    `${ffmpegHeaderLinesForUrl(headersTarget)}\r\n`,
    "-i",
    inputUrl,
  ];
}

/**
 * Matroska (.mkv) often uses codecs Chromium cannot decode (HEVC, DTS, AC-3, etc.). Remux or transcode to H.264/AAC MP4
 * via bundled ffmpeg-static (first open may take a while; result is cached under the user temp folder).
 * Supports local `file://` paths and remote `http(s)://` IPTV VOD links.
 */
ipcMain.handle("iptv-prepare-mkv-playback", async (_evt, fileUrlRaw) => {
  const sourceUrl =
    fileUrlRaw && typeof fileUrlRaw === "object" && typeof fileUrlRaw.url === "string"
      ? String(fileUrlRaw.url).trim()
      : String(fileUrlRaw ?? "").trim();
  const forceRemux = fileUrlRaw && typeof fileUrlRaw === "object" && fileUrlRaw.forceRemux === true;
  console.log("[MKV] prepare-mkv-playback called, sourceUrl:", sourceUrl?.slice(0, 200), "forceRemux:", forceRemux);
  if (!sourceUrl) throw new Error("Missing video URL.");

  const isFile = /^file:/i.test(sourceUrl);
  const upstreamUrl = isFile ? sourceUrl : upstreamUrlFromProxyInput(sourceUrl);
  const isRemote = /^https?:\/\//i.test(upstreamUrl);
  if (!isFile && !isRemote) {
    return { playUrl: sourceUrl, mimeType: undefined, usedTranscode: false };
  }

  let ext = "";
  let inPath = null;
  if (isFile) {
    try {
      inPath = fileURLToPath(sourceUrl);
    } catch {
      throw new Error("Invalid file URL.");
    }
    ext = path.extname(inPath).toLowerCase();
  } else {
    try {
      ext = path.extname(new URL(upstreamUrl).pathname).toLowerCase();
    } catch {
      throw new Error("Invalid stream URL.");
    }
  }

  let pathname = "";
  try {
    pathname = isFile ? inPath.replace(/\\/g, "/").toLowerCase() : new URL(upstreamUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  const isXtreamVod = /\/(movie|series)\//i.test(pathname);
  // Only MKV/MKA files need remuxing. MP4/WebM/MOV files in VOD paths play directly.
  const needsRemux = ext === ".mkv" || ext === ".mka";

  // If it's not MKV/MKA, return direct URL (works for MP4, WebM, etc.)
  if (!needsRemux) {
    console.log("[MKV] Direct playback (no remux needed):", ext || "unknown ext", "isXtreamVod:", isXtreamVod);
    return {
      playUrl: sourceUrl,
      mimeType: ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : undefined,
      usedTranscode: false,
      remuxed: false,
      direct: true,
      playbackFormat: "direct",
    };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error(
      "FFmpeg is not bundled with this app. MKV playback needs a packaged desktop build with ffmpeg-static."
    );
  }

  const fsp = fs.promises;
  let cacheKey;
  if (isFile) {
    let st;
    try {
      st = await fsp.stat(inPath);
    } catch {
      throw new Error("Could not read the video file from disk.");
    }
    if (!st.isFile() || st.size === 0) throw new Error("Video file is missing or empty.");
    const fpNorm = assertUserAccessibleMediaPath(inPath);
    cacheKey = crypto
      .createHash("sha256")
      .update(`${fpNorm}\0${st.size}\0${Number(st.mtimeMs)}`)
      .digest("hex")
      .slice(0, 48);
  } else {
    cacheKey = crypto.createHash("sha256").update(upstreamUrl).digest("hex").slice(0, 48);
  }

  const cacheDir = mkvCacheDir();
  await fsp.mkdir(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, `${cacheKey}.mp4`);
  const hlsDir = mkvCacheHlsDir(cacheKey);

  if (isRemote && hlsDir) {
    try {
      const playlistPath = path.join(hlsDir, "index.m3u8");
      const pst = await fsp.stat(playlistPath);
      if (pst.size > 16) {
        const names = await fsp.readdir(hlsDir);
        if (names.some((n) => /^seg\d+\.ts$/i.test(n))) {
          const httpUrl = mkvHttpHlsPlayUrl(cacheKey);
          if (httpUrl) {
            return {
              playUrl: httpUrl,
              mimeType: "application/vnd.apple.mpegurl",
              playbackFormat: "hls",
              usedTranscode: false,
              fromCache: true,
              remuxed: true,
            };
          }
        }
      }
    } catch {
      /* build HLS */
    }
  }

  if (!isRemote) {
    try {
      const ost = await fsp.stat(outPath);
      if (ost.size > 32_000) {
        return {
          playUrl: pathToFileURL(outPath).href,
          mimeType: "video/mp4",
          playbackFormat: "mp4",
          usedTranscode: true,
          fromCache: true,
        };
      }
    } catch {
      /* build MP4 */
    }
  }

  const inflight = mkvPrepareInFlight.get(cacheKey);
  if (inflight) return inflight;

  const work = (async () => {
    // For remote MKV files, first try direct streaming (like VLC does)
    // Only remux if direct playback fails in the player
    if (isRemote && ext === ".mkv" && !forceRemux) {
      console.log("[MKV] Attempting direct streaming first (VLC-style)...");
      console.log("[MKV] Direct URL:", upstreamUrl?.slice(0, 200));
      // Return direct URL and let player try - if it fails, player will retry with remux
      return {
        playUrl: upstreamUrl,
        mimeType: "video/x-matroska",
        playbackFormat: "direct",
        usedTranscode: false,
        remuxed: false,
        streaming: true,
        direct: true,
      };
    }

    const ffmpegInputUrl = isFile ? assertUserAccessibleMediaPath(inPath) : localProxyStreamUrl(upstreamUrl);
    console.log("[MKV] ffmpegInputUrl:", ffmpegInputUrl?.slice(0, 200));
    console.log("[MKV] isFile:", isFile, "isRemote:", isRemote, "ext:", ext, "isXtreamVod:", isXtreamVod);
    console.log("[MKV] cacheKey:", cacheKey, "hlsDir:", hlsDir);
    const baseArgs = isFile
      ? ["-nostdin", "-hide_banner", "-loglevel", "warning", "-y", "-i", ffmpegInputUrl]
      : mkvRemoteInputArgs(ffmpegInputUrl, upstreamUrl);
    if (isRemote && hlsDir) {
      console.log("[MKV] Starting HLS remux…");
      return remuxMkvInputToHls(ffmpegPath, baseArgs, hlsDir, {
        cacheKey,
        prepareTimeoutMs: 120_000,
        directUrl: upstreamUrl, // Fallback to direct URL if proxy fails
      });
    }
    console.log("[MKV] Starting MP4 remux…");
    const result = await remuxMkvInputToCachedMp4(ffmpegPath, baseArgs, outPath, { cacheKey });
    void cleanupMkvCache();
    return result;
  })();

  mkvPrepareInFlight.set(cacheKey, work);
  try {
    return await work;
  } finally {
    mkvPrepareInFlight.delete(cacheKey);
  }
});

/** Shared FFmpeg args to mux live/HLS/MPEG-TS captures into MP4 with audible audio. */
function buildStreamRecordingToMp4Attempts(input, outputPath, opts = {}) {
  const inputIsUrl = !!opts.inputIsUrl;
  const inputUrl = typeof opts.inputUrl === "string" ? opts.inputUrl : "";
  const compact = opts.compact !== false;
  const head = ["-hide_banner", "-loglevel", "warning", "-y"];
  if (inputIsUrl && inputUrl && isLikelyHlsRecordUrl(inputUrl)) {
    head.push(
      "-protocol_whitelist",
      "file,http,https,tcp,tls,crypto",
      "-allowed_extensions",
      "ALL"
    );
  }
  if (inputIsUrl && inputUrl) {
    const headerLines = ffmpegHeaderLinesForUrl(inputUrl);
    if (headerLines) head.push("-headers", headerLines);
    head.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "15");
  }
  head.push(
    "-fflags",
    "+genpts+discardcorrupt",
    "-probesize",
    "64M",
    "-analyzeduration",
    "20M",
    "-i",
    input,
    "-sn",
    "-dn"
  );
  const tail = ["-max_muxing_queue_size", "4096", "-movflags", "+faststart", outputPath];
  const encodeAudioCompact = [
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "96k",
    "-af",
    "aresample=async=1:first_pts=0",
    "-bsf:a",
    "aac_adtstoasc",
  ];
  const encodeAudioStandard = [
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "128k",
    "-af",
    "aresample=async=1:first_pts=0",
    "-bsf:a",
    "aac_adtstoasc",
  ];
  const compactVideoEncode = [
    "-map",
    "0:v:0?",
    "-map",
    "0:a?",
    "-vf",
    "scale=1280:-2:force_original_aspect_ratio=decrease",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "26",
    "-maxrate",
    "2500k",
    "-bufsize",
    "5000k",
    ...encodeAudioCompact,
  ];
  const copyAttempts = [
    ["-map", "0:v:0?", "-map", "0:a?", "-c:v", "copy", ...encodeAudioStandard],
    ["-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "copy", "-c:a", "copy", "-bsf:a", "aac_adtstoasc"],
    ["-map", "0:v:0?", "-map", "0:a:0?", "-c:v", "copy", ...encodeAudioStandard],
    ["-map", "0:a?", "-c:a", "copy", "-bsf:a", "aac_adtstoasc"],
    ["-map", "0:a?", ...encodeAudioStandard],
  ];
  const mapAttempts = compact ? [compactVideoEncode, ...copyAttempts] : copyAttempts;
  return mapAttempts.map((maps) => [...head, ...maps, ...tail]);
}

async function runStreamRecordingToMp4(ffmpegPath, input, outputPath, opts = {}) {
  const attempts = buildStreamRecordingToMp4Attempts(input, outputPath, opts);
  let lastErr = null;
  for (const args of attempts) {
    try {
      await runFfmpeg(ffmpegPath, args);
      return;
    } catch (e) {
      lastErr = e;
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* noop */
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Could not finalize recording with audio.");
}

function recordingSegmentTmpPath(filePath, index) {
  const base = filePath.replace(/\.mp4$/i, "");
  return `${base}.part${String(index).padStart(3, "0")}.ts`;
}

function buildHlsRecordingToTsAttempts(inputUrl, outputTsPath) {
  const head = ["-hide_banner", "-loglevel", "warning", "-y"];
  if (isLikelyHlsRecordUrl(inputUrl)) {
    head.push("-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-allowed_extensions", "ALL");
  }
  const headerLines = ffmpegHeaderLinesForUrl(inputUrl);
  if (headerLines) head.push("-headers", headerLines);
  head.push(
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "15",
    "-fflags",
    "+genpts+discardcorrupt",
    "-probesize",
    "64M",
    "-analyzeduration",
    "20M",
    "-i",
    inputUrl,
    "-sn",
    "-dn",
    "-c",
    "copy",
    "-f",
    "mpegts",
    outputTsPath
  );
  return [head];
}

async function waitForWriteStreamEnd(ws) {
  if (!ws || ws.writableEnded || ws.destroyed) return;
  await new Promise((resolve, reject) => {
    ws.once("finish", resolve);
    ws.once("error", reject);
    ws.end();
  });
}

async function muxRecordingSegmentsToMp4(ffmpegPath, segmentPaths, outputPath, compact) {
  const paths = segmentPaths.filter((p) => {
    try {
      return fs.statSync(p).size > 0;
    } catch {
      return false;
    }
  });
  if (!paths.length) throw new Error("No recording data captured.");
  if (paths.length === 1) {
    await runStreamRecordingToMp4(ffmpegPath, paths[0], outputPath, { inputIsUrl: false, compact });
    try {
      fs.unlinkSync(paths[0]);
    } catch {
      /* noop */
    }
    return;
  }
  const listPath = `${outputPath}.concat.txt`;
  const esc = (p) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
  fs.writeFileSync(listPath, paths.map((p) => `file '${esc(p)}'`).join("\n"), "utf8");
  try {
    await runFfmpeg(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      outputPath,
    ]);
  } catch {
    const merged = `${outputPath}.merged.ts`;
    await runFfmpeg(ffmpegPath, [
      "-hide_banner",
      "-loglevel",
      "warning",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c",
      "copy",
      merged,
    ]);
    await runStreamRecordingToMp4(ffmpegPath, merged, outputPath, { inputIsUrl: false, compact });
    try {
      fs.unlinkSync(merged);
    } catch {
      /* noop */
    }
  } finally {
    try {
      fs.unlinkSync(listPath);
    } catch {
      /* noop */
    }
    for (const p of paths) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* noop */
      }
    }
  }
}

function createRecordingOutput(filePath, tapMime, compact = true, opts = {}) {
  const deferMux = !!opts.deferMux;
  if (tapMime !== "video/mp2t") {
    const ws = fs.createWriteStream(filePath, { flags: "w", highWaterMark: 4 * 1024 * 1024 });
    const done = new Promise((resolve, reject) => {
      ws.once("finish", resolve);
      ws.once("error", reject);
    });
    done.catch(() => {});
    return { writable: ws, done, kind: "raw", deferMux: false };
  }

  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("FFmpeg is required to save IPTV video recordings as MP4.");
  }
  const segmentIndex = typeof opts.segmentIndex === "number" ? opts.segmentIndex : 0;
  const tmpPath =
    typeof opts.segmentTmpPath === "string" && opts.segmentTmpPath
      ? opts.segmentTmpPath
      : deferMux
        ? recordingSegmentTmpPath(filePath, segmentIndex)
        : `${filePath}.recording.ts`;
  const ws = fs.createWriteStream(tmpPath, { flags: "w", highWaterMark: 16 * 1024 * 1024 });
  const done = new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("finish", () => {
      if (deferMux) {
        resolve();
        return;
      }
      runStreamRecordingToMp4(ffmpegPath, tmpPath, filePath, { inputIsUrl: false, compact })
        .then(() => {
          try {
            fs.unlinkSync(tmpPath);
          } catch {
            /* noop */
          }
          resolve();
        })
        .catch(reject);
    });
  });
  done.catch(() => {});
  return { writable: ws, done, kind: "mp4", tmpPath, deferMux };
}

function ffmpegHeaderLinesForUrl(url) {
  const headers = streamRecordHeaders(url);
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
}

function startFfmpegHlsRecording(id, url, filePath, compact = true, meta = {}) {
  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) {
    throw new Error("FFmpeg is required to record HLS (.m3u8) streams.");
  }
  const keepAlive = !!meta.keepAlive;
  const recordUntilMs = typeof meta.recordUntilMs === "number" ? meta.recordUntilMs : 0;
  const prev = streamRecordings.get(id);
  const segmentIndex =
    typeof meta.segmentIndex === "number" ? meta.segmentIndex : prev?.segmentIndex ?? 0;
  const segmentPath = keepAlive ? recordingSegmentTmpPath(filePath, segmentIndex) : filePath;
  const args = keepAlive
    ? buildHlsRecordingToTsAttempts(url, segmentPath)
    : buildStreamRecordingToMp4Attempts(url, filePath, {
        inputIsUrl: true,
        inputUrl: url,
        compact,
      })[0];
  const child = spawn(ffmpegPath, args, { windowsHide: process.platform === "win32" });
  const stderrChunks = [];
  child.stderr?.on("data", (d) => {
    stderrChunks.push(d);
    while (stderrChunks.length > 32) stderrChunks.shift();
  });
  let finalizeResolve = prev?.finalizeResolve;
  let finalizeReject = prev?.finalizeReject;
  const finalizeDone =
    prev?.done ||
    new Promise((resolve, reject) => {
      finalizeResolve = resolve;
      finalizeReject = reject;
    });
  const childDone = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const h = streamRecordings.get(id);
      if (h?.keepAlive && !h.stopped && h.recordUntilMs > Date.now()) {
        if (h.segmentPath) {
          h.segmentPaths = h.segmentPaths || [];
          try {
            if (fs.statSync(h.segmentPath).size > 0) h.segmentPaths.push(h.segmentPath);
          } catch {
            /* noop */
          }
        }
        h.reconnectAttempt = (h.reconnectAttempt || 0) + 1;
        if (h.reconnectAttempt <= 60) {
          const nextIndex = (h.segmentIndex ?? 0) + 1;
          setTimeout(() => {
            try {
              startFfmpegHlsRecording(id, url, filePath, compact, {
                ...meta,
                segmentIndex: nextIndex,
              });
            } catch {
              void finalizeRecordingStream(id);
            }
          }, 2500);
          return;
        }
      }
      if (code === 0 || code === 255 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim().slice(-1200);
      reject(new Error(stderr || `FFmpeg exited with code ${code ?? "unknown"}.`));
    });
  });
  childDone.catch(() => {});
  streamRecordings.set(id, {
    child,
    filePath,
    done: keepAlive ? finalizeDone : childDone,
    tapRes: null,
    tapMime: "application/octet-stream",
    tmpPath: keepAlive ? segmentPath : null,
    segmentPath: keepAlive ? segmentPath : null,
    segmentPaths: prev?.segmentPaths || [],
    segmentIndex,
    upstream: null,
    ws: null,
    keepAlive,
    recordUntilMs,
    url,
    compact,
    stopped: prev?.stopped ?? false,
    finalizing: false,
    reconnectAttempt: prev?.reconnectAttempt || 0,
    finalizeResolve: prev?.finalizeResolve ?? finalizeResolve,
    finalizeReject: prev?.finalizeReject ?? finalizeReject,
    stopTimer:
      prev?.stopTimer ||
      (keepAlive && recordUntilMs > Date.now()
        ? setTimeout(() => void finalizeRecordingStream(id), recordUntilMs - Date.now())
        : null),
  });
  if (!keepAlive) {
    childDone.then(() => streamRecordings.delete(id)).catch(() => streamRecordings.delete(id));
  }
  return { ok: true, id, filePath, playbackUrl: null };
}

async function finalizeKeepAliveRecording(id) {
  const h = streamRecordings.get(id);
  if (!h?.keepAlive || !h.filePath) return;
  console.log(`[PVR] Finalizing recording ${id}: filePath=${h.filePath}`);
  const ffmpegPath = getBundledFfmpegPath();
  if (!ffmpegPath) throw new Error("FFmpeg is required to finalize PVR recordings.");
  if (h.ws && !h.ws.writableEnded) {
    console.log(`[PVR] Ending write stream for ${id}…`);
    try {
      await waitForWriteStreamEnd(h.ws);
    } catch (e) {
      console.log(`[PVR] Write stream end error for ${id}:`, e?.message);
    }
  }
  if (h.child && !h.child.killed) {
    console.log(`[PVR] Stopping FFmpeg child for ${id}…`);
    await new Promise((resolve) => {
      const onClose = () => resolve();
      h.child.once("close", onClose);
      try {
        h.child.kill("SIGINT");
      } catch {
        resolve();
      }
      setTimeout(resolve, 4000);
    });
  }
  const segments = [...(h.segmentPaths || [])];
  if (h.tmpPath) {
    try {
      if (fs.statSync(h.tmpPath).size > 0) segments.push(h.tmpPath);
    } catch {
      /* noop */
    }
  }
  if (h.segmentPath) {
    try {
      if (fs.statSync(h.segmentPath).size > 0 && !segments.includes(h.segmentPath)) {
        segments.push(h.segmentPath);
      }
    } catch {
      /* noop */
    }
  }
  console.log(`[PVR] Muxing ${segments.length} segment(s) to ${h.filePath}`);
  if (!segments.length) {
    console.log(`[PVR] WARNING: No segments captured for ${id}. Nothing to mux.`);
    return;
  }
  for (const seg of segments) {
    try {
      const sz = fs.statSync(seg).size;
      console.log(`[PVR]   segment: ${path.basename(seg)} (${(sz / 1024).toFixed(0)} KB)`);
    } catch { /* noop */ }
  }
  try {
    await muxRecordingSegmentsToMp4(ffmpegPath, segments, h.filePath, h.compact !== false);
    console.log(`[PVR] Mux complete: ${h.filePath}`);
  } catch (e) {
    console.error(`[PVR] Mux FAILED for ${id}:`, e?.message || e);
    throw e;
  }
}

async function finalizeRecordingStream(id) {
  const h = streamRecordings.get(id);
  if (!h || h.finalizing) return;
  h.finalizing = true;
  h.stopped = true;
  if (h._dataLogInterval) {
    clearInterval(h._dataLogInterval);
    h._dataLogInterval = null;
  }
  if (h.stopTimer) {
    clearTimeout(h.stopTimer);
    h.stopTimer = null;
  }
  if (h.reconnectTimer) {
    clearTimeout(h.reconnectTimer);
    h.reconnectTimer = null;
  }
  try {
    if (h.hubTeardown) {
      try {
        h.hubTeardown();
      } catch {
        /* noop */
      }
      h.hubTeardown = null;
    }
  } catch {
    /* noop */
  }
  try {
    if (h.upstream) {
      h.upstream.removeAllListeners();
      try { h.upstream.destroy(); } catch { /* noop */ }
    }
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
  try {
    if (h.keepAlive) {
      console.log(`[PVR] finalizeRecordingStream(${id}): keepAlive path`);
      await finalizeKeepAliveRecording(id);
      if (h.finalizeResolve) h.finalizeResolve();
    } else if (h.ws && !h.ws.writableEnded) {
      h.ws.end();
    }
  } catch (e) {
    console.error(`[PVR] finalizeRecordingStream(${id}) error:`, e?.message || e);
    if (h.finalizeReject) h.finalizeReject(e);
    throw e;
  }
  streamRecordings.delete(id);
}

async function rotateRecordingSegment(id) {
  const h = streamRecordings.get(id);
  if (!h || h.stopped || h.finalizing || h.rotating) return;
  if (!h.keepAlive || !h.url || Date.now() >= h.recordUntilMs) {
    await finalizeRecordingStream(id);
    return;
  }
  h.rotating = true;
  try {
    if (h.upstream && !h.hubKey) {
      try {
        h.upstream.removeAllListeners();
        h.upstream.destroy();
      } catch {
        /* noop */
      }
      h.upstream = null;
    }
    if (h.ws && !h.ws.writableEnded) {
      await waitForWriteStreamEnd(h.ws);
    }
    if (h.tmpPath) {
      h.segmentPaths = h.segmentPaths || [];
      try {
        if (fs.statSync(h.tmpPath).size > 0) h.segmentPaths.push(h.tmpPath);
      } catch {
        /* noop */
      }
    }
    const nextIndex = (h.segmentIndex ?? 0) + 1;
    const nextTmp = recordingSegmentTmpPath(h.filePath, nextIndex);
    const recordOutput = createRecordingOutput(h.filePath, h.tapMime || "video/mp2t", h.compact !== false, {
      deferMux: true,
      segmentTmpPath: nextTmp,
      segmentIndex: nextIndex,
    });
    h.segmentIndex = nextIndex;
    h.ws = recordOutput.writable;
    h.tmpPath = nextTmp;
    h.lastSegmentRotateAt = Date.now();
    h.reconnecting = false;
    await reconnectRecordingUpstream(id);
  } catch {
    const fails = (h.reconnectFail || 0) + 1;
    h.reconnectFail = fails;
    if (fails > 25 || Date.now() >= h.recordUntilMs) {
      await finalizeRecordingStream(id);
    } else {
      h.reconnectTimer = setTimeout(() => {
        h.reconnectTimer = null;
        void reconnectRecordingUpstream(id);
      }, 2500);
    }
  } finally {
    if (streamRecordings.get(id)) h.rotating = false;
  }
}

async function reconnectRecordingUpstream(id) {
  const h = streamRecordings.get(id);
  if (!h || h.stopped || h.finalizing) return;
  if (!h.keepAlive || !h.url) {
    void finalizeRecordingStream(id);
    return;
  }
  if (Date.now() >= h.recordUntilMs) {
    void finalizeRecordingStream(id);
    return;
  }
  if (h.reconnecting || h.rotating) return;
  h.reconnecting = true;
  try {
    if (h.hubKey) {
      const hub = upstreamHubs.get(h.hubKey);
      if (hub) {
        await hubConnectUpstream(hub);
        h.reconnectFail = 0;
        return;
      }
    }
    if (h.upstream) {
      try {
        h.upstream.removeAllListeners();
        if (!h.hubKey) h.upstream.destroy();
      } catch {
        /* noop */
      }
      if (!h.hubKey) h.upstream = null;
    }
    if (h.hubKey) return;
    const res = await net.fetch(h.url, { headers: streamRecordHeaders(h.url) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const upstream = Readable.fromWeb(res.body);
    h.reconnectFail = 0;
    h.reconnectAttempt = (h.reconnectAttempt || 0) + 1;
    bindRecordingUpstream(id, upstream);
  } catch {
    const attempt = (h.reconnectFail || 0) + 1;
    h.reconnectFail = attempt;
    if (attempt > 80 || Date.now() >= h.recordUntilMs) {
      void finalizeRecordingStream(id);
      return;
    }
    const delay = Math.min(15_000, 1500 + attempt * 500);
    h.reconnectTimer = setTimeout(() => {
      h.reconnectTimer = null;
      void reconnectRecordingUpstream(id);
    }, delay);
  } finally {
    h.reconnecting = false;
  }
}

async function handleRecordingUpstreamLost(id, reason) {
  const h = streamRecordings.get(id);
  if (!h || h.stopped || h.finalizing || h.rotating || h.reconnecting) return;
  if (!h.keepAlive || !h.url || Date.now() >= h.recordUntilMs) {
    void finalizeRecordingStream(id);
    return;
  }
  const wsAlive = h.ws && !h.ws.writableEnded;
  if (wsAlive) {
    await reconnectRecordingUpstream(id);
    return;
  }
  const now = Date.now();
  const sinceRotate = h.lastSegmentRotateAt ? now - h.lastSegmentRotateAt : Infinity;
  if (sinceRotate < 45_000 && (h.reconnectFail || 0) < 5) {
    await reconnectRecordingUpstream(id);
    return;
  }
  void rotateRecordingSegment(id);
}

function bindRecordingUpstream(id, upstream) {
  const h = streamRecordings.get(id);
  if (!h || h.stopped || h.finalizing) return;
  h.upstream = upstream;
  const bp = h._bp || (h._bp = { fileOk: true, tapOk: true });
  const pending = h._pendingChunks || (h._pendingChunks = []);
  let pendingBytes = h._pendingBytes || 0;
  const ws = h.ws;

  const flushPendingToDisk = () => {
    while (pending.length && ws && !ws.writableEnded) {
      const chunk = pending[0];
      if (ws.write(chunk) === false) break;
      pendingBytes -= chunk.length;
      pending.shift();
    }
    if (!pending.length) pendingBytes = 0;
    h._pendingBytes = pendingBytes;
    if (!pending.length) bp.fileOk = true;
  };

  const resumeIfReady = () => {
    if (!upstream.isPaused()) return;
    if (bp.fileOk && bp.tapOk) upstream.resume();
  };

  const fail = () => {
    if (h.keepAlive && !h.stopped && Date.now() < h.recordUntilMs) {
      void handleRecordingUpstreamLost(id, "error");
      return;
    }
    void finalizeRecordingStream(id);
  };

  upstream.on("data", (chunk) => {
    if (h.tapRes && !h.tapRes.writableEnded) {
      try {
        bp.tapOk = h.tapRes.write(chunk) !== false;
      } catch {
        bp.tapOk = true;
        try {
          h.tapRes.removeAllListeners("drain");
          h.tapRes.destroy();
        } catch {
          /* noop */
        }
        h.tapRes = null;
      }
    } else {
      bp.tapOk = true;
    }
    if (!ws || ws.writableEnded) {
      bp.fileOk = true;
    } else if (!bp.fileOk && h.keepAlive) {
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes > PVR_RECORD_PENDING_MAX_BYTES && pending.length > 1) {
        pendingBytes -= pending.shift().length;
      }
      h._pendingBytes = pendingBytes;
    } else {
      bp.fileOk = ws.write(chunk) !== false;
      if (!bp.fileOk && h.keepAlive) {
        pending.push(chunk);
        pendingBytes += chunk.length;
        h._pendingBytes = pendingBytes;
      } else {
        flushPendingToDisk();
      }
    }
    if (!h.keepAlive && (!bp.tapOk || (!h.tapRes && !bp.fileOk))) upstream.pause();
  });

  upstream.on("error", fail);
  upstream.on("end", () => {
    if (h.keepAlive && !h.stopped && Date.now() < h.recordUntilMs) {
      void handleRecordingUpstreamLost(id, "end");
      return;
    }
    void finalizeRecordingStream(id);
  });

  if (!h._pendingDrainBound) {
    h._pendingDrainBound = true;
    ws?.on("drain", () => {
      flushPendingToDisk();
      resumeIfReady();
    });
  }
}

function attachRecordingFanout(id, upstream, recordOutput, filePath, tapMime, meta = {}) {
  const ws = recordOutput.writable;
  const keepAlive = !!meta.keepAlive;
  const recordUntilMs = typeof meta.recordUntilMs === "number" ? meta.recordUntilMs : 0;
  const deferMux = !!recordOutput.deferMux;
  let finalizeResolve;
  let finalizeReject;
  const done = deferMux
    ? new Promise((resolve, reject) => {
        finalizeResolve = resolve;
        finalizeReject = reject;
      })
    : recordOutput.done;
  const handle = {
    upstream: null,
    ws,
    filePath,
    tapRes: null,
    tapMime: tapMime || "video/mp2t",
    done,
    ffmpeg: recordOutput.child || null,
    tmpPath: recordOutput.tmpPath || null,
    keepAlive,
    recordUntilMs,
    url: typeof meta.url === "string" ? meta.url : "",
    compact: meta.compact !== false,
    stopped: false,
    finalizing: false,
    reconnecting: false,
    rotating: false,
    reconnectFail: 0,
    reconnectAttempt: 0,
    segmentPaths: [],
    segmentIndex: 0,
    hubKey: typeof meta.hubKey === "string" ? meta.hubKey : "",
    hubTeardown: typeof meta.hubTeardown === "function" ? meta.hubTeardown : null,
    lastSegmentRotateAt: 0,
    finalizeResolve,
    finalizeReject,
    _bp: { fileOk: true, tapOk: true },
  };

  const resumeIfReady = () => {
    const up = handle.upstream;
    if (!up || !up.isPaused()) return;
    if (handle._bp.fileOk && handle._bp.tapOk) up.resume();
  };

  ws.on("error", (err) => {
    console.error(`[PVR] Write stream error for ${id}:`, err?.message || err);
    if (handle.keepAlive && !handle.stopped && Date.now() < handle.recordUntilMs) {
      void handleRecordingUpstreamLost(id, "ws-error");
      return;
    }
    void finalizeRecordingStream(id);
  });

  ws.on("drain", () => {
    handle._bp.fileOk = true;
    resumeIfReady();
  });

  handle._onTapDrain = () => {
    handle._bp.tapOk = true;
    resumeIfReady();
  };

  streamRecordings.set(id, handle);
  bindRecordingUpstream(id, upstream);

  if (keepAlive && recordUntilMs > Date.now()) {
    const delayMs = recordUntilMs - Date.now();
    console.log(`[PVR] Auto-stop timer set for ${id}: ${(delayMs / 1000).toFixed(0)}s from now (until ${new Date(recordUntilMs).toISOString()})`);
    handle.stopTimer = setTimeout(() => {
      console.log(`[PVR] Auto-stop timer fired for ${id}`);
      void finalizeRecordingStream(id);
    }, delayMs);
  } else if (keepAlive) {
    console.log(`[PVR] WARNING: recordUntilMs (${recordUntilMs}) is in the past for ${id}, no auto-stop timer set.`);
  }

  if (keepAlive) {
    let bytesLogged = 0;
    const logInterval = setInterval(() => {
      const h2 = streamRecordings.get(id);
      if (!h2 || h2.stopped || h2.finalizing) { clearInterval(logInterval); return; }
      try {
        const tmpSz = h2.tmpPath ? fs.statSync(h2.tmpPath).size : 0;
        if (tmpSz !== bytesLogged) {
          bytesLogged = tmpSz;
          console.log(`[PVR] Recording ${id}: ${(tmpSz / 1024).toFixed(0)} KB written to ${path.basename(h2.tmpPath || '')}`);
        }
      } catch { /* noop */ }
    }, 10_000);
    handle._dataLogInterval = logInterval;
  }
}

function teardownRecording(id, removeMap) {
  const h = streamRecordings.get(id);
  if (!h) return;
  h.stopped = true;
  if (h.stopTimer) {
    clearTimeout(h.stopTimer);
    h.stopTimer = null;
  }
  if (h.reconnectTimer) {
    clearTimeout(h.reconnectTimer);
    h.reconnectTimer = null;
  }
  if (h.keepAlive) {
    void finalizeRecordingStream(id).finally(() => {
      if (removeMap) streamRecordings.delete(id);
    });
    return;
  }
  try {
    if (h.ws && !h.ws.writableEnded) h.ws.end();
  } catch {
    /* noop */
  }
  try {
    if (h.hubTeardown) {
      try {
        h.hubTeardown();
      } catch {
        /* noop */
      }
      h.hubTeardown = null;
    }
  } catch {
    /* noop */
  }
  try {
    if (h.upstream) {
      h.upstream.removeAllListeners();
      if (!h.hubKey) h.upstream.destroy();
    }
  } catch {
    /* noop */
  }
  try {
    if (h.child && !h.child.killed) {
      h.child.kill("SIGINT");
      setTimeout(() => {
        try {
          if (!h.child.killed) h.child.kill("SIGTERM");
        } catch {
          /* noop */
        }
      }, 3500);
    }
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
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    throw new Error(`Cannot create recording folder: ${e.message}`);
  }
  const url = assertPlaylistUrlForMain(payload?.url);
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const tapMime = normalizeRecordTapMime(payload?.tapContentType);
  const recordMode = normalizeRecordMode(payload?.recordMode, url, tapMime);
  const requestedFilenameExt = normalizeRecordFilenameExt(payload?.filenameExt);
  const filenameExt = recordMode === "hls" || recordMode === "mpegts" ? ".mp4" : requestedFilenameExt;
  const sanitizeRecordBasename = (raw) => {
    const base = String(raw || "")
      .trim()
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .replace(/^_|_$/g, "");
    if (!base || base === "." || base === "..") return null;
    return base.slice(0, 180);
  };
  const customBasename = sanitizeRecordBasename(payload?.outputBasename);
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  const defaultName = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}${filenameExt}`;
  let name = customBasename
    ? customBasename.toLowerCase().endsWith(filenameExt.toLowerCase())
      ? customBasename
      : `${customBasename}${filenameExt}`
    : defaultName;
  let filePath = path.join(outDir, name);
  if (customBasename) {
    let n = 2;
    while (fs.existsSync(filePath)) {
      const stem = `${customBasename}_${n}`;
      name = `${stem}${filenameExt}`;
      filePath = path.join(outDir, name);
      n += 1;
    }
  }
  allowedRecordOutputDirs.add(path.resolve(outDir));
  allowedRecordRevealPaths.add(path.resolve(filePath));
  console.log(`[PVR] Starting recording ${id}: mode=${recordMode}, keepAlive=${payload?.keepAlive}, file=${filePath}, outDir=${outDir}`);
  console.log(`[PVR]   url=${url.slice(0, 120)}`);
  console.log(`[PVR]   recordUntilMs=${payload?.recordUntilMs} (${payload?.recordUntilMs ? new Date(payload.recordUntilMs).toISOString() : 'none'})`);
  const recordingCompact = payload?.recordingCompact !== false;
  const keepAlive = payload?.keepAlive === true;
  const recordUntilMs =
    typeof payload?.recordUntilMs === "number" && Number.isFinite(payload.recordUntilMs)
      ? payload.recordUntilMs
      : 0;
  const recordMeta = { keepAlive, recordUntilMs, url };
  if (recordMode === "hls") {
    return startFfmpegHlsRecording(id, url, filePath, recordingCompact, recordMeta);
  }
  const recordOutput = createRecordingOutput(
    filePath,
    recordMode === "mpegts" ? "video/mp2t" : tapMime,
    recordingCompact,
    keepAlive && recordMode === "mpegts" ? { deferMux: true, segmentIndex: 0 } : {}
  );
  let upstream;
  let hubMeta = {};
  const useSharedHub = recordMode === "mpegts";
  if (useSharedHub) {
    try {
      const hubbed = createHubRecordingStream(url, keepAlive);
      upstream = hubbed.stream;
      hubMeta = { hubKey: hubbed.hubKey, hubTeardown: hubbed.teardown };
    } catch (e) {
      recordOutput.writable.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* noop */
      }
      try {
        if (recordOutput.tmpPath) fs.unlinkSync(recordOutput.tmpPath);
      } catch {
        /* noop */
      }
      throw new Error(e instanceof Error ? e.message : "Network error");
    }
  } else {
    let res;
    try {
      res = await net.fetch(url, { headers: streamRecordHeaders(url) });
    } catch (e) {
      recordOutput.writable.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* noop */
      }
      try {
        if (recordOutput.tmpPath) fs.unlinkSync(recordOutput.tmpPath);
      } catch {
        /* noop */
      }
      throw new Error(e instanceof Error ? e.message : "Network error");
    }
    if (!res.ok) {
      recordOutput.writable.destroy();
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* noop */
      }
      try {
        if (recordOutput.tmpPath) fs.unlinkSync(recordOutput.tmpPath);
      } catch {
        /* noop */
      }
      throw new Error(`HTTP ${res.status}`);
    }
    if (!res.body) {
      recordOutput.writable.end();
      return { ok: true, id, filePath, playbackUrl: null };
    }
    upstream = Readable.fromWeb(res.body);
  }
  attachRecordingFanout(
    id,
    upstream,
    recordOutput,
    filePath,
    recordMode === "mpegts" ? "video/mp2t" : tapMime,
    { ...recordMeta, compact: recordingCompact, ...hubMeta }
  );
  const playbackUrl =
    rendererOrigin != null
      ? `${rendererOrigin}/__tap/stream?id=${encodeURIComponent(id)}&token=${encodeURIComponent(streamProxySessionToken ?? "")}`
      : null;
  return { ok: true, id, filePath, playbackUrl };
});

ipcMain.handle("iptv-stop-stream-record", async (_evt, id) => {
  const h = streamRecordings.get(id);
  if (!h) return { ok: true };
  console.log(`[PVR] Stopping recording ${id}, filePath=${h.filePath}`);
  const done = h.done;
  const filePath = h.filePath;
  teardownRecording(id, true);
  if (done) {
    try {
      await Promise.race([
        done,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Recording is still finalizing. Try opening the folder in a moment.")), 120_000)
        ),
      ]);
      console.log(`[PVR] Recording ${id} finalized OK.`);
    } catch (e) {
      console.error(`[PVR] Recording ${id} finalize error:`, e?.message || e);
      throw e;
    }
  }
  return { ok: true, filePath };
});

const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_DTYPE = "q8";
const KOKORO_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-US", gender: "female", accent: "American", grade: "A" },
  { id: "af_bella", name: "Bella", language: "en-US", gender: "female", accent: "American", grade: "A-" },
  { id: "af_nicole", name: "Nicole", language: "en-US", gender: "female", accent: "American", grade: "B-" },
  { id: "af_sarah", name: "Sarah", language: "en-US", gender: "female", accent: "American", grade: "C+" },
  { id: "am_michael", name: "Michael", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "am_puck", name: "Puck", language: "en-US", gender: "male", accent: "American", grade: "C+" },
  { id: "bf_emma", name: "Emma", language: "en-GB", gender: "female", accent: "British", grade: "B-" },
  { id: "bf_isabella", name: "Isabella", language: "en-GB", gender: "female", accent: "British", grade: "C" },
  { id: "bm_george", name: "George", language: "en-GB", gender: "male", accent: "British", grade: "C" },
  { id: "bm_fable", name: "Fable", language: "en-GB", gender: "male", accent: "British", grade: "C" },
];
const KOKORO_VOICE_IDS = new Set(KOKORO_VOICES.map((v) => v.id));
const NEURAL_TTS_MAX_TEXT_CHARS = 640;
const NEURAL_TTS_MAX_CACHE_BYTES = 256 * 1024 * 1024;
const PIPER_VOICE_ID_PREFIX = "piper:";
let kokoroTtsPromise = null;
const neuralTtsInFlight = new Map();
let neuralTtsQueue = Promise.resolve();
let neuralTtsGeneration = 0;
let neuralTtsCleanupPromise = null;
let kokoroUnloadTimer = null;
let piperRuntimeProbePromise = null;

function neuralTtsCacheDir() {
  return path.join(app.getPath("userData"), "neural-tts-cache");
}

function neuralTtsModelCacheDir() {
  return path.join(app.getPath("userData"), "neural-tts-models");
}

function piperVoicePacksDir() {
  return path.join(app.getPath("userData"), "voice-packs");
}

function normalizeNeuralTtsText(raw) {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NEURAL_TTS_MAX_TEXT_CHARS);
}

function neuralTtsCacheKey({ text, voice, speed, style, engine = "kokoro-js", model = KOKORO_MODEL_ID }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ engine, model, dtype: engine === "kokoro-js" ? KOKORO_DTYPE : "external", voice, speed, style, text }))
    .digest("hex")
    .slice(0, 48);
}

async function loadKokoroTts() {
  if (kokoroUnloadTimer) {
    clearTimeout(kokoroUnloadTimer);
    kokoroUnloadTimer = null;
  }
  if (!kokoroTtsPromise) {
    kokoroTtsPromise = (async () => {
      process.env.OMP_NUM_THREADS ||= "1";
      process.env.ORT_NUM_THREADS ||= "1";
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = neuralTtsModelCacheDir();
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = true;
      transformers.env.useFS = true;
      transformers.env.useFSCache = true;
      const { KokoroTTS } = await import("kokoro-js");
      return KokoroTTS.from_pretrained(KOKORO_MODEL_ID, {
        dtype: KOKORO_DTYPE,
        device: "cpu",
        session_options: {
          interOpNumThreads: 1,
          intraOpNumThreads: 1,
          executionMode: "sequential",
        },
      });
    })().catch((err) => {
      kokoroTtsPromise = null;
      throw err;
    });
  }
  return kokoroTtsPromise;
}

function scheduleKokoroUnload(delayMs = 180_000) {
  if (kokoroUnloadTimer) clearTimeout(kokoroUnloadTimer);
  kokoroUnloadTimer = setTimeout(() => {
    if (neuralTtsInFlight.size > 0) {
      scheduleKokoroUnload(delayMs);
      return;
    }
    kokoroTtsPromise = null;
    kokoroUnloadTimer = null;
    if (typeof global.gc === "function") {
      try {
        global.gc();
      } catch {
        /* gc is not normally exposed; ignore */
      }
    }
  }, delayMs);
}

async function cleanupNeuralTtsCache() {
  if (neuralTtsCleanupPromise) return neuralTtsCleanupPromise;
  neuralTtsCleanupPromise = (async () => {
    const dir = neuralTtsCacheDir();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".wav")) continue;
      const fp = path.join(dir, entry.name);
      try {
        const st = await fs.promises.stat(fp);
        files.push({ fp, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* ignore missing cache files */
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= NEURAL_TTS_MAX_CACHE_BYTES) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= NEURAL_TTS_MAX_CACHE_BYTES * 0.8) break;
      try {
        await fs.promises.unlink(file.fp);
        total -= file.size;
      } catch {
        /* best-effort cache cleanup */
      }
    }
  })().finally(() => {
    neuralTtsCleanupPromise = null;
  });
  return neuralTtsCleanupPromise;
}

function enqueueNeuralTtsWork(work) {
  const run = neuralTtsQueue.catch(() => undefined).then(work);
  neuralTtsQueue = run.catch(() => undefined);
  return run;
}

async function fileExists(fp) {
  try {
    await fs.promises.access(fp, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolvePiperExecutable() {
  const envPath = String(process.env.PIPER_BINARY_PATH || "").trim();
  const candidates = [
    envPath,
    process.resourcesPath ? path.join(process.resourcesPath, "piper", process.platform === "win32" ? "piper.exe" : "piper") : "",
    path.join(__dirname, "piper", process.platform === "win32" ? "piper.exe" : "piper"),
    path.join(process.cwd(), "piper", process.platform === "win32" ? "piper.exe" : "piper"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "piper";
}

function runProcessCapture(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { stdin, timeoutMs, ...spawnOpts } = opts;
    const child = spawn(command, args, { windowsHide: process.platform === "win32", ...spawnOpts });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;
    const timeout = Number(timeoutMs ?? 0);
    const timer =
      timeout > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
              child.kill("SIGTERM");
            } catch {
              /* noop */
            }
            reject(new Error(`${path.basename(command)} timed out.`));
          }, timeout)
        : null;
    child.stdout?.on("data", (d) => stdoutChunks.push(d));
    child.stderr?.on("data", (d) => stderrChunks.push(d));
    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}.`));
    });
    if (stdin != null) {
      child.stdin?.end(String(stdin));
    }
  });
}

async function hasPiperRuntime() {
  if (piperRuntimeProbePromise) return piperRuntimeProbePromise;
  piperRuntimeProbePromise = (async () => {
    const exe = await resolvePiperExecutable();
    await runProcessCapture(exe, ["--help"], { timeoutMs: 2500 });
    return true;
  })().catch(() => false);
  return piperRuntimeProbePromise;
}

async function requirePiperRuntime() {
  const exe = await resolvePiperExecutable();
  try {
    await runProcessCapture(exe, ["--help"], { timeoutMs: 2500 });
    return exe;
  } catch (err) {
    throw new Error(
      `Piper runtime is not available. Install Piper, add it to PATH, set PIPER_BINARY_PATH, or place the binary in the app's piper folder. ${err.message}`
    );
  }
}

async function listPiperVoicePacks({ requireRuntime = true } = {}) {
  if (requireRuntime && !(await hasPiperRuntime())) return [];
  let entries;
  try {
    entries = await fs.promises.readdir(piperVoicePacksDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const packs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(piperVoicePacksDir(), entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    try {
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      if (manifest?.engine !== "piper-vits") continue;
      const modelPath = path.join(dir, "model.onnx");
      const configPath = path.join(dir, "piper.onnx.json");
      if (!(await fileExists(modelPath)) || !(await fileExists(configPath))) continue;
      const packId = String(manifest.id || entry.name).replace(/[^a-zA-Z0-9._-]/g, "-");
      packs.push({
        id: `${PIPER_VOICE_ID_PREFIX}${packId}`,
        name: String(manifest.displayName || entry.name),
        language: String(manifest.language || "unknown"),
        gender: String(manifest.gender || "unknown"),
        accent: String(manifest.accent || "custom"),
        grade: "custom",
        engine: "piper-vits",
        model: modelPath,
        config: configPath,
        packDir: dir,
        recommendedSpeed:
          typeof manifest.recommendedSpeed === "number" && Number.isFinite(manifest.recommendedSpeed)
            ? manifest.recommendedSpeed
            : undefined,
      });
    } catch {
      /* ignore malformed packs */
    }
  }
  return packs;
}

async function synthesizePiperTts({ voiceId, text, speed, style, requestGeneration, prefetch }) {
  const packs = await listPiperVoicePacks({ requireRuntime: true });
  const pack = packs.find((v) => v.id === voiceId);
  if (!pack) throw new Error(`Piper voice pack not found. Put packs in ${piperVoicePacksDir()}.`);
  const dir = neuralTtsCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const piperSpeed = Math.min(1.7, Math.max(0.45, speed));
  const lengthScale = Math.min(2.2, Math.max(0.45, 1 / piperSpeed));
  const key = neuralTtsCacheKey({ text, voice: voiceId, speed: piperSpeed, style, engine: "piper-vits", model: pack.model });
  const outPath = path.join(dir, `${key}.wav`);
  const inFlightKey = `${key}:${requestGeneration}`;
  try {
    const st = await fs.promises.stat(outPath);
    if (st.isFile() && st.size > 44) {
      return { ok: true, engine: "piper-vits", cached: true, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
    }
  } catch {
    /* synthesize below */
  }
  if (prefetch && neuralTtsInFlight.size > 0) {
    return { ok: false, skipped: true, reason: "busy" };
  }
  if (!neuralTtsInFlight.has(inFlightKey)) {
    neuralTtsInFlight.set(
      inFlightKey,
      enqueueNeuralTtsWork(async () => {
        if (requestGeneration !== neuralTtsGeneration) return { ok: false, canceled: true };
        const exe = await requirePiperRuntime();
        await runProcessCapture(
          exe,
          ["--model", pack.model, "--config", pack.config, "--length_scale", String(lengthScale), "--output_file", outPath],
          { stdin: `${text}\n`, timeoutMs: 60_000 }
        );
        if (requestGeneration !== neuralTtsGeneration) return { ok: false, canceled: true };
        void cleanupNeuralTtsCache();
        return { ok: true, engine: "piper-vits", cached: false, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
      }).finally(() => {
        neuralTtsInFlight.delete(inFlightKey);
      })
    );
  }
  return await neuralTtsInFlight.get(inFlightKey);
}

ipcMain.handle("iptv-neural-tts-voices", async () => {
  const piperVoices = await listPiperVoicePacks({ requireRuntime: false });
  return {
    ok: true,
    engine: piperVoices.length ? "piper-vits+kokoro-js" : "kokoro-js",
    model: KOKORO_MODEL_ID,
    modelCacheDir: neuralTtsModelCacheDir(),
    audioCacheDir: neuralTtsCacheDir(),
    piperVoicePacksDir: piperVoicePacksDir(),
    voices: [
      ...piperVoices.map(({ model, config, packDir, recommendedSpeed, ...voice }) => voice),
      ...KOKORO_VOICES.map((voice) => ({ ...voice, engine: "kokoro-js" })),
    ],
  };
});

ipcMain.handle("iptv-neural-tts-warmup", async () =>
  enqueueNeuralTtsWork(async () => {
    await loadKokoroTts();
    scheduleKokoroUnload(300_000);
    return { ok: true, engine: "kokoro-js", model: KOKORO_MODEL_ID };
  })
);

ipcMain.handle("iptv-neural-tts-cancel", async () => {
  neuralTtsGeneration += 1;
  scheduleKokoroUnload(45_000);
  return { ok: true };
});

ipcMain.handle("iptv-neural-tts-synthesize", async (_evt, rawPayload) => {
  const p = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
  const text = normalizeNeuralTtsText(p.text);
  if (!text) throw new Error("No text to synthesize.");
  const rawVoice = typeof p.voice === "string" ? p.voice : "";
  const speedRaw = Number(p.speed);
  const speed = Number.isFinite(speedRaw) ? Math.min(1.35, Math.max(0.65, speedRaw)) : 1;
  const style = typeof p.style === "string" ? p.style.slice(0, 40) : "warm";
  const prefetch = p.prefetch === true;
  const requestGeneration = neuralTtsGeneration;
  if (rawVoice.startsWith(PIPER_VOICE_ID_PREFIX)) {
    return await synthesizePiperTts({ voiceId: rawVoice, text, speed, style, requestGeneration, prefetch });
  }
  const voice = KOKORO_VOICE_IDS.has(rawVoice) ? rawVoice : "af_heart";
  const dir = neuralTtsCacheDir();
  await fs.promises.mkdir(dir, { recursive: true });
  const key = neuralTtsCacheKey({ text, voice, speed, style });
  const outPath = path.join(dir, `${key}.wav`);
  const inFlightKey = `${key}:${requestGeneration}`;
  try {
    const st = await fs.promises.stat(outPath);
    if (st.isFile() && st.size > 44) {
      return { ok: true, engine: "kokoro-js", cached: true, path: outPath, url: pathToFileURL(outPath).toString(), durationMs: null };
    }
  } catch {
    /* synthesize below */
  }
  if (prefetch && neuralTtsInFlight.size > 0) {
    return { ok: false, skipped: true, reason: "busy" };
  }
  if (!neuralTtsInFlight.has(inFlightKey)) {
    neuralTtsInFlight.set(
      inFlightKey,
      enqueueNeuralTtsWork(async () => {
        if (requestGeneration !== neuralTtsGeneration) {
          return { ok: false, canceled: true };
        }
        const tts = await loadKokoroTts();
        const audio = await tts.generate(text, { voice, speed });
        if (requestGeneration !== neuralTtsGeneration) {
          return { ok: false, canceled: true };
        }
        await audio.save(outPath);
        void cleanupNeuralTtsCache();
        scheduleKokoroUnload();
        const samples = Number(audio.audio?.length ?? 0);
        const sampleRate = Number(audio.sampling_rate ?? 0);
        const durationMs = samples > 0 && sampleRate > 0 ? Math.round((samples / sampleRate) * 1000) : null;
        return {
          ok: true,
          engine: "kokoro-js",
          cached: false,
          path: outPath,
          url: pathToFileURL(outPath).toString(),
          durationMs,
        };
      }).finally(() => {
        neuralTtsInFlight.delete(inFlightKey);
      })
    );
  }
  return await neuralTtsInFlight.get(inFlightKey);
});

/** Desktop: local Whisper model status for live radio captions. */
ipcMain.handle("iptv-whisper-status", async () => whisperStt.getWhisperStatus());

/** Desktop: select Xenova Whisper variant (tiny | base | small). */
ipcMain.handle("iptv-whisper-set-model", async (_evt, modelKey) => {
  if (typeof modelKey !== "string" || !modelKey.trim()) {
    return { ok: false, error: "Invalid model." };
  }
  return whisperStt.setWhisperModel(modelKey.trim());
});

/** Desktop: load Whisper ONNX model (downloads on first run). */
ipcMain.handle("iptv-whisper-warmup", async () => whisperStt.warmupWhisper());

/** Desktop: transcribe Float32 PCM mono @ 16 kHz (low-latency live captions). */
ipcMain.handle("iptv-whisper-transcribe-pcm", async (_evt, rawBuf) => {
  if (!rawBuf) return { ok: false, error: "No audio data." };
  if (rawBuf instanceof ArrayBuffer) return whisperStt.transcribePcmFloat32(rawBuf);
  if (ArrayBuffer.isView(rawBuf)) {
    return whisperStt.transcribePcmFloat32(
      rawBuf.buffer.slice(rawBuf.byteOffset, rawBuf.byteOffset + rawBuf.byteLength)
    );
  }
  return { ok: false, error: "Invalid PCM buffer." };
});

/** Desktop: transcribe one WebM/OGG chunk (legacy MediaRecorder path). */
ipcMain.handle("iptv-whisper-transcribe-chunk", async (_evt, rawBuf) => {
  if (!rawBuf) return { ok: false, error: "No audio data." };
  let buf = rawBuf;
  if (ArrayBuffer.isView(rawBuf)) {
    buf = Buffer.from(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength);
  } else if (rawBuf instanceof ArrayBuffer) {
    buf = Buffer.from(rawBuf);
  } else if (!Buffer.isBuffer(rawBuf)) {
    return { ok: false, error: "Invalid audio buffer." };
  }
  return whisperStt.transcribeWebmChunk(buf);
});

/** Reveal the recorded file in Finder / File Explorer / file manager. */
ipcMain.handle("iptv-show-record-in-folder", async (_evt, rawPath) => {
  const resolved = assertAllowedRecordRevealPath(rawPath);
  shell.showItemInFolder(resolved);
  return { ok: true };
});

app.on("before-quit", () => {
  for (const id of [...streamRecordings.keys()]) {
    teardownRecording(id, true);
  }
  for (const s of staticServers) {
    try {
      s.close();
    } catch {
      /* noop */
    }
  }
  staticServers = [];
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
  return assertSafeFetchUrl(raw, "target URL");
}

async function waitForMkvHlsFile(filePath, child, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode != null && child.exitCode !== 0) {
      throw new Error(`ffmpeg exited ${child.exitCode} while preparing playback.`);
    }
    try {
      const st = await fs.promises.stat(filePath);
      if (st.size > 0) return st;
      if (child && child.exitCode === 0) return st;
    } catch (e) {
      if (e && e.code !== "ENOENT") throw e;
    }
    await sleepMs(180);
  }
  throw new Error("Timed out waiting for remuxed video data.");
}

async function tryServeMkvPlayback(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }

  const mHls = u.pathname.match(/^\/__mkv-playback\/([a-f0-9]{48})\/(index\.m3u8|seg\d+\.ts)$/i);
  const mMp4 = u.pathname.match(/^\/__mkv-playback\/([a-f0-9]{48})\.mp4$/i);
  const cacheKey = mHls?.[1] ?? mMp4?.[1];
  if (!cacheKey) return false;

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] || "Range",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" }).end("Method not allowed");
    return true;
  }

  let filePath = null;
  let contentType = "application/octet-stream";
  if (mHls) {
    filePath = mkvHlsFilePath(cacheKey, mHls[2]);
    contentType = mHls[2].toLowerCase().endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t";
  } else {
    filePath = mkvCacheFilePath(cacheKey);
    contentType = "video/mp4";
  }
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    return true;
  }

  const session = mkvPlaybackSessions.get(cacheKey);
  const child = session?.child ?? null;

  let st;
  try {
    st = await waitForMkvHlsFile(filePath, child, mHls ? 90_000 : 45_000);
  } catch (e) {
    res
      .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
      .end(e instanceof Error ? e.message : "MKV playback not ready");
    return true;
  }

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "Content-Length": String(st.size),
  };

  if (req.method === "HEAD") {
    res.writeHead(200, headers).end();
    return true;
  }

  if (mHls && mHls[2].toLowerCase() === "index.m3u8") {
    try {
      let text = await fs.promises.readFile(filePath, "utf8");
      const token = u.searchParams.get("token") || streamProxySessionToken || "";
      const base = `${u.protocol}//${u.host}/__mkv-playback/${cacheKey}/`;
      const qs = token ? `?token=${encodeURIComponent(token)}` : "";
      text = text
        .split("\n")
        .map((line) => {
          const t = line.trim();
          if (!/^seg\d+\.ts$/i.test(t)) return line;
          return `${base}${t}${qs}`;
        })
        .join("\n");
      const body = Buffer.from(text, "utf8");
      headers["Content-Length"] = String(body.length);
      res.writeHead(200, headers).end(body);
      return true;
    } catch (e) {
      res
        .writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
        .end(e instanceof Error ? e.message : "MKV playlist not ready");
      return true;
    }
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  stream.pipe(res);
  return true;
}

async function tryServeStreamProxy(req, res) {
  let u;
  try {
    u = new URL(req.url || "/", "http://127.0.0.1");
  } catch {
    return false;
  }
  if (u.pathname !== "/__proxy/stream") return false;

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

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
  const isVod = /\.(mkv|mp4|avi|mov|mka)/i.test(validated);
  // Use VLC-like user agent for VOD files - some IPTV servers block browsers
  const userAgent = isVod
    ? "VLC/3.0.18 LibVLC/3.0.18"
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
  const headers = {
    "User-Agent": userAgent,
    Referer: `${tObj.origin}/`,
  };
  if (isVod) {
    headers.Accept = "*/*";
    headers["Accept-Language"] = "en-US,en;q=0.9";
    headers["Icy-MetaData"] = "1";
  }
  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  let up;
  try {
    console.log(`[Proxy] Fetching upstream: ${validated.slice(0, 120)}`);
    // Add timeout for MKV/VOD files that may be slow to respond
    const fetchTimeout = isVod ? 30000 : 10000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);
    up = await net.fetch(validated, { method: req.method, headers, signal: controller.signal });
    clearTimeout(timeoutId);
    console.log(`[Proxy] Upstream response: ${up.status} ${up.statusText}`);
    if (!up.ok && up.status >= 400) {
      console.error(`[Proxy] Upstream returned error status: ${up.status}`);
    }
  } catch (e) {
    console.error(`[Proxy] Upstream fetch FAILED: ${e instanceof Error ? e.message : String(e)}`);
    res
      .writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
      .end(e instanceof Error ? e.message : "Upstream fetch failed (check VPN/connection)");
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

  try {
    assertStreamProxySessionToken(req.url || "/");
  } catch (e) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" }).end(e instanceof Error ? e.message : "Forbidden");
    return true;
  }

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
  if (pathname === "/__proxy/stream" || pathname === "/__tap/stream" || pathname.startsWith("/__mkv-playback/")) {
    return null;
  }
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
/** Max offset for the second static server on the same primary attempt. */
const STATIC_SERVER_SECOND_PORT_SPAN = 96;

function iptvReservedPortEnd() {
  return STATIC_SERVER_PREFERRED_PORT + STATIC_SERVER_PORT_TRIES - 1 + STATIC_SERVER_SECOND_PORT_SPAN;
}

function isTcpPortListening(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const socket = nodeNet.connect({ port, host });
    const done = (listening) => {
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      resolve(listening);
    };
    socket.setTimeout(400);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function killListenersOnPort(port) {
  if (process.platform === "win32") {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (/^\d+$/.test(pid)) pids.add(pid);
      }
      for (const pid of pids) {
        if (pid === String(process.pid)) continue;
        try {
          execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        } catch {
          /* noop */
        }
      }
    } catch {
      /* no listener */
    }
    return;
  }
  try {
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    for (const pid of out.trim().split(/\s+/).filter(Boolean)) {
      if (pid === String(process.pid)) continue;
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          /* noop */
        }
      }
    }
  } catch {
    /* no listener */
  }
}

/** Stop stale listeners in the IPTV port range (e.g. crashed Electron still holding 48752). */
async function releaseIptvPortsBeforeStart() {
  const start = STATIC_SERVER_PREFERRED_PORT;
  const end = iptvReservedPortEnd();
  const busy = [];
  for (let port = start; port <= end; port++) {
    if (await isTcpPortListening(port)) busy.push(port);
  }
  if (!busy.length) return;
  console.warn(
    `IPTV: freeing ${busy.length} reserved port(s) still listening: ${busy.slice(0, 6).join(", ")}${busy.length > 6 ? "…" : ""}`
  );
  for (const port of busy) {
    killListenersOnPort(port);
  }
  await new Promise((r) => setTimeout(r, 250));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await isTcpPortListening(STATIC_SERVER_PREFERRED_PORT))) return;
    killListenersOnPort(STATIC_SERVER_PREFERRED_PORT);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function createStaticRequestHandler(root) {
  return (req, res) => {
    void (async () => {
      try {
        if (await tryServeStreamTap(req, res)) return;
        if (await tryServeMkvPlayback(req, res)) return;
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
        if (ext === ".html") {
          res.setHeader("Content-Security-Policy", APP_CSP);
        }
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
    await releaseIptvPortsBeforeStart();
    streamProxySessionToken = crypto.randomBytes(32).toString("hex");
    for (let i = 0; i < STATIC_SERVER_PORT_TRIES; i++) {
      const port1 = STATIC_SERVER_PREFERRED_PORT + i;
      try {
        const first = await listenOnPort(port1);
        let second = null;
        for (let k = 1; k <= STATIC_SERVER_SECOND_PORT_SPAN; k++) {
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
  const preferenceMenu = {
    label: "Preferences",
    submenu: [
      {
        id: "split-screen-preference",
        label: "Enable split screen",
        type: "checkbox",
        checked: splitScreenPreferenceEnabled,
        click: (item) => {
          splitScreenPreferenceEnabled = !!item.checked;
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
          win?.webContents.send("iptv-split-screen-preference-change", splitScreenPreferenceEnabled);
        },
      },
    ],
  };
  const editMenu = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
      { role: "delete" },
      { type: "separator" },
      { role: "selectAll" },
    ],
  };
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
          { label: "File", submenu: [preferenceMenu, { type: "separator" }, { role: "close" }] },
        ]
      : [{ label: "File", submenu: [preferenceMenu, { type: "separator" }, { role: "quit", label: "Exit" }] }]),
    editMenu,
    {
      label: "View",
      submenu: [{ role: "togglefullscreen", label: "Full screen" }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** Right-click: copy/paste and link actions (Chromium does not show a menu without this in Electron). */
function installWebContentsContextMenu(win) {
  win.webContents.on("context-menu", (_event, params) => {
    const ef = params.editFlags || {};
    /** @type {Electron.MenuItemConstructorOptions[]} */
    const template = [];

    if (params.linkURL?.trim()) {
      try {
        const u = params.linkURL.trim();
        new URL(u);
        template.push({
          label: "Open link in browser",
          click: () => void shell.openExternal(u),
        });
        template.push({
          label: "Copy link address",
          click: () => clipboard.writeText(u),
        });
        template.push({ type: "separator" });
      } catch {
        /* ignore malformed link */
      }
    }

    if (params.selectionText && String(params.selectionText).trim() && !ef.canCopy) {
      template.push({
        label: "Copy",
        click: () => clipboard.writeText(String(params.selectionText)),
      });
    }

    if (ef.canUndo) template.push({ role: "undo" });
    if (ef.canRedo) template.push({ role: "redo" });
    if (ef.canUndo || ef.canRedo) template.push({ type: "separator" });

    if (ef.canCut) template.push({ role: "cut" });
    if (ef.canCopy) template.push({ role: "copy" });
    if (ef.canPaste) template.push({ role: "paste" });
    if (process.platform === "darwin" && ef.canPaste) {
      template.push({ role: "pasteAndMatchStyle" });
    }
    if (ef.canDelete) template.push({ role: "delete" });
    if (ef.canSelectAll) {
      if (template.length) template.push({ type: "separator" });
      template.push({ role: "selectAll" });
    }

    if (!template.length) return;
    Menu.buildFromTemplate(template).popup({ window: win });
  });
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
      "Player",
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
    title: "Player",
    fullscreenable: true,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      /* Spellcheck builds a large dictionary in the renderer; IPTV UI is not document editing. */
      spellcheck: false,
      /* IPTV streams and M3U hosts often lack CORS; desktop shell matches typical IPTV desktop players. */
      webSecurity: false,
    },
    show: false,
  });

  installWebContentsContextMenu(win);

  win.once("ready-to-show", () => {
    if (wb.isMaximized) win.maximize();
    win.show();
  });
  await win.loadURL(appUrl);

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const u = new URL(url);
      if (u.protocol === "http:" || u.protocol === "https:") {
        void shell.openExternal(u.toString());
      }
    } catch {
      /* ignore malformed URLs */
    }
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    try {
      if (rendererOrigin && new URL(url).origin !== rendererOrigin) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });

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

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
      const win = windows[0];
      if (win.isMinimized()) win.restore();
      win.focus();
    } else if (app.isReady()) {
      void createWindow();
    }
  });

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
}
