/**
 * SATQUERY AI — free public sample data collector (MVP)
 *
 * Downloads three modalities for one demo AOI (Mumbai, India) from
 * key-less, free & open sources and writes data/catalog.json:
 *
 *   OPTICAL  — Sentinel-2 cloudless annual mosaics (2017 + 2025)
 *              via EOX Maps WMS (Copernicus Sentinel-2, free & open)
 *   THERMAL  — MODIS Terra Land Surface Temp (Day)
 *              via NASA GIBS Worldview snapshot API (NASA EOSDIS, free)
 *   SAR      — Sentinel-1 GRD VV render
 *              via Microsoft Planetary Computer titiler (Copernicus, free & open)
 *
 * Run:  node scripts/collect-data.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import zlib from "node:zlib";
import path from "node:path";

const AOI = {
  name: "Mumbai Metropolitan Region",
  bbox: [72.75, 18.85, 73.05, 19.35], // [west, south, east, north]
};

/**
 * High-resolution sample footprint.
 *
 * A static sample is a fixed grid of pixels. Spread over the whole 0.30 x 0.50
 * degree city bbox, 1024 px works out at ~32 m/px — softer than the screen as
 * soon as you zoom in. Over this ~8 km box the same 1024 px is ~8 m/px, which
 * matches Sentinel-2's native resolution, so the imagery stays sharp.
 *
 * Mumbai Port + Ballard Estate reads clearly in every modality: quays, cranes
 * and ships in radar, working docks and water in optical.
 */
const SAMPLE_AOI = {
  name: "Mumbai Port & Ballard Estate",
  bbox: [72.83, 18.94, 72.905, 19.015],
};

const WIDTH = 1024;
const HEIGHT = 1792; // ~0.6 aspect, matches the city AOI
const SAMPLE_PX = 1024; // square, for the sample footprint

const OUT_DIR = path.join(process.cwd(), "data", "samples");
const MIN_USEFUL_BYTES = 12_000; // reject blank / near-blank renders
const MIN_OPTICAL_BYTES = 15_000; // the 2017 mosaic is smoother than 2025

async function fetchBinary(url, opts = {}) {
  const res = await fetch(url, { redirect: "follow", ...opts });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function stats(buf) {
  return { bytes: buf.length, kb: Math.round(buf.length / 1024) };
}

/** % of non-transparent pixels in an 8-bit PNG (0 if not a decodable PNG). */
function pngOpaquePct(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!ch) return null;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + Math.floor((a + b) / 2)) & 255;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
  }
  let n = 0, op = 0;
  for (let i = 0; i < out.length; i += ch) {
    n++;
    if (ch === 4 ? out[i + 3] > 10 : true) op++;
  }
  return +(100 * op / n).toFixed(1);
}

/* ------------------------------------------------------------------ */
/* OPTICAL — EOX s2cloudless annual mosaics (Sentinel-2, EPSG:4326)    */
/* ------------------------------------------------------------------ */
async function optical(layer, box = AOI.bbox, width = WIDTH, height = HEIGHT) {
  const [W, S, E, N] = box;
  const url =
    "https://tiles.maps.eox.at/wms?" +
    new URLSearchParams({
      SERVICE: "WMS",
      VERSION: "1.3.0",
      REQUEST: "GetMap",
      LAYERS: layer,
      STYLES: "",
      FORMAT: "image/jpeg",
      TRANSPARENT: "false",
      CRS: "EPSG:4326",
      // WMS 1.3.0 + EPSG:4326 => lat,lon axis order
      BBOX: `${S},${W},${N},${E}`,
      WIDTH: String(width),
      HEIGHT: String(height),
    });
  const buf = await fetchBinary(url);
  if (buf.length < MIN_OPTICAL_BYTES) throw new Error(`optical ${layer} too small (${buf.length} B)`);
  return { buf, url, layer };
}

/* ------------------------------------------------------------------ */
/* THERMAL — NASA GIBS MODIS LST (Day), WMS (wms.cgi)                 */
/* NOTE: GIBS WMS 1.3.0 + CRS:EPSG:4326 uses lat,lon axis order, and */
/* some dates have low-latitude data gaps → layered/date fallbacks.   */
/* ------------------------------------------------------------------ */
const THERMAL_CANDIDATES = [
  ["MODIS_Terra_Land_Surface_Temp_Day", "2025-02-15"],
  ["MODIS_Terra_Land_Surface_Temp_Day", "2025-03-10"],
  ["MODIS_Terra_Land_Surface_Temp_Day", "2024-02-10"],
  ["MODIS_Aqua_Land_Surface_Temp_Day", "2025-04-25"],
  ["MODIS_Aqua_Land_Surface_Temp_Day", "2024-04-15"],
  ["MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", "2025-04-18"],
];

async function thermal(layer, date, box = AOI.bbox, width = WIDTH, height = HEIGHT) {
  const [W, S, E, N] = box;
  const url = new URL("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi");
  for (const [k, v] of Object.entries({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap", STYLES: "",
    CRS: "EPSG:4326", LAYERS: layer, FORMAT: "image/png",
    WIDTH: String(width), HEIGHT: String(height),
    BBOX: `${S},${W},${N},${E}`, // lat,lon axis order
    TIME: date,
  })) url.searchParams.set(k, v);
  const href = url.toString();
  const buf = await fetchBinary(href);
  const opaque = pngOpaquePct(buf);
  if (buf.length < 15_000 || (opaque !== null && opaque < 40)) {
    throw new Error(`empty render (${buf.length} B, opaque ${opaque}%)`);
  }
  return { buf, url: href, date, layer, opaque };
}

/* ------------------------------------------------------------------ */
/* SAR — Sentinel-1 GRD VV mosaic tiles (Planetary Computer titiler)  */
/* Registers an anonymous mosaic for the AOI, downloads the WebMercator*/
/* tiles covering it, stitches + crops them, writes one geocover PNG.  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Decode 8-bit PNG (gray/grayA/rgb/rgba) → { w, h, rgba } */
function pngDecode(buf) {
  let off = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : 0;
  if (!ch || !w) throw new Error("unsupported PNG");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const ft = raw[pos++];
    const line = raw.subarray(pos, pos + stride); pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + Math.floor((a + b) / 2)) & 255;
      else if (ft === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[i] = v;
    }
  }
  // → RGBA
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, j = 0; i < out.length; i += ch, j += 4) {
    if (ch === 1) { rgba[j] = rgba[j + 1] = rgba[j + 2] = out[i]; rgba[j + 3] = 255; }
    else if (ch === 2) { rgba[j] = rgba[j + 1] = rgba[j + 2] = out[i]; rgba[j + 3] = out[i + 1]; }
    else if (ch === 3) { rgba[j] = out[i]; rgba[j + 1] = out[i + 1]; rgba[j + 2] = out[i + 2]; rgba[j + 3] = 255; }
    else { rgba[j] = out[i]; rgba[j + 1] = out[i + 1]; rgba[j + 2] = out[i + 2]; rgba[j + 3] = out[i + 3]; }
  }
  return { w, h, rgba };
}
/** Encode RGBA buffer → PNG */
function pngEncode(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Global pixel coordinate at zoom Z (WebMercator, 256px tiles) */
const xPx = (lon, Z) => ((lon + 180) / 360) * 256 * 2 ** Z;
const yPx = (lat, Z) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 256 * 2 ** Z;

async function sar(box = AOI.bbox, Z = 12) {
  const [W, S, E, N] = box;
  // 1) metadata: newest S1 GRD scenes over the AOI (for the catalog)
  let newest = null;
  try {
    const search = await fetch("https://planetarycomputer.microsoft.com/api/stac/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        collections: ["sentinel-1-grd"], bbox: [W, S, E, N], limit: 3,
        sortby: [{ field: "datetime", direction: "desc" }],
      }),
    }).then((r) => r.json());
    newest = (search.features || [])[0] || null;
  } catch (err) {
    console.warn(`  STAC metadata skipped: ${err.message}`);
  }

  // 2) register an anonymous mosaic for the AOI
  const reg = await fetch("https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collections: ["sentinel-1-grd"], bbox: [W, S, E, N] }),
  }).then((r) => r.json());
  const mosaicId = reg.id;
  if (!mosaicId) throw new Error(`mosaic register failed: ${JSON.stringify(reg).slice(0, 200)}`);

  // 3) tiles covering the AOI at zoom Z
  const tx0 = Math.floor(xPx(W, Z) / 256), tx1 = Math.floor(xPx(E, Z) / 256);
  const ty0 = Math.floor(yPx(N, Z) / 256), ty1 = Math.floor(yPx(S, Z) / 256);
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const canvas = Buffer.alloc(cols * rows * 256 * 256 * 4); // transparent black
  console.log(`  mosaic ${mosaicId}: z${Z} ${cols}x${rows} tiles`);

  const tileUrl = (tx, ty) =>
    `https://planetarycomputer.microsoft.com/api/data/v1/mosaic/tiles/${mosaicId}/${Z}/${tx}/${ty}.png?` +
    new URLSearchParams({ collection: "sentinel-1-grd", assets: "vv" });

  let ok = 0;
  const jobs = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) jobs.push([tx, ty]);
  for (let i = 0; i < jobs.length; i += 6) {
    await Promise.all(
      jobs.slice(i, i + 6).map(async ([tx, ty]) => {
        try {
          const res = await fetch(tileUrl(tx, ty));
          if (res.status === 204 || !res.ok) return;
          const { w, h, rgba } = pngDecode(Buffer.from(await res.arrayBuffer()));
          if (w !== 256 || h !== 256) return;
          const ox = (tx - tx0) * 256, oy = (ty - ty0) * 256;
          const cw = cols * 256;
          for (let y = 0; y < 256; y++) {
            rgba.copy(canvas, ((oy + y) * cw + ox) * 4, y * 1024, (y + 1) * 1024);
          }
          ok++;
        } catch {
          /* skip failed tile */ }
      })
    );
  }
  if (ok < jobs.length * 0.5) throw new Error(`only ${ok}/${jobs.length} SAR tiles returned data`);

  // 4) crop to the exact AOI pixel window
  const cw = cols * 256;
  const cx0 = Math.round(xPx(W, Z) - tx0 * 256);
  const cy0 = Math.round(yPx(N, Z) - ty0 * 256);
  const cwid = Math.round(xPx(E, Z) - xPx(W, Z));
  const chei = Math.round(yPx(S, Z) - yPx(N, Z));
  const cropped = Buffer.alloc(cwid * chei * 4);
  for (let y = 0; y < chei; y++) {
    canvas.copy(cropped, y * cwid * 4, ((cy0 + y) * cw + cx0) * 4, ((cy0 + y) * cw + cx0 + cwid) * 4);
  }
  const buf = pngEncode(cropped, cwid, chei);
  if (buf.length < MIN_USEFUL_BYTES) throw new Error("stitched SAR render too small");

  return {
    buf,
    mosaicId,
    zoom: Z,
    url: `https://planetarycomputer.microsoft.com/api/data/v1/mosaic/tiles/${mosaicId}/{z}/{x}/{y}.png?collection=sentinel-1-grd&assets=vv`,
    scene: newest?.id,
    datetime: newest?.properties?.datetime,
    orbit: newest?.properties?.["sat:orbit_state"],
    tiles: `${ok}/${jobs.length}`,
  };
}

/* ------------------------------------------------------------------ */
async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const catalog = {
    generated_at: new Date().toISOString(),
    aoi: {
      name: AOI.name,
      bbox: AOI.bbox,
      crs: "EPSG:4326",
      note: "Free & public data only — this bbox is the demo 'free data zone' drawn on the map.",
    },
    sample_aoi: {
      name: SAMPLE_AOI.name,
      bbox: SAMPLE_AOI.bbox,
      crs: "EPSG:4326",
      note:
        "High-resolution radar footprint — a ~8 km stretch of working docks. At " +
        SAMPLE_PX +
        " px this is ~8 m/px, which matches Sentinel-1's native pixel and stays sharp when you zoom.",
    },
    samples: [],
  };

  const push = (s) => {
    catalog.samples.push(s);
    console.log(`  ✓ ${s.file}  (${stats(s._buf).kb} KB)`);
  };

  const SB = SAMPLE_AOI.bbox; // small footprint used for the sharp SAR render

  // Sentinel-2 is a 10 m sensor and EOX's mosaic pyramid tops out near 19 m/px,
  // so asking for a small box at huge pixel counts just returns upsampled mush.
  // The honest maximum detail is a big box at a big pixel count: 0.30 x 0.50
  // degrees at 2048 px is ~16 m/px — close to the sensor's real limit.
  console.log("Optical 2017 / 2025 — city footprint at 2048 px (~16 m/px)…");
  for (const [year, layer] of [
    ["2017", "s2cloudless-2017"],
    ["2025", "s2cloudless-2025"],
  ]) {
    const { buf, url } = await optical(layer, AOI.bbox, 2048, 3584);
    const file = `optical_${year}_city.jpg`;
    await writeFile(path.join(OUT_DIR, file), buf);
    push({
      id: `optical_${year}`,
      file: `samples/${file}`,
      footprint: "city",
      bbox: AOI.bbox,
      modality: "Optical",
      title: `Sentinel-2 true colour mosaic — ${year}`,
      sensor: "MSI (10 m)",
      native_m: 10,
      px_per_deg: 6827,
      provider: "Copernicus / ESA — via EOX Maps s2cloudless",
      date: `${year} (annual mosaic)`,
      resolution_m: "10",
      license: "Copernicus free & open data (CC BY 4.0); mosaic © EOX.at",
      source_url: url,
      best_for: "Land-cover description, change detection, urban growth, vegetation",
      _buf: buf,
    });
  }

  console.log(`\nCity footprint — ${AOI.name}`);
  console.log("  Thermal… (MODIS is a 1 km sensor, so its sample lives at city scale)");
  let th = null;
  for (const [layer, date] of THERMAL_CANDIDATES) {
    try {
      th = await thermal(layer, date, AOI.bbox, WIDTH, HEIGHT);
      break;
    } catch (err) {
      console.warn(`  ${layer} @ ${date} → ${err.message}`);
    }
  }
  if (!th) throw new Error("no usable thermal sample");
  const thFile = `thermal_lst_${th.date}.png`;
  await writeFile(path.join(OUT_DIR, thFile), th.buf);
  push({
    id: "thermal_lst",
    file: `samples/${thFile}`,
    footprint: "city",
    bbox: AOI.bbox,
    native_m: 1000,
    modality: "Thermal",
    title: `${th.layer.includes("Aqua") ? "MODIS Aqua" : th.layer.includes("8Day") ? "MODIS Terra 8-day composite" : "MODIS Terra"} land-surface temperature — ${th.date}`,
    sensor: "MODIS (1 km)",
    provider: "NASA EOSDIS GIBS",
    date: th.date,
    resolution_m: "1000",
    license: "NASA EOSDIS — free & open (public domain)",
    source_url: th.url,
    best_for: "Flood standing-water anomalies, heat hotspots, drought stress, fire risk",
    _buf: th.buf,
  });

  console.log("  SAR…");
  // z14 ≈ 9 m/px here, which matches Sentinel-1's 20 m ground sample well
  const s = await sar(SB, 14);
  const sarFile = `sar_vv_${(s.datetime || "").slice(0, 10) || "scene"}_sample.png`;
  await writeFile(path.join(OUT_DIR, sarFile), s.buf);
  push({
    id: "sar_vv",
    file: `samples/${sarFile}`,
    footprint: "sample",
    bbox: SB,
    native_m: 20,
    modality: "SAR",
    title: `Sentinel-1 IW GRD — VV backscatter (high-resolution sample)`,
    sensor: "C-band SAR (20 m)",
    provider: "Copernicus / ESA — via Microsoft Planetary Computer",
    date: (s.datetime || "").slice(0, 19).replace("T", " "),
    orbit: s.orbit || "n/a",
    scene: s.scene,
    mosaic_id: s.mosaicId,
    tiles_stitched: s.tiles,
    resolution_m: "20",
    license: "Copernicus free & open data (CC BY 4.0)",
    source_url: s.url,
    best_for: "Night / all-weather imaging, port & shipping activity, water mapping, structure detection",
    _buf: s.buf,
  });

  for (const sample of catalog.samples) delete sample._buf;
  await writeFile(path.join(process.cwd(), "data", "catalog.json"), JSON.stringify(catalog, null, 2));
  console.log(`\nDone — ${catalog.samples.length} samples in data/, catalog.json written.`);
}

main().catch((err) => {
  console.error("FAILED:", err.message);
  process.exit(1);
});
