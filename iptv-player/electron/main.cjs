/**
 * IPTV Player — Electron shell.
 * Serves the Vite `dist` folder over http://127.0.0.1 so playlist/stream fetches behave like a normal web origin
 * (avoids file:// + CORS issues). Requires Windows 10 or later 64-bit (Electron/Chromium limitation).
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");

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

function distDir() {
  return path.join(__dirname, "..", "dist");
}

function safeFilePath(root, reqUrl) {
  let pathname = "/";
  try {
    pathname = new URL(reqUrl, "http://127.0.0.1").pathname || "/";
  } catch {
    return null;
  }
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = path.resolve(path.join(root, rel));
  const rootResolved = path.resolve(root);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (full !== rootResolved && !full.startsWith(prefix)) return null;
  return full;
}

function startStaticServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
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
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

let staticServer = null;

async function createWindow() {
  const root = distDir();
  if (!fs.existsSync(path.join(root, "index.html"))) {
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "IPTV Player",
      "Built UI not found (missing dist/index.html). Run npm run build first, then rebuild the desktop app."
    );
    app.quit();
    return;
  }

  const { server, url } = await startStaticServer(root);
  staticServer = server;

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "IPTV Player",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      /* IPTV streams and M3U hosts often lack CORS; desktop shell matches typical IPTV desktop players. */
      webSecurity: false,
    },
    show: false,
  });

  win.once("ready-to-show", () => win.show());
  await win.loadURL(url);

  win.on("closed", () => {
    if (staticServer) {
      staticServer.close();
      staticServer = null;
    }
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (staticServer) {
    staticServer.close();
    staticServer = null;
  }
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});
