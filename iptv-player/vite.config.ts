import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function assertHttpUrlForProxy(raw: string): URL {
  let t: URL;
  try {
    t = new URL(raw);
  } catch {
    throw new Error("Invalid target URL.");
  }
  if (t.protocol !== "http:" && t.protocol !== "https:") {
    throw new Error("Only http(s) targets are allowed.");
  }
  const host = t.hostname.toLowerCase();
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    throw new Error("Host blocked.");
  }
  return t;
}

function playlistProxyDevPlugin() {
  return {
    name: "iptv-m3u-playlist-proxy",
    enforce: "pre" as const,
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      server.middlewares.use(
        async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          try {
            if (req.url?.startsWith("/__proxy/stream")) {
              const loc = new URL(req.url, "http://localhost");
              if (req.method === "OPTIONS") {
                res.statusCode = 204;
                res.setHeader("Access-Control-Allow-Origin", "*");
                res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                res.setHeader(
                  "Access-Control-Allow-Headers",
                  (req.headers["access-control-request-headers"] as string) || "*"
                );
                res.setHeader("Access-Control-Max-Age", "86400");
                res.end();
                return;
              }
              if (req.method !== "GET" && req.method !== "HEAD") {
                res.statusCode = 405;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Method not allowed");
                return;
              }
              const target = loc.searchParams.get("url");
              if (!target) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end("Missing url query parameter.");
                return;
              }
              let t: URL;
              try {
                t = assertHttpUrlForProxy(target);
              } catch (err) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.end(err instanceof Error ? err.message : "Bad request");
                return;
              }
              const upstreamHeaders: Record<string, string> = {
                "User-Agent":
                  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                Referer: `${t.origin}/`,
              };
              const range = req.headers.range;
              if (typeof range === "string") upstreamHeaders.Range = range;

              const r = await fetch(t, {
                method: req.method,
                headers: upstreamHeaders,
                redirect: "follow",
              });

              res.statusCode = r.status;
              const ct = r.headers.get("content-type");
              if (ct) res.setHeader("Content-Type", ct);
              const cl = r.headers.get("content-length");
              if (cl) res.setHeader("Content-Length", cl);
              const cr = r.headers.get("content-range");
              if (cr) res.setHeader("Content-Range", cr);
              const ar = r.headers.get("accept-ranges");
              if (ar) res.setHeader("Accept-Ranges", ar);
              res.setHeader("Access-Control-Allow-Origin", "*");
              res.setHeader("Cache-Control", "no-store");

              if (req.method === "HEAD" || r.status === 204 || !r.body) {
                res.end();
                return;
              }

              Readable.fromWeb(r.body).pipe(res);
              return;
            }

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
              t = assertHttpUrlForProxy(target);
            } catch (err) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "text/plain; charset=utf-8");
              res.end(err instanceof Error ? err.message : "Bad request");
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
  plugins: [playlistProxyDevPlugin(), react()],
  server: {
    port: 5173,
    strictPort: false,
  },
});
