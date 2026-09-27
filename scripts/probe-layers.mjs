/**
 * Probe GIBS WMS layers/dates over the Mumbai AOI to find combinations
 * that actually contain data (GIBS has known low-latitude data gaps on
 * some dates). Prints which (layer, date) pairs are usable.
 *
 * Run: node scripts/probe-layers.mjs
 */
import zlib from "node:zlib";

const WMS = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi";
// GIBS WMS 1.3.0 + CRS:EPSG:4326 uses lat,lon axis order
const BBOX = "18.85,72.75,19.35,73.05";

/** Decode an 8-bit PNG buffer → { pctOpaque, avgRGB } */
function pngInfo(buf) {
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
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return { pctOpaque: 0 }; }
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : 0;
  if (!ch) return { pctOpaque: 0 };
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
  let n = 0, op = 0, R = 0, G = 0, B = 0;
  for (let i = 0; i < out.length; i += ch) {
    n++;
    const al = ch === 4 ? out[i + 3] : 255;
    if (al > 10) { op++; R += out[i]; G += out[i + 1]; B += out[i + 2]; }
  }
  return {
    pctOpaque: +(100 * op / n).toFixed(1),
    avgRGB: op ? `${(R / op) | 0},${(G / op) | 0},${(B / op) | 0}` : "-",
    bytes: buf.length,
  };
}

async function probe(layer, time) {
  const url = new URL(WMS);
  for (const [k, v] of Object.entries({
    SERVICE: "WMS", VERSION: "1.3.0", REQUEST: "GetMap", STYLES: "",
    CRS: "EPSG:4326", LAYERS: layer, FORMAT: "image/png",
    WIDTH: "256", HEIGHT: "256", BBOX, TIME: time,
  })) url.searchParams.set(k, v);
  try {
    const res = await fetch(url);
    const buf = Buffer.from(await res.arrayBuffer());
    const info = pngInfo(buf);
    return `${info.bytes.toString().padStart(7)} B  opaque ${String(info.pctOpaque).padStart(5)}%  avg ${info.avgRGB}`;
  } catch (e) {
    return `ERROR ${e.message}`;
  }
}

const THERMAL = [
  "MODIS_Terra_Land_Surface_Temp_Day",
  "MODIS_Aqua_Land_Surface_Temp_Day",
  "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day",
];
const OPTICAL = [
  "MODIS_Terra_CorrectedReflectance_TrueColor",
  "MODIS_Aqua_CorrectedReflectance_TrueColor",
  "VIIRS_SNPP_CorrectedReflectance_TrueColor",
];
const DATES = [
  "2023-01-15", "2023-02-10", "2024-02-10", "2024-03-05",
  "2025-02-15", "2025-03-10", "2025-04-25", "2024-04-15", "2023-04-15",
];

console.log("=== THERMAL ===");
for (const layer of THERMAL) {
  for (const d of DATES) console.log(layer.padEnd(46), d, await probe(layer, d));
}
console.log("\n=== OPTICAL ===");
for (const layer of OPTICAL) {
  for (const d of DATES) console.log(layer.padEnd(46), d, await probe(layer, d));
}
