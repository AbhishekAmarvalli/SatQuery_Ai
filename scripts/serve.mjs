/**
 * Local dev server for SATQUERY AI (serverless host should use api/route.js).
 *
 * Zero-dependency, hosted on Node's built-in http. Serves static files AND
 * the live VLM proxy. Run:  node scripts/serve.mjs [port]     (default 8173)
 *
 * The Groq key never leaves this process and never reaches the browser.
 */
import http from "node:http";
import { createReadStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadEnv,
  resolveConfig,
  sanitise,
  buildPrompt,
  MAX_BODY,
  handleRoute,
} from "./proxy-core.mjs";



const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2]) || 8173;

loadEnv(ROOT);

const app = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  if (url === "/api/status") {
    const cfg = resolveConfig();
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

  if (url === "/api/route") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, reason: "method-not-allowed" });
      return;
    }
    let payload;
    try {
      payload = await readBody(req);
    } catch (err) {
      sendJson(res, 400, { ok: false, reason: "bad-request", detail: String(err.message) });
      return;
    }
    await handleRoute(req.headers, payload, process.env, res);
    return;
  }

  // ---- static files ----
  try {
    let file = path.normalize(path.join(ROOT, url));
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    if (url === "/" || (await isDir(file))) file = path.join(ROOT, "index.html");
    const stat = await fs.stat(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
});

app.listen(PORT, () => {
  const cfg = resolveConfig();
  console.log(`SATQUERY AI → http://127.0.0.1:${PORT}`);
  console.log(
    cfg.provider
      ? `  live VLM: ${cfg.label} · ${cfg.model} · images ${cfg.sendImages ? "on" : "off"}`
      : `  live VLM: not configured (${cfg.reason}) — rule engine active`
  );
});

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
