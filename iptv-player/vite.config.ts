import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function playlistProxyDevPlugin() {
  return {
    name: "iptv-m3u-playlist-proxy",
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          try {
            if (req.method !== "GET" || !req.url?.startsWith("/__proxy/m3u")) {
              next();
              return;
            }
            const loc = new URL(req.url, "http://localhost");
            const target = loc.searchParams.get("target");
            if (!target) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("Missing target query parameter.");
              return;
            }
            let t: URL;
            try {
              t = new URL(target);
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("Invalid target URL.");
              return;
            }
            if (t.protocol !== "http:" && t.protocol !== "https:") {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("Only http(s) targets are allowed.");
              return;
            }
            const host = t.hostname.toLowerCase();
            if (host === "169.254.169.254" || host === "metadata.google.internal") {
              res.statusCode = 403;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end("Host blocked.");
              return;
            }
            const r = await fetch(t, {
              headers: { "User-Agent": "IPTV-Player-Dev-Proxy/1.0" },
              signal: AbortSignal.timeout(120_000),
            });
            const body = await r.text();
            res.statusCode = r.status;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(body);
          } catch (e) {
            res.statusCode = 502;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end(e instanceof Error ? e.message : "Proxy error");
          }
        }
      );
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), playlistProxyDevPlugin()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
