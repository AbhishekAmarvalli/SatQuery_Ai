/**
 * Tiny zero-dependency server for the SATQUERY AI MVP.
 *
 *   static files  → the site itself (index.html, css, js, data/)
 *   GET  /api/status → is a live vision-language model configured?
 *   POST /api/route  → proxy a query + satellite imagery to the configured
 *                      VLM and return a validated routing decision.
 *
 * The proxy is the stand-in for the FastAPI service in the SIH architecture.
 * It keeps the API key server-side (never shipped to the browser) and it is
 * provider-agnostic: groq · gemini · any OpenAI-compatible endpoint · mock.
 *
 * Run:  node scripts/serve.mjs [port]     (default 8173)
 */
import http from "node:http";
import { createReadStream, existsSync, readFileSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 8173;
const MAX_BODY = 12 * 1024 * 1024; // generous: up to 4 downscaled JPEGs

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

/* ============================================================ env loading */
/** Read .env / .env.local so the key never has to be exported by hand. */
function loadEnv() {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
loadEnv();

/* ==================================================== provider configuration */
/**
 * All of these have a usable free tier as of 2026. `shape` selects the wire
 * format; adding a provider is one line as long as it speaks one of the two.
 */
const PROVIDERS = {
  groq: {
    label: "Groq",
    shape: "openai",
    base: "https://api.groq.com/openai/v1",
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    keyVar: "GROQ_API_KEY",
    free: "free tier",
  },
  gemini: {
    label: "Google Gemini",
    shape: "gemini",
    base: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    keyVar: "GEMINI_API_KEY",
    free: "free tier",
  },
  openai: {
    label: "OpenAI",
    shape: "openai",
    base: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyVar: "OPENAI_API_KEY",
    free: "paid",
  },
  openrouter: {
    label: "OpenRouter",
    shape: "openai",
    base: "https://openrouter.ai/api/v1",
    model: "meta-llama/llama-4-scout",
    keyVar: "OPENROUTER_API_KEY",
    free: "free tiers on :free models",
  },
  local: {
    // matches the deck: self-hosted LLaVA behind an OpenAI-compatible server
    label: "Local LLaVA (Ollama / vLLM)",
    shape: "openai",
    base: "http://127.0.0.1:11434/v1",
    model: "llava",
    keyVar: "VLM_LOCAL_KEY",
    free: "self-hosted",
  },
  mock: { label: "Mock (offline test)", shape: "mock", free: "n/a" },
};

function resolveConfig() {
  const name = (process.env.VLM_PROVIDER || "").toLowerCase().trim();
  if (!name) return { provider: null, reason: "not-configured" };
  const preset = PROVIDERS[name];
  if (!preset) return { provider: null, reason: "unknown-provider:" + name };

  const key = preset.keyVar ? process.env[preset.keyVar] : undefined;
  const needsKey = preset.shape !== "mock" && name !== "local";
  if (needsKey && !key) return { provider: null, reason: "missing-key:" + preset.keyVar };

  return {
    provider: name,
    label: preset.label,
    shape: preset.shape,
    base: (process.env.VLM_BASE_URL || preset.base || "").replace(/\/+$/, ""),
    model: process.env.VLM_MODEL || preset.model || "",
    key,
    free: preset.free,
    sendImages: process.env.VLM_SEND_IMAGES !== "0",
  };
}

/* ================================================================ the prompt */
const SCHEMA = {
  modality: "Optical | Thermal | SAR",
  intent: "flood | heat | change | description | night | port | other",
  confidence: "number 0..1",
  title: "short headline, max 8 words",
  answer: "2-4 sentences answering the user, referencing what you see and the AOI",
  why: ["2-3 short reasons this sensor is the right one for this question"],
  regions: [
    {
      label: "short place/feature name",
      note: "what the imagery shows there",
      polygon: [
        [72.8, 19.1],
        [72.85, 19.1],
        [72.85, 19.05],
      ],
    },
  ],
};

function buildPrompt({ query, aoiName, bbox, aoiBox, modalities, attached }) {
  const box = `[west=${bbox[0]}, south=${bbox[1]}, east=${bbox[2]}, north=${bbox[3]}]`;
  const system =
    "You are SatQuery, a remote-sensing analyst for the Smart India Hackathon. " +
    "You reason over optical, thermal (land-surface temperature) and SAR (radar) satellite imagery. " +
    "Routing rules: change/difference/description/land-cover → Optical. " +
    "Flood/standing water/heat/drought → Thermal. Night/dark/cloud/radar/ships/ports → SAR. " +
    "Answer ONLY with a single JSON object, no prose and no markdown fences.";

  // a concrete centre point makes the coordinate order impossible to misread
  const midLon = ((bbox[0] + bbox[2]) / 2).toFixed(3);
  const midLat = ((bbox[1] + bbox[3]) / 2).toFixed(3);

  // real ground size of the area under discussion, so the model can judge scale
  const focus = aoiBox || bbox;
  const focusMidLat = (focus[1] + focus[3]) / 2;
  const focusKmW = ((focus[2] - focus[0]) * 111.32 * Math.cos((focusMidLat * Math.PI) / 180)).toFixed(1);
  const focusKmH = ((focus[3] - focus[1]) * 110.57).toFixed(1);

  const userText = [
    `USER QUESTION: ${query}`,
    `AREA OF INTEREST: ${aoiName}, bounding box ${box} (EPSG:4326).`,
    aoiBox
      ? `The user drew a specific AOI inside it: [west=${aoiBox[0]}, south=${aoiBox[1]}, east=${aoiBox[2]}, north=${aoiBox[3]}].`
      : "The user has not drawn a narrower AOI, so use the whole free public data zone.",
    `IMAGERY PROVIDED: ${modalities.length ? modalities.join(", ") : "none (text-only routing)"}.`,
    `THE AREA UNDER DISCUSSION IS ABOUT ${focusKmW} KM WIDE AND ${focusKmH} KM TALL.`,
    attached > 0
      ? `CRITICAL: the ${attached} attached image(s) have been CROPPED to that area ` +
        "(clipped to free public data coverage). What you see IS the area of interest — " +
        "describe only what is visible in the images, and never describe anything outside them."
      : "No imagery was attached, so answer in general terms about what this sensor would reveal.",
    "",
    "Decide which single sensor best answers the question, then answer it.",
    "Be specific and concrete: refer to what is actually visible (water, built-up fabric, vegetation," +
      " roads, structures) rather than generic remote-sensing boilerplate. Do not invent place names.",
    "`answer` must answer the QUESTION itself. Do not spend it justifying which sensor you chose —" +
      " that reasoning belongs in `why`. Never claim to see something you cannot verify in the images.",
    "The thermal layer is a FALSE-COLOUR land-surface-temperature ramp with no legend, and the radar" +
      " layer is greyscale backscatter: for both, describe RELATIVE patterns (cooler vs warmer," +
      " brighter vs darker return) and never state absolute values. Water and saturated ground read" +
      " cooler than dry built-up surfaces; bare metal and quay structures return very bright in radar.",
    "",
    "`regions` is MANDATORY and must contain 2 to 4 entries — never null, never empty.",
    "Each point is [longitude, latitude]: LONGITUDE FIRST (about " + midLon + " here), LATITUDE SECOND (about " + midLat + " here).",
    `These are small numbers-vs-large: longitude is the larger value in this AOI. A correct point looks like [${midLon}, ${midLat}].`,
    `Every coordinate must fall inside the bounding box above — longitude between ${bbox[0]} and ${bbox[2]}, latitude between ${bbox[1]} and ${bbox[3]}.`,
    "Draw the polygons tight around the specific features you are reporting, not the whole AOI.",
    "If you were given no imagery, keep `answer` general and phrase it as what the sensor would reveal.",
    "",
    "Return exactly this JSON shape:",
    JSON.stringify(SCHEMA, null, 2),
  ].join("\n");

  return { system, userText };
}

/* ============================================================ provider calls */
function dataUrlToGeminiPart(url) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(url || "");
  if (!m) return null;
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

async function callOpenAICompat(cfg, prompt, images) {
  const content = [{ type: "text", text: prompt.userText }];
  for (const img of images) content.push({ type: "image_url", image_url: { url: img } });

  const body = {
    model: cfg.model,
    temperature: 0.2,
    // Keep this modest: free tiers cap OUTPUT tokens per minute (Groq's is
    // 1000/min on this tier), so a large reservation can trip a 429 by itself.
    max_tokens: Number(process.env.VLM_MAX_TOKENS) || 600,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content },
    ],
  };

  const send = (withJsonMode) =>
    fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.key || "not-needed"}`,
      },
      body: JSON.stringify(withJsonMode ? { ...body, response_format: { type: "json_object" } } : body),
    });

  // Not every compatible provider accepts response_format — retry plain.
  let res = await send(true);
  if (res.status === 400 || res.status === 422) res = await send(false);

  // Free-tier rate limit: wait out the window once, then give up gracefully so
  // the browser can fall back to the rule engine instead of showing an error.
  if (res.status === 429) {
    const after = Number(res.headers.get("retry-after")) || 0;
    const detail = (await res.text()).slice(0, 200);
    const waitMs = Math.min(Math.max(after * 1000, 2000), 8000);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await send(true);
    if (!res.ok) {
      throw new Error(`${cfg.label} rate-limited (${res.status}) — free tier output tokens/min. ${detail}`);
    }
  }

  if (!res.ok) throw new Error(`${cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = await res.json();
  return json?.choices?.[0]?.message?.content ?? "";
}

async function callGemini(cfg, prompt, images) {
  const parts = [{ text: prompt.userText }];
  for (const img of images) {
    const part = dataUrlToGeminiPart(img);
    if (part) parts.push(part);
  }
  const res = await fetch(
    `${cfg.base}/models/${encodeURIComponent(cfg.model)}:generateContent?key=${encodeURIComponent(cfg.key)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = await res.json();
  return json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";
}

/** Deterministic offline provider — proves the live plumbing without a key. */
function callMock(prompt, images) {
  const q = /USER QUESTION: (.*)/.exec(prompt.userText)?.[1] || "";
  const flood = /flood|water|inundat/i.test(q);
  const night = /night|dark|radar|ship|port|cloud/i.test(q);
  const modality = flood ? "Thermal" : night ? "SAR" : "Optical";
  return JSON.stringify({
    modality,
    intent: flood ? "flood" : night ? "night" : "change",
    confidence: 0.86,
    title: "Mock vision-language routing",
    answer:
      `Answered live by the mock provider with ${images.length} image(s) attached. ` +
      `The ${modality.toLowerCase()} sensor is the right choice for "${q.trim()}".`,
    why: ["Offline mock used to verify the live VLM request path.", "Deterministic output for tests."],
    regions: [
      {
        label: "Mock region A",
        note: "Returned by the model, clipped to your AOI.",
        polygon: [
          [72.86, 19.06],
          [72.90, 19.06],
          [72.90, 19.10],
          [72.86, 19.10],
        ],
      },
      {
        label: "Mock region B",
        note: "Second region — partly outside the AOI on purpose, so clamping is exercised.",
        polygon: [
          [73.20, 19.30],
          [73.40, 19.30],
          [73.40, 19.60],
        ],
      },
    ],
  });
}

/* ============================================== parsing + sanitisation */
/** Pull the first balanced JSON object out of a model reply. */
function extractJson(text) {
  const cleaned = String(text || "").replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === "{") depth++;
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const MODALITIES = ["Optical", "Thermal", "SAR"];

/**
 * Models describe a region in several different ways. Accept all of them:
 * a real array, a JSON string of an array, a GeoJSON geometry, a doubly
 * nested ring, or a plain [west, south, east, north] box.
 */
function coerceRing(value) {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v && !Array.isArray(v) && Array.isArray(v.coordinates)) v = v.coordinates;
  while (Array.isArray(v) && Array.isArray(v[0]) && Array.isArray(v[0][0])) v = v[0];
  if (!Array.isArray(v)) return null;

  // a 4-number box → turn it into a rectangle ring
  if (v.length === 4 && v.every((n) => Number.isFinite(+n))) {
    const [w, s, e, n] = v.map(Number);
    return [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
    ];
  }
  return v;
}

const intersectBox = (a, b) => [
  Math.max(a[0], b[0]),
  Math.max(a[1], b[1]),
  Math.min(a[2], b[2]),
  Math.min(a[3], b[3]),
];

const validBox = (b) =>
  Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(+n)) && +b[0] < +b[2] && +b[1] < +b[3];

/**
 * Clamp model output into something the map can trust:
 * modality from a whitelist, regions inside the AOI ∩ free zone.
 */
function sanitise(raw, { freeBox, aoiBox }) {
  if (!raw || typeof raw !== "object") return null;

  const modality = MODALITIES.find(
    (m) => String(raw.modality || "").toLowerCase() === m.toLowerCase()
  );
  if (!modality) return null;

  // regions must lie inside both the free public zone and the user's AOI
  let box = freeBox;
  if (aoiBox) {
    const overlap = validBox(freeBox) ? intersectBox(freeBox, aoiBox) : aoiBox;
    box = validBox(overlap) ? overlap : freeBox;
  }
  if (!validBox(box)) box = [72.75, 18.85, 73.05, 19.35];

  const clamp = (pt) => {
    const lon = Math.min(Math.max(+pt[0], box[0]), box[2]);
    const lat = Math.min(Math.max(+pt[1], box[1]), box[3]);
    return [Number(lon.toFixed(5)), Number(lat.toFixed(5))];
  };

  /**
   * Models routinely emit [lat, lon] despite being asked for [lon, lat].
   * Inside this AOI the two ranges do not overlap, so a swap is detectable:
   * every point reads as (latitude, longitude) and none as (longitude, latitude).
   */
  const isSwapCandidate = (pts) => {
    const inLon = (v) => v >= box[0] && v <= box[2];
    const inLat = (v) => v >= box[1] && v <= box[3];
    let swapped = 0;
    let correct = 0;
    for (const p of pts) {
      const a = +p[0];
      const b = +p[1];
      if (inLat(a) && inLon(b)) swapped++;
      else if (inLon(a) && inLat(b)) correct++;
    }
    return swapped > 0 && correct === 0;
  };

  const features = [];
  for (const r of Array.isArray(raw.regions) ? raw.regions.slice(0, 6) : []) {
    // different models name the geometry differently — take whichever exists
    const ringish = coerceRing(r?.polygon ?? r?.points ?? r?.coords ?? r?.geometry ?? r?.bbox);
    let pts = (Array.isArray(ringish) ? ringish : []).filter(
      (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1])
    );

    if (isSwapCandidate(pts)) pts = pts.map((p) => [p[1], p[0]]);

    const ring = pts
      .map(clamp)
      .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);

    if (ring.length < 3) continue;

    // drop consecutive duplicates that clamping can introduce
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]); // close the ring for GeoJSON
    }

    features.push({
      type: "Feature",
      properties: {
        label: String(r.label || "Model-detected region").slice(0, 80),
        note: String(r.note || "").slice(0, 240),
      },
      geometry: { type: "Polygon", coordinates: [ring] },
    });
  }

  const why = (Array.isArray(raw.why) ? raw.why : [])
    .filter((w) => typeof w === "string" && w.trim())
    .slice(0, 4)
    .map((w) => w.slice(0, 240));

  return {
    modality,
    intent: String(raw.intent || "other").slice(0, 40),
    confidence: Math.min(Math.max(Number(raw.confidence) || 0.7, 0), 1),
    title: String(raw.title || `${modality} analysis`).slice(0, 120),
    answer: String(raw.answer || "").slice(0, 1200),
    why,
    regions: features.length ? { type: "FeatureCollection", features } : null,
  };
}

/* =============================================================== http routes */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

async function handleRoute(req, res) {
  const cfg = resolveConfig();
  if (!cfg.provider) {
    // Not an error: the browser falls back to the transparent rule engine.
    sendJson(res, 200, { ok: false, reason: cfg.reason });
    return;
  }

  let payload;
  try {
    payload = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { ok: false, reason: "bad-request", detail: String(err.message) });
    return;
  }

  const query = String(payload.query || "").slice(0, 500).trim();
  if (!query) {
    sendJson(res, 400, { ok: false, reason: "empty-query" });
    return;
  }

  // accept either a plain array of bboxes or the legacy {images:[...]} shape
  const images = Array.isArray(payload.images)
    ? payload.images
        .filter((i) => typeof i === "string" && i.startsWith("data:image/"))
        .slice(0, 5)
    : [];
  const freeBox = validBox(payload.bbox) ? payload.bbox.map(Number) : [72.75, 18.85, 73.05, 19.35];
  const aoiBox = validBox(payload.aoi) ? payload.aoi.map(Number) : null;

  const useImages = cfg.sendImages ? images : [];

  const prompt = buildPrompt({
    query,
    aoiName: String(payload.aoiName || "the free public data zone").slice(0, 120),
    bbox: freeBox,
    aoiBox,
    modalities: Array.isArray(payload.modalities) ? payload.modalities.slice(0, 5) : [],
    attached: useImages.length,
  });

  const started = Date.now();

  try {
    const text =
      cfg.shape === "mock"
        ? callMock(prompt, useImages)
        : cfg.shape === "gemini"
          ? await callGemini(cfg, prompt, useImages)
          : await callOpenAICompat(cfg, prompt, useImages);

    const parsed = sanitise(extractJson(text), { freeBox, aoiBox });
    if (!parsed) {
      sendJson(res, 502, { ok: false, reason: "unparseable-model-output", detail: String(text).slice(0, 300) });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      source: {
        provider: cfg.provider,
        label: cfg.label,
        model: cfg.model,
        images: useImages.length,
        ms: Date.now() - started,
      },
      decision: parsed,
      // set VLM_DEBUG=1 or POST {debug:true} to inspect the raw model reply
      ...(payload.debug || process.env.VLM_DEBUG === "1"
        ? { raw: String(text).slice(0, 4000), prompt: prompt.userText.slice(0, 1200) }
        : {}),
    });
  } catch (err) {
    const msg = String(err.message);
    sendJson(res, 502, {
      ok: false,
      // surfaced distinctly so the UI can explain a free-tier throttle
      reason: /rate-limited|429/i.test(msg) ? "rate-limited" : "provider-error",
      detail: msg.slice(0, 400),
    });
  }
}

/* ================================================================= the server */
http
  .createServer(async (req, res) => {
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
      await handleRoute(req, res);
      return;
    }

    // ---------------- static files ----------------
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
  })
  .listen(PORT, () => {
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
