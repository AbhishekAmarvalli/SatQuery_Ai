# SATQUERY AI

**Interactive Vision-Language Assistant for Multimodal Remote Sensing Image Analysis through Text Queries.**

Smart India Hackathon 2026 · Problem statement **SIH26167** · Theme **Space Technology** · Team **OrbitMinds** (122085)

Ask a satellite question in plain language, draw your area of interest, and the assistant picks the
right sensor — **Optical**, **Thermal** or **SAR** — then highlights the regions that answer you on a map.

---

## Quick start

```bash
npm run serve      # → http://127.0.0.1:8173
```

Open that URL in a browser. That is the whole setup — **no API key is required**.

Optionally verify everything works:

```bash
npm run verify     # 37 automated browser checks
```

`verify` drives a real headless Chrome through the whole app and asserts the routing, the AOI tools,
the change comparison and the live-model plumbing. It needs Chrome installed but no API key and no
network beyond the free public tile services.

---

## What the demo does

**1. Draw an AOI.** Pick *Rectangle* and drag a box, or *Polygon* and click points around any shape.
The area is measured in km² and checked against the dashed **FREE PUBLIC DATA ZONE** boundary —
answers only ever describe free & public imagery inside it.

**2. Ask in plain words.** For example:

| You ask | Sensor chosen | Why |
| --- | --- | --- |
| "What changed since 2017?" | **Optical** | Reflectance before/after — the only fair way to difference two dates |
| "Describe the land cover" | **Optical** | True colour maps straight onto land-cover classes |
| "Where are the floods?" | **Thermal** | Standing water reads as a cold anomaly against the built-up fabric |
| "Which areas are dangerously hot?" | **Thermal** | Land-surface temperature *is* the answer |
| "Show port activity at night" | **SAR** | Radar illuminates itself, so it works in the dark and through cloud |

**3. Read the map answer.** The chosen layer switches on, the model's regions are drawn on the map,
and the assistant explains *why* it picked that sensor.

**4. Compare 2017 ↔ 2025.** The **Change** group in the map toolbar opens a swipe slider: both
Sentinel-2 mosaics share an identical footprint, so they line up pixel for pixel. Left of the divider
is 2017, right is 2025.

---

## The live vision-language model

The assistant runs on a **real vision-language model** that receives your query *and* the actual
satellite imagery for your AOI, then returns the sensor choice, the written answer and the region
polygons. Any failure — no key, no network, a rate limit, an unparseable reply — falls back to a
transparent rule engine, so a live demo can never break. The chip in the assistant panel tells you
which one answered: `LIVE VLM` or `RULE-BASED`.

### Turn it on (free)

```bash
cp .env.example .env     # Windows: copy .env.example .env
```

Then set **one** provider and its key in `.env`: only `VLM_PROVIDER` and `GROQ_API_KEY` are required for the Groq path:

| Provider | `VLM_PROVIDER` | Key (env var / Vercel) | Notes |
| --- | --- | --- | --- |
| **Groq** (recommended) | `groq` | `GROQ_API_KEY` → `GROQ_API_KEY` on Vercel | Free tier, very fast, accepts images. Key: <https://console.groq.com/keys> |
| **Google Gemini** | `gemini` | `GEMINI_API_KEY` → `GEMINI_API_KEY` on Vercel | Free tier, multimodal. Key: <https://aistudio.google.com/apikey> |
| **Local LLaVA** | `local` | *(none)* | Self-hosted behind Ollama/vLLM. Needs a GPU |
| Any OpenAI-compatible | `openai` / `openrouter` | `OPENAI_API_KEY` / `OPENROUTER_API_KEY` → their Vercel names | Point `VLM_BASE_URL` at your gateway |

Restart the app afterwards. The browser never sees the key: the request is proxied server-side.
`.env` is git-ignored and **never committed**.

> **Use the Vercel proxy instead of `scripts/serve.mjs`.** In production, deploy this project to
> Vercel with this layout at the **project root**::

```bash
.
├── api/
│   └── route.js          # Vercel serverless proxy (GET /api/status, POST /api/route)
├── css/, data/, index.html, js/, scripts/
├── .env.example
├── .gitignore
└── README.md
```

`api/route.js` is the **exact same logic** as `scripts/serve.mjs` — it imports the host-agnostic
`scripts/proxy-core.mjs` and exposes a Vercel handler. The browser's `fetch("/api/status")` and
`fetch("/api/route")` target `api/route.js` on Vercel, and your key lives in Vercel's environment
stores, never in the repo.

> **Model availability changes.** If your key has no vision model, list what it does have and set
> `VLM_MODEL` accordingly:
>
> ```bash
> curl -s https://api.groq.com/openai/v1/models \
>   -H "Authorization: Bearer $GROQ_API_KEY" | node -e 'const s=require("fs").readFileSync(0,"utf8");JSON.parse(s).data.filter(m=>(m.input_modalities||[]).includes("image")).forEach(m=>console.log(m.id))'
> ```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `VLM_PROVIDER` | *(unset)* | `groq` · `gemini` · `openai` · `openrouter` · `local` · `mock` |
| `VLM_MODEL` | per provider | Override the model id |
| `VLM_BASE_URL` | per provider | Point at your own gateway |
| `VLM_SEND_IMAGES` | `1` | `0` = text-only routing (cheaper, but not actually multimodal) |
| `VLM_MAX_TOKENS` | `600` | Output cap. Free tiers throttle *output tokens per minute*, so a big reservation can trip a 429 on its own |
| `VLM_DEBUG` | *(unset)* | `1` prints the raw model reply so you can see why a parse failed |

### API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Is a live model configured? Returns provider, model, whether imagery is sent |
| `POST /api/route` | `{query, bbox, aoi, aoiName, modalities[], images[]}` → validated routing decision |

### What actually drives answer quality

**The image you send matters more than the prompt.** Sending the whole city and naming your AOI only
in text gives the model no way to know which part of the picture you mean — it describes the entire
scene. So the browser **crops every image to your AOI before sending it**, and the prompt tells the
model the attached image *is* the AOI. In testing on a 3 km AOI, the uncropped answer described
Mumbai's whole coastline while the cropped answer correctly identified the Mithi river running
through the area — and it answered roughly twice as fast, because a smaller image is also fewer
vision tokens.

Only two or three images are sent per query: the freshest optical view, plus whichever sensor the
rule engine already suspects (and the 2017+2025 pair for change questions).

Two further guards keep the answers honest:

- The prompt states each layer's palette semantics (thermal is a false-colour temperature ramp,
  radar is greyscale backscatter) and tells the model to describe *relative* patterns instead of
  inventing absolute temperatures or fabricating detail.
- If your AOI falls outside free public coverage there is no imagery to send, so **nothing is
  attached** and the model answers in general terms. Sending the whole scene while claiming the
  image is your AOI would be a lie. The AOI card shows `OUTSIDE` when this applies.

### Output is sanitised before it reaches the map

The modality is whitelisted, polygons are
parsed from whatever shape the model returned (array, JSON string, GeoJSON, or bounding box),
latitude/longitude swaps are corrected, and every coordinate is clamped to your AOI inside the free
zone. A hallucinated location cannot be drawn.

---

## Sample data

Four free, public samples were collected for the Mumbai demo area and committed under `data/samples/`:

| Sample | Sensor | Native resolution | Footprint |
| --- | --- | --- | --- |
| Sentinel-2 true colour 2017 | MSI | 10 m | city (0.30° × 0.50°) |
| Sentinel-2 true colour 2025 | MSI | 10 m | city |
| MODIS Terra land-surface temperature | MODIS | 1 km | city |
| Sentinel-1 IW GRD VV backscatter | C-band SAR | 20 m | high-res ~8 km |

Sources: Copernicus Sentinel-2 via EOX s2cloudless, NASA EOSDIS GIBS, and Copernicus Sentinel-1 via
Microsoft Planetary Computer. All free and open; no keys or billing.

Re-collect at any time:

```bash
npm run collect
```

### Why each sample uses the footprint it does

A static sample is a fixed grid of pixels, and its usefulness depends entirely on matching that grid
to the sensor's real resolution. Stretching a sample across a footprint it was not collected for is
what makes imagery look blurry when you zoom in.

- **Sentinel-2 (10 m)** and **Sentinel-1 (20 m)** carry genuine detail over a small area, so they are
  sampled to land near their native pixel size.
- **MODIS (1 km)** simply has no detail finer than a kilometre, so its sample covers the whole city —
  where its resolution is real rather than interpolated.

The app sets each live layer's `maxNativeZoom` from its ground sample distance (Sentinel-2 ≈ z13,
Sentinel-1 ≈ z13, MODIS ≈ z7). Past that zoom, Leaflet reuses the sharpest available tile instead of
requesting detail the sensor never recorded. If you need to read street-level detail, switch the
**Base** map to *Satellite* — that is sub-metre commercial imagery used as a visual reference, not as
an analysis layer.

---

## Putting it online

The site is plain static files plus one optional serverless function, so it runs on **GitHub Pages**
for free, or on **Vercel** for the full live-model experience.

> **GitHub Pages serves files only — it cannot run the proxy.** There everything works *except* live
> model inference: the chat runs on the **rule engine** and the badge reads `RULE-BASED`. Real model
> inference needs a server, so use Vercel for that.

### GitHub Pages (static frontend, free) — live now

```
https://abhishekamarvalli.github.io/SatQuery_Ai/
```

Repo: <https://github.com/AbhishekAmarvalli/SatQuery_Ai>. Pages is already enabled from `main` /
root (**Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `/`**),
so every push to `main` redeploys the site.

`.env` is git-ignored, so your API key is **not** uploaded. Never commit it.

### Vercel (full experience, free Hobby tier)

`api/route.js` is the serverless proxy and `vercel.json` routes `/api/status` to it; every other
file is served as a static asset from the repo root.

```bash
npx vercel login      # once
npx vercel --prod     # builds and deploys
```

Then add the live-model variables under **Project → Settings → Environment Variables** and redeploy:

| Variable | Value |
| --- | --- |
| `VLM_PROVIDER` | `groq` |
| `GROQ_API_KEY` | your key from <https://console.groq.com/keys> |
| `VLM_MODEL` | `qwen/qwen3.8-27b` (optional; only vision-capable models work) |
| `VLM_SEND_IMAGES` | `1` |

The Groq key is injected by Vercel into `process.env` at runtime — it is never stored in the
repository, and **never uploaded to GitHub**. `.vercelignore` also keeps `.env` out of any
CLI-triggered upload.

Either way, judge the demo from a local `npm run serve` if you want zero risk from conference wifi —
it has everything and needs no network beyond the free tile services.

---

## Project layout

```
index.html                  the whole UI
css/styles.css              neobrutalist design system (softened corners, hard shadows)
js/app.js                   map, AOI tools, layers, chat, swipe comparison, VLM client
js/query-engine.js          rule engine + grounded demo regions (the fallback)
scripts/serve.mjs           local dev server + /api/route vision-language proxy
scripts/proxy-core.mjs      host-agnostic proxy logic (no Node-http)
api/route.js                Vercel serverless proxy (GET /api/status, POST /api/route)
scripts/collect-data.mjs    free public data collector
scripts/verify.mjs          37-check headless browser test suite
data/samples/               collected imagery
data/catalog.json           sample metadata: source, date, licence, footprint
vercel.json                 Vercel config: static root + the api/route function
.vercelignore               keeps .env and dev files out of deployments
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Badge says `RULE-BASED` although `.env` is set | Restart the server — `scripts/serve.mjs` reads `.env` only at startup |
| `provider-error` toast | Run with `VLM_DEBUG=1`, or `POST {debug:true}` to `/api/route`, to see the raw reply |
| Model not found | Your key may not serve that model — list its vision models (above) and set `VLM_MODEL` |
| Tiles look soft when zoomed in | That is the sensor's real resolution, not a bug — see the footprint section above |
| Sample cards say "catalog fallback" | Open the site over `http://`, not `file://`, so `data/catalog.json` can load |

## Licence & attribution

Code: MIT. Imagery is free and open and remains under its own terms —
Copernicus Sentinel-1/2 (CC BY 4.0), NASA EOSDIS (public domain), EOX s2cloudless (© EOX.at),
Microsoft Planetary Computer. Attribution is shown in the map's control corner and on every sample card.
