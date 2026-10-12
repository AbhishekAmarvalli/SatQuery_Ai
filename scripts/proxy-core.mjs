/**
 * SATQUERY AI — shared proxy logic (no Node-http coupling).
 *
 * This module is host-agnostic. It can run under:
 *   - `node scripts/serve.mjs`            → local dev server (preserves the old CLI)
 *   - `api/route.js` on Vercel / Netlify  → serverless function (no long-running process)
 *   - a test harness                      → just require/reimport the pure functions
 *
 * The browser never sees the API key: this is the server-side proxy that
 * replaces the FastAPI service in the SIH architecture diagram.
 */
import { readFileSync } from "node:fs";

/** Load `.env` / `.env.local` into `process.env` (only when unset). */
export function loadEnv(ROOT) {
  for (const name of [".env", ".env.local"]) {
    const file = `${ROOT}/${name}`;
    try {
      const raw = readFileSync(file, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
        if (!m) continue;
        const value = m[2].trim().replace(/^[\"']|[\"']$/g, "");
        if (process.env[m[1]] === undefined) process.env[m[1]] = value;
      }
    } catch {
      // .env / .env.local is optional
    }
  }
}

export const MIME = {
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

export const PROVIDERS = {
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
    label: "Local LLaVA (Ollama / vLLM)",
    shape: "openai",
    base: "http://127.0.0.1:11434/v1",
    model: "llava",
    keyVar: "VLM_LOCAL_KEY",
    free: "self-hosted",
  },
  mock: { label: "Mock (offline test)", shape: "mock", free: "n/a" },
};

export function resolveConfig(env = process.env) {
  const name = (env.VLM_PROVIDER || "").toLowerCase().trim();
  if (!name) return { provider: null, reason: "not-configured" };
  const preset = PROVIDERS[name];
  if (!preset) return { provider: null, reason: "unknown-provider:" + name };

  const key = preset.keyVar ? env[preset.keyVar] : undefined;
  const needsKey = preset.shape !== "mock" && name !== "local";
  if (needsKey && !key) return { provider: null, reason: "missing-key:" + preset.keyVar };

  return {
    provider: name,
    label: preset.label,
    shape: preset.shape,
    base: (env.VLM_BASE_URL || preset.base || "").replace(/\/+$/, ""),
    model: env.VLM_MODEL || preset.model || "",
    key,
    free: preset.free,
    sendImages: env.VLM_SEND_IMAGES !== "0",
  };
}

/* ================================================================ the prompt */ 
export const SCHEMA = {
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

export function buildPrompt({ query, aoiName, bbox, aoiBox, modalities, attached }) {
  const box = `[west=${bbox[0]}, south=${bbox[1]}, east=${bbox[2]}, north=${bbox[3]}]`;
  const system =
    "You are SatQuery, a remote-sensing analyst for the Smart India Hackathon. " +
    "You reason over optical, thermal (land-surface temperature) and SAR (radar) satellite imagery. " +
    "Routing rules: change/difference/description/land-cover → Optical. " +
    "Flood/standing water/heat/drought → Thermal. Night/dark/cloud/radar/ships/ports → SAR. " +
    "Answer ONLY with a single JSON object, no prose and no markdown fences.";

  const midLon = ((bbox[0] + bbox[2]) / 2).toFixed(3);
  const midLat = ((bbox[1] + bbox[3]) / 2).toFixed(3);

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

/**
 * Free tiers meter output tokens per rolling window (Groq's hobby tier is a
 * few thousand tokens), so a rate limit is usually a *window* problem, not a
 * transient blip: every retry inside the same window is rate-limited too.
 * Waiting is only worth it when the wait is short.
 */
const RATE_LIMIT_MAX_WAIT_MS = 1200;

/** Hard cap on a single provider call, so a stalled upstream cannot hang the chat. */
function upstreamSignal() {
  const ms = Number(process.env.VLM_TIMEOUT_MS) || 18000;
  try {
    return AbortSignal.timeout(ms);
  } catch {
    return undefined;
  }
}

/** Parse `retry-after` / `x-ratelimit-reset-*` headers ("224ms", "2m52.8s", plain seconds). */
function durationMs(text) {
  const s = String(text || "").trim();
  if (!s) return NaN;
  let total = 0;
  let matched = false;
  const h = /([\d.]+)h/.exec(s);
  if (h) { total += Number(h[1]) * 3600e3; matched = true; }
  const min = /([\d.]+)m(?!s)/.exec(s);
  if (min) { total += Number(min[1]) * 60e3; matched = true; }
  const sec = /([\d.]+)s/.exec(s);
  if (sec) { total += Number(sec[1]) * 1e3; matched = true; }
  const ms = /([\d.]+)ms/.exec(s);
  if (ms) { total += Number(ms[1]); matched = true; }
  if (matched) return total;
  const n = Number(s);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

/**
 * Free-tier state as the provider reports it: how much of the window is left
 * and when it refills. Returned to the browser so the assistant can pause and
 * resume on the provider's own clock instead of guessing.
 */
function windowFrom(res) {
  const num = (name) => {
    const v = Number(res.headers.get(name));
    return Number.isFinite(v) ? v : null;
  };
  const reset = durationMs(
    res.headers.get("x-ratelimit-reset-tokens") || res.headers.get("x-ratelimit-reset-requests")
  );
  const remaining = num("x-ratelimit-remaining-tokens");
  if (remaining == null && !Number.isFinite(reset)) return null;
  return {
    remaining,
    limit: num("x-ratelimit-limit-tokens"),
    resetInSeconds: Number.isFinite(reset) ? Math.max(0, Math.round(reset / 1000)) : null,
  };
}

/** One retry is allowed only when it can realistically succeed. */
async function recoverRateLimit(cfg, res, send) {
  const retryAfter = durationMs(res.headers.get("retry-after"));
  const win = windowFrom(res);
  const reset = win && Number.isFinite(win.resetInSeconds) ? win.resetInSeconds * 1000 : NaN;
  const waitMs = Number.isFinite(retryAfter) ? retryAfter : reset;
  const detail = await res.text().catch(() => "");

  const giveUp = (ms) => {
    const err = new Error(
      `${cfg.label} rate-limited (429) — the free-tier token window is spent, so a retry now would ` +
        `just fail again. ` +
        (Number.isFinite(ms) ? `Back in ~${Math.max(1, Math.round(ms / 1000))}s. ` : "") +
        `Send fewer or smaller images, or set VLM_SEND_IMAGES=0. ${detail.slice(0, 160)}`
    );
    err.code = "rate-limited";
    // when the browser may try again, on the provider's own clock
    err.retryInSeconds = Number.isFinite(ms) ? Math.max(1, Math.round(ms / 1000)) : null;
    return err;
  };

  if (!Number.isFinite(waitMs) || waitMs > RATE_LIMIT_MAX_WAIT_MS) throw giveUp(waitMs);

  await new Promise((r) => setTimeout(r, waitMs + 60));
  const retried = await send(true);
  if (retried.status === 429) throw giveUp(waitMs);
  return retried;
}

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
    max_tokens: Number((process && process.env && process.env.VLM_MAX_TOKENS) || 600),
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
      signal: upstreamSignal(),
    });

  let res = await send(true);
  if (res.status === 400 || res.status === 422) res = await send(false);
  if (res.status === 429) res = await recoverRateLimit(cfg, res, send);

  if (!res.ok) throw new Error(`${cfg.label} HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = await res.json();
  // the free-tier window travels on every response; hand it back to the caller
  return { text: json?.choices?.[0]?.message?.content ?? "", budget: windowFrom(res) };
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
      signal: upstreamSignal(),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 240)}`);
  const json = await res.json();
  return {
    text: json?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "",
    // Gemini does not publish a remaining-budget header we can rely on
    budget: null,
  };
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

export function sanitise(raw, { freeBox, aoiBox }) {
  if (!raw || typeof raw !== "object") return null;

  const modality = MODALITIES.find((m) => String(raw.modality || "").toLowerCase() === m.toLowerCase());
  if (!modality) return null;

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
    const ringish = coerceRing(r?.polygon ?? r?.points ?? r?.coords ?? r?.geometry ?? r?.bbox);
    let pts = (Array.isArray(ringish) ? ringish : []).filter(
      (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1])
    );

    if (isSwapCandidate(pts)) pts = pts.map((p) => [p[1], p[0]]);

    const ring = pts
      .map(clamp)
      .filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);

    if (ring.length < 3) continue;

    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
      ring.push(ring[0]);
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

/* ======================================================= http helpers */ 

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

const MAX_BODY = 12 * 1024 * 1024;

/**
 * Handle a POST /api/route request.
 *
 * Sends the JSON response through `sendJson` when an HTTP `res` is supplied
 * (which both the local server and the Vercel function do) and also returns
 * `{ status, body }` so the function stays usable from a test harness.
 */
async function handleRoute(headers, payload, env = process.env, res = null) {
  const respond = (status, body) => {
    if (res && typeof res.writeHead === "function") sendJson(res, status, body);
    return { status, body };
  };

  const cfg = resolveConfig(env);
  if (!cfg.provider) {
    return respond(200, { ok: false, reason: cfg.reason });
  }

  // `payload` arrives as a parsed object from readBody(), but accept a raw
  // JSON string too so the function stays usable from a test harness.
  let parsed;
  try {
    parsed = typeof payload === "string" ? JSON.parse(payload || "{}") : payload || {};
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
  } catch {
    return respond(400, { ok: false, reason: "bad-request" });
  }

  const query = String(parsed.query || "").slice(0, 500).trim();
  if (!query) return respond(400, { ok: false, reason: "empty-query" });

  const images = Array.isArray(parsed.images)
    ? parsed.images
        .filter((i) => typeof i === "string" && i.startsWith("data:image/"))
        .slice(0, 5)
    : [];
  const freeBox = validBox(parsed.bbox) ? parsed.bbox.map(Number) : [72.75, 18.85, 73.05, 19.35];
  const aoiBox = validBox(parsed.aoi) ? parsed.aoi.map(Number) : null;

  const useImages = cfg.sendImages ? images : [];

  const prompt = buildPrompt({
    query,
    aoiName: String(parsed.aoiName || "the free public data zone").slice(0, 120),
    bbox: freeBox,
    aoiBox,
    modalities: Array.isArray(parsed.modalities) ? parsed.modalities.slice(0, 5) : [],
    attached: useImages.length,
  });

  const started = Date.now();

  try {
    const { text, budget } =
      cfg.shape === "mock"
        ? { text: callMock(prompt, useImages), budget: null }
        : cfg.shape === "gemini"
          ? await callGemini(cfg, prompt, useImages)
          : await callOpenAICompat(cfg, prompt, useImages);

    const parsedOut = sanitise(extractJson(text), { freeBox, aoiBox });
    if (!parsedOut) {
      return respond(502, {
        ok: false,
        reason: "unparseable-model-output",
        detail: String(text).slice(0, 300),
      });
    }

    return respond(200, {
      ok: true,
      source: {
        provider: cfg.provider,
        label: cfg.label,
        model: cfg.model,
        images: useImages.length,
        ms: Date.now() - started,
      },
      decision: parsedOut,
      // lets the browser stop asking until the free-tier window refills
      ...(budget ? { budget } : {}),
      ...(parsed.debug || env.VLM_DEBUG === "1"
        ? { raw: String(text).slice(0, 4000), prompt: prompt.userText.slice(0, 1200) }
        : {}),
    });
  } catch (err) {
    const msg = String(err && err.message);
    const timedOut =
      err &&
      (err.name === "TimeoutError" || err.name === "AbortError" || /timeout|abort/i.test(msg));
    const rateLimited =
      (err && err.code === "rate-limited") || (!timedOut && /rate-limited|429/i.test(msg));
    return respond(timedOut ? 504 : 502, {
      ok: false,
      reason: timedOut ? "provider-timeout" : rateLimited ? "rate-limited" : "provider-error",
      // the clock to resume on — the browser pauses exactly this long
      ...(rateLimited && err && err.retryInSeconds ? { retryInSeconds: err.retryInSeconds } : {}),
      detail: msg.slice(0, 400),
    });
  }
}

export { MAX_BODY };
export { handleRoute };
export { readBody };

export function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

