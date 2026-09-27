/**
 * SATQUERY AI — Vercel serverless proxy.
 *
 * Deploy this file at `api/route.js` at the root of your Vercel project.
 * Vercel calls the exported function for every request, so there is no
 * long-running server and no `listen()`.
 *
 * The browser never sees the API key: Vercel reads `GROQ_API_KEY` from your
 * project's environment variables (Settings → Environment Variables) and it
 * is injected here automatically as `process.env`.
 *
 * NOTE: Vercel's framework already serves static files for the app. This
 * handler only owns the two API routes (`/api/status`, `/api/route`); the
 * fallback exists to keep the demo self-contained if you ever deploy to a
 * host that doesn't do static routing.
 */
import {
  resolveConfig,
  sanitise,
  buildPrompt,
  MAX_BODY,
  sendJson,
  handleRoute,
} from "../scripts/proxy-core.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path === "/api/status") {
    const cfg = resolveConfig(process.env);
    sendJson(res, 200, {
      configured: !!cfg.provider,
      reason: cfg.provider ? null : cfg.reason,
      provider: cfg.provider,
      label: cfg.label || null,
      model: cfg.model || null,
      free: cfg.free || null,
      sendImages: cfg.sendImages !== false,
    });
    return;
  }

  if (path === "/api/route") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    const payload = await readBody(req);
    await handleRoute(req.headers, payload, process.env, res);
    return;
  }

  // Only static files are served here as a fallback for hosts without
  // framework-level serving. Vercel should route static files itself.
  try {
    const { promises: fs } = await import("fs");
    const path = require("path");
    const file = path.normalize(path.join(process.cwd(), path.dirname(url.pathname), url.pathname));
    if (!file.startsWith(process.cwd())) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (url.pathname === "/" || (await isDir(file))) {
      res.writeHead(307, { Location: "/index.html" });
      res.end();
      return;
    }
    const stat = await fs.stat(file);
    const stream = fs.createReadStream(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    stream.pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

async function isDir(p) {
  try {
    return (await import("fs").then((m) => m.stat(p))).isDirectory();
  } catch {
    return false;
  }
}
