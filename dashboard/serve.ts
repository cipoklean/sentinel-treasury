/**
 * serve.ts — local server for the Sentinel site.
 *
 * Serves web/ (landing page + live board) and /api/state, the same handler
 * Vercel runs from api/state.ts. Read-only, needs no keys:
 *   pnpm dashboard            (http://localhost:8787)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import handler from "../api/state.js";

const PORT = Number(process.env.DASH_PORT ?? 8787);
const WEB = join(import.meta.dirname, "..", "web");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function resolve(pathname: string): string | null {
  const clean = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  for (const candidate of [clean, `${clean}.html`, join(clean, "index.html")]) {
    const p = join(WEB, candidate);
    if (p.startsWith(WEB) && existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname === "/api/state") return handler(req, res);
  const file = resolve(url.pathname);
  if (!file) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
}).listen(PORT, () => console.log(`sentinel site: http://localhost:${PORT}  (board: /dashboard)`));
