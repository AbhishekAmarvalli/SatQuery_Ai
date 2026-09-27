/* ==========================================================================
   SATQUERY AI — application (vanilla JS + Leaflet)
   map · AOI tools · modality layers · chat · grounded results · samples
   ========================================================================== */
(function () {
  "use strict";

  const E = window.SatQueryEngine;

  /* ============================================================ constants */
  // Fallback free-zone + sample catalog (used if data/catalog.json is blocked)
  const CITY_BBOX = [72.75, 18.85, 73.05, 19.35];
  const SAMPLE_BBOX = [72.83, 18.94, 72.905, 19.015];

  const FALLBACK_CATALOG = {
    aoi: {
      name: "Mumbai Metropolitan Region",
      bbox: CITY_BBOX,
      note: "Free & public data only — this bbox is the demo 'free data zone' drawn on the map.",
    },
    sample_aoi: {
      name: "Mumbai Port & Ballard Estate",
      bbox: SAMPLE_BBOX,
      note: "High-resolution radar footprint.",
    },
    samples: [
      {
        id: "optical_2017", file: "samples/optical_2017_city.jpg", footprint: "city",
        bbox: CITY_BBOX, modality: "Optical",
        title: "Sentinel-2 true colour mosaic — 2017", sensor: "MSI (10 m)", native_m: 10,
        provider: "Copernicus / ESA — via EOX Maps s2cloudless", date: "2017 (annual mosaic)",
        license: "Copernicus free & open data (CC BY 4.0); mosaic © EOX.at",
        best_for: "Land-cover description, change detection, urban growth, vegetation",
        source_url: "https://eox.at",
      },
      {
        id: "optical_2025", file: "samples/optical_2025_city.jpg", footprint: "city",
        bbox: CITY_BBOX, modality: "Optical",
        title: "Sentinel-2 true colour mosaic — 2025", sensor: "MSI (10 m)", native_m: 10,
        provider: "Copernicus / ESA — via EOX Maps s2cloudless", date: "2025 (annual mosaic)",
        license: "Copernicus free & open data (CC BY 4.0); mosaic © EOX.at",
        best_for: "Land-cover description, change detection, urban growth, vegetation",
        source_url: "https://eox.at",
      },
      {
        id: "thermal_lst", file: "samples/thermal_lst_2025-02-15.png", footprint: "city",
        bbox: CITY_BBOX, modality: "Thermal",
        title: "MODIS Terra land-surface temperature — 2025-02-15", sensor: "MODIS (1 km)", native_m: 1000,
        provider: "NASA EOSDIS GIBS", date: "2025-02-15",
        license: "NASA EOSDIS — free & open (public domain)",
        best_for: "Flood standing-water anomalies, heat hotspots, drought stress, fire risk",
        source_url: "https://gibs.earthdata.nasa.gov",
      },
      {
        id: "sar_vv", file: "samples/sar_vv_2026-09-18_sample.png", footprint: "sample",
        bbox: SAMPLE_BBOX, modality: "SAR",
        title: "Sentinel-1 IW GRD — VV backscatter (high-resolution sample)",
        sensor: "C-band SAR (20 m)", native_m: 20,
        provider: "Copernicus / ESA — via Microsoft Planetary Computer", date: "2026-09-18 01:02",
        license: "Copernicus free & open data (CC BY 4.0)",
        best_for: "Night / all-weather imaging, port & shipping activity, water mapping",
        source_url: "https://planetarycomputer.microsoft.com",
      },
    ],
  };

  const ATTR = {
    streets: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    satellite: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics',
    optical: 'Sentinel-2 mosaic &copy; <a href="https://eox.at">EOX</a> / Copernicus data',
    thermal: 'Imagery &copy; <a href="https://gibs.earthdata.nasa.gov">NASA EOSDIS GIBS</a>',
    sar: 'Sentinel-1 &copy; Copernicus / <a href="https://planetarycomputer.microsoft.com">Microsoft Planetary Computer</a>',
  };

  const MOD_INFO = {
    Optical: {
      color: "#12a150", dark: "#0b5a31", cls: "chip-green",
      legend: "Optical layer", fact: "Optical · Sentinel-2 (EOX s2cloudless)",
    },
    Thermal: {
      color: "#e03a45", dark: "#8e1b24", cls: "chip-red",
      legend: "Thermal layer", fact: "Thermal · MODIS LST (NASA GIBS)",
    },
    SAR: {
      color: "#e8930c", dark: "#8a5200", cls: "chip-amber",
      legend: "SAR layer", fact: "SAR · Sentinel-1 VV (Planetary Computer)",
    },
  };

  const SAR_FALLBACK_MOSAIC = "71a83167102cc745f571a24d6aeccf74";
  const sarTileUrl = (id) =>
    `https://planetarycomputer.microsoft.com/api/data/v1/mosaic/tiles/${id}/{z}/{x}/{y}.png` +
    "?collection=sentinel-1-grd&assets=vv";

  /* ============================================================ DOM helper */
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* ============================================================ state */
  const state = {
    tool: "pan",
    modality: "Optical",
    routed: false,
    aoi: null, // L.Polygon | L.Rectangle
    aoiBounds: null,
    aoiAreaKm2: null,
    results: null, // L.GeoJSON layer
    sampleOverlays: new Map(), // id -> L.ImageOverlay
    samplesActive: false,
    freeBounds: null,
    freeRect: null,
    catalog: FALLBACK_CATALOG,
    sarReady: false,
    drawing: null, // { type:'rect'|'poly', ... }
  };

  /* ============================================================ toast */
  let toastTimer = null;
  function toast(msg, warn) {
    const t = $("mapToast");
    t.textContent = msg;
    t.classList.toggle("warn", !!warn);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 3400);
  }

  /* ============================================================ map */
  const map = L.map("map", {
    zoomControl: true,
    doubleClickZoom: true,
    attributionControl: true,
  }).setView([19.1, 72.9], 10);

  const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: ATTR.streets,
  }).addTo(map);

  const satellite = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: ATTR.satellite }
  );

  /* ------------------------------- modality layers (only one active) --- */
  const layers = {
    // maxNativeZoom is the zoom at which one tile pixel equals roughly one
    // sensor pixel. Asking for tiles past that only buys upsampled blur, so
    // these are set from the real ground sample distance of each sensor:
    //   Sentinel-2  10 m  → ~z13   MODIS LST 1 km → ~z7   Sentinel-1 20 m → ~z13
    // Past the native zoom Leaflet reuses the best available tile instead.
    Optical: L.tileLayer.wms("https://tiles.maps.eox.at/wms", {
      // EOX serves the Web-Mercator flavour of the mosaic under _3857
      layers: "s2cloudless_3857",
      format: "image/jpeg",
      transparent: false,
      attribution: ATTR.optical,
      maxNativeZoom: 13,
      maxZoom: 19,
    }),
    Thermal: L.tileLayer(
      "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_Land_Surface_Temp_Day/" +
        "default/{time}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png",
      {
        time: "2025-02-15",
        maxNativeZoom: 7,
        maxZoom: 18,
        opacity: 0.92,
        attribution: ATTR.thermal,
      }
    ),
    SAR: L.tileLayer(sarTileUrl(SAR_FALLBACK_MOSAIC), {
      maxNativeZoom: 13,
      maxZoom: 18,
      opacity: 0.95,
      attribution: ATTR.sar,
    }),
  };

  function setModality(mod, opts) {
    opts = opts || {};
    if (!layers[mod]) return;
    Object.keys(layers).forEach((k) => {
      if (map.hasLayer(layers[k])) map.removeLayer(layers[k]);
    });
    layers[mod].addTo(map);
    state.modality = mod;
    state.routed = !!opts.routed;

    document.querySelectorAll(".mod-card").forEach((c) => {
      const active = c.dataset.modality === mod;
      c.classList.toggle("is-active", active);
      c.setAttribute("aria-selected", active ? "true" : "false");
      c.classList.toggle("routed", active && state.routed);
    });

    const info = MOD_INFO[mod];
    $("swLayer").style.background = info.color;
    $("legendLayerName").textContent = info.legend;
    $("factLayer").textContent = info.fact;
    updateStatus();
    if (!opts.silent) toast(`${mod} layer ${opts.routed ? "auto-selected" : "selected"} ✓`);
    if (mod === "SAR" && !state.sarReady) ensureSarMosaic(currentSarBbox(), true);
  }

  /* ------------------------------- SAR mosaic registration (CORS-open) - */
  function currentSarBbox() {
    if (state.aoiBounds) {
      const b = state.aoiBounds;
      return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
    }
    return state.freeBounds
      ? [
          state.freeBounds.getWest(),
          state.freeBounds.getSouth(),
          state.freeBounds.getEast(),
          state.freeBounds.getNorth(),
        ]
      : [72.75, 18.85, 73.05, 19.35];
  }

  async function ensureSarMosaic(bbox, announce) {
    try {
      const res = await fetch("https://planetarycomputer.microsoft.com/api/data/v1/mosaic/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collections: ["sentinel-1-grd"], bbox }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (!j.id) throw new Error("no id");
      layers.SAR.setUrl(sarTileUrl(j.id), false);
      state.sarReady = true;
      if (announce) toast("SAR mosaic registered for your AOI ✓");
    } catch (err) {
      layers.SAR.setUrl(sarTileUrl(SAR_FALLBACK_MOSAIC), false);
      state.sarReady = false;
      if (announce) toast("SAR live mosaic unavailable — using cached free layer", true);
    }
  }

  /* ============================================================ free zone */
  function drawFreeZone(bbox) {
    // bbox: [w, s, e, n]
    const b = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
    state.freeBounds = b;
    state.freeRect = L.rectangle(b, {
      color: "#1d4ed8",
      weight: 3,
      dashArray: "12 9",
      fill: true,
      fillColor: "#1d4ed8",
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(map);
    L.tooltip({ permanent: true, direction: "center", className: "zone-label" })
      .setContent("FREE PUBLIC DATA ZONE")
      .setLatLng(b.getCenter())
      .addTo(map);
    map.fitBounds(b, { padding: [26, 26] });
  }

  /* ============================================================ status bar */
  let cursorLatLng = null;
  function fmtCoord(latlng) {
    if (!latlng) return "—, —";
    return `${Math.abs(latlng.lat).toFixed(4)}°${latlng.lat >= 0 ? "N" : "S"} ` +
      `${Math.abs(latlng.lng).toFixed(4)}°${latlng.lng >= 0 ? "E" : "W"}`;
  }
  function updateStatus(extra) {
    const parts = [
      fmtCoord(cursorLatLng),
      "z" + map.getZoom(),
      state.modality,
      state.aoiAreaKm2 ? `AOI ${state.aoiAreaKm2} km²` : "no AOI",
    ];
    $("mapStatus").textContent = parts.join("  ·  ") + (extra ? "  ·  " + extra : "");
  }
  map.on("mousemove", (e) => { cursorLatLng = e.latlng; updateStatus(); });
  map.on("zoomend", () => updateStatus());

  /* ============================================================ AOI tools */
  function setTool(tool) {
    if (tool === "clear") {
      clearAoi();
      clearResults();
      setTool("pan");
      return;
    }
    state.tool = tool;
    document.querySelectorAll("[data-tool]").forEach((b) =>
      b.classList.toggle("is-active", b.dataset.tool === tool)
    );
    map.getContainer().style.cursor = tool === "pan" ? "" : "crosshair";
    if (tool === "poly") { map.doubleClickZoom.disable(); showHint("click to add points · double-click to finish · Esc cancels"); }
    else { map.doubleClickZoom.enable(); showHint(tool === "rect" ? "click-drag to draw a rectangle AOI" : ""); }
    if (tool !== "poly") cancelPoly();
    if (tool !== "rect") cancelRect();
  }

  let hintEl = null;
  function showHint(text) {
    if (!hintEl) {
      hintEl = el("div", "draw-hint");
      hintEl.innerHTML =
        '<span class="hint-text"></span>' +
        '<button type="button" class="btn btn-sm finish-btn">Finish polygon ▸</button>';
      hintEl.querySelector(".finish-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        finishPoly();
      });
      document.querySelector(".map-shell").appendChild(hintEl);
    }
    hintEl.querySelector(".hint-text").textContent = text;
    hintEl.classList.toggle("show", !!text);
    const canFinish = state.tool === "poly" && polyPts.length >= 3;
    hintEl.querySelector(".finish-btn").style.display = canFinish ? "inline-flex" : "none";
  }

  /* ---- rectangle ---- */
  const rectStyle = {
    color: "#1d4ed8", weight: 3, dashArray: "8 6",
    fillColor: "#1d4ed8", fillOpacity: 0.16,
  };
  let rectStart = null, rectTemp = null, rectDragging = false;

  function cancelRect() {
    rectStart = null;
    rectDragging = false;
    if (rectTemp) { map.removeLayer(rectTemp); rectTemp = null; }
    map.dragging.enable(); // never leave the map stuck if drawing is cancelled
  }

  /** Live size readout, so the box is easy to aim while you drag it. */
  function rectReadout(bounds) {
    const km2 = ringAreaKm2([
      bounds.getSouthWest(), bounds.getSouthEast(),
      bounds.getNorthEast(), bounds.getNorthWest(),
    ]);
    showHint(`AOI ${Math.round(km2 * 10) / 10} km² — release to use it`);
  }

  map.on("mousedown", (e) => {
    if (state.tool !== "rect") return;
    rectStart = e.latlng;
    rectDragging = true;
    rectTemp = L.rectangle(L.latLngBounds(rectStart, rectStart), rectStyle).addTo(map);
    map.dragging.disable();
  });

  // Grow the preview while the button is still down — without this the box only
  // appears on release, which makes the AOI impossible to aim.
  map.on("mousemove", (e) => {
    if (!rectDragging || !rectStart || !rectTemp) return;
    const bounds = L.latLngBounds(rectStart, e.latlng);
    rectTemp.setBounds(bounds);
    rectReadout(bounds);
  });

  function finishRect(endLatLng) {
    if (!rectDragging) return;
    const start = rectStart;
    cancelRect(); // clears the preview, re-enables dragging
    if (!start || !endLatLng) return;
    const bounds = L.latLngBounds(start, endLatLng);
    if (bounds.getWest() === bounds.getEast() || bounds.getNorth() === bounds.getSouth()) {
      toast("Drag to draw a box — that was only a click", true);
      return;
    }
    installAoi(L.rectangle(bounds, rectStyle));
  }

  map.on("mouseup", (e) => finishRect(e.latlng));

  // Releasing outside the map still has to finish, or drawing gets stuck.
  document.addEventListener("mouseup", (e) => {
    if (!rectDragging) return;
    if (map.getContainer().contains(e.target)) return; // the map handler ran
    finishRect(cursorLatLng);
  });

  /* ---- polygon ---- */
  let polyPts = [], polyMarkers = [], polyTemp = null;

  function cancelPoly() {
    polyPts = [];
    polyMarkers.forEach((m) => map.removeLayer(m));
    polyMarkers = [];
    if (polyTemp) { map.removeLayer(polyTemp); polyTemp = null; }
  }

  map.on("click", (e) => {
    if (state.tool !== "poly") return;
    // click back on the first vertex to close the ring
    if (polyPts.length >= 3) {
      const p0 = map.latLngToContainerPoint(polyPts[0]);
      const p1 = map.latLngToContainerPoint(e.latlng);
      if (p0.distanceTo(p1) < 14) { finishPoly(); return; }
    }
    polyPts.push(e.latlng);
    polyMarkers.push(
      L.circleMarker(e.latlng, {
        radius: 5, color: "#14161a", weight: 2, fillColor: "#1d4ed8", fillOpacity: 1,
      }).addTo(map)
    );
    if (polyTemp) map.removeLayer(polyTemp);
    polyTemp = L.polyline(polyPts, {
      color: "#1d4ed8", weight: 3, dashArray: "8 6", fill: false,
    }).addTo(map);
    updateHintCount();
  });

  map.on("mousemove", (e) => {
    if (state.tool !== "poly" || !polyPts.length) return;
    if (polyTemp) polyTemp.setLatLngs(polyPts.concat([e.latlng]));
  });

  map.on("dblclick", () => {
    if (state.tool !== "poly") return;
    finishPoly();
  });

  function updateHintCount() {
    showHint(`${polyPts.length} pts — press Enter, double-click or Finish when ready (Esc cancels)`);
  }

  function finishPoly() {
    if (polyPts.length >= 3) {
      // drop a duplicated last point (dblclick emits an extra click)
      const pts = polyPts.slice();
      if (pts.length >= 4 && pts[pts.length - 1].distanceTo(pts[pts.length - 2]) < 6) pts.pop();
      if (pts.length >= 3) {
        cancelPoly();
        setTool("pan");
        installAoi(L.polygon(pts, rectStyle));
        return;
      }
    }
    toast("Polygon needs at least 3 points", true);
  }

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
    if (e.key === "Escape") {
      cancelPoly();
      cancelRect();
      setTool("pan");
    } else if (e.key === "Enter" && !typing && state.tool === "poly" && polyPts.length >= 3) {
      finishPoly();
    }
  });

  /* ---- AOI install / clear ---- */
  function ringAreaKm2(latlngs) {
    // spherical excess (Chamberlain–Duquette), accurate enough for city AOIs
    const R = 6378137;
    const toRad = (d) => (d * Math.PI) / 180;
    let total = 0;
    const n = latlngs.length;
    for (let i = 0; i < n; i++) {
      const p1 = latlngs[i], p2 = latlngs[(i + 1) % n];
      total += toRad(p2.lng - p1.lng) * (2 + Math.sin(toRad(p1.lat)) + Math.sin(toRad(p2.lat)));
    }
    return Math.abs((total * R * R) / 2) / 1e6;
  }

  function insideFreeZone(bounds) {
    if (!state.freeBounds) return true;
    const f = state.freeBounds;
    return (
      bounds.getWest() >= f.getWest() - 1e-9 &&
      bounds.getEast() <= f.getEast() + 1e-9 &&
      bounds.getSouth() >= f.getSouth() - 1e-9 &&
      bounds.getNorth() <= f.getNorth() + 1e-9
    );
  }

  function installAoi(layer) {
    if (state.aoi) map.removeLayer(state.aoi);
    state.aoi = layer.addTo(map);
    state.aoiBounds = layer.getBounds();
    const rings = layer.getLatLngs();
    state.aoiAreaKm2 = Math.round(ringAreaKm2(Array.isArray(rings[0]) ? rings[0] : rings) * 10) / 10;

    const inZone = insideFreeZone(state.aoiBounds);
    const b = state.aoiBounds;
    $("factBounds").textContent =
      `${b.getWest().toFixed(3)}, ${b.getSouth().toFixed(3)} → ${b.getEast().toFixed(3)}, ${b.getNorth().toFixed(3)}`;
    $("factArea").textContent = state.aoiAreaKm2 + " km²";
    $("aoiMeta").textContent = inZone ? "AOI inside free zone" : "AOI extends past free zone";
    const chip = $("zoneChip");
    chip.textContent = inZone ? "IN ZONE" : "OUTSIDE";
    chip.className = "chip chip-mini " + (inZone ? "chip-green" : "chip-red");
    $("aoiNote").classList.toggle("warn", !inZone);
    $("aoiNote").innerHTML = inZone
      ? "Your AOI sits fully inside the dashed free-public-data boundary — every layer can answer here."
      : "<b>Part of your AOI is outside free public coverage.</b> The map still shows it, but answers only cover the dashed zone (Sentinel‑1/2, MODIS are free there).";

    map.fitBounds(b, { padding: [30, 30], maxZoom: 13 });
    toast(`AOI set · ${state.aoiAreaKm2} km² ${inZone ? "" : "· partly outside free zone"}`, !inZone);
    updateStatus();
    // SAR tiles are registered per-bbox — refresh for the new footprint
    ensureSarMosaic(currentSarBbox(), state.modality === "SAR");
  }

  function clearAoi() {
    if (state.aoi) { map.removeLayer(state.aoi); state.aoi = null; }
    state.aoiBounds = null;
    state.aoiAreaKm2 = null;
    $("factBounds").textContent = state.freeBounds
      ? `${state.freeBounds.getWest().toFixed(3)}, ${state.freeBounds.getSouth().toFixed(3)} → ${state.freeBounds.getEast().toFixed(3)}, ${state.freeBounds.getNorth().toFixed(3)}`
      : "—";
    $("factArea").textContent = "—";
    $("aoiMeta").textContent = "no AOI yet — using demo zone";
    const chip = $("zoneChip");
    chip.textContent = "IN ZONE";
    chip.className = "chip chip-mini chip-green";
    $("aoiNote").classList.remove("warn");
    $("aoiNote").innerHTML =
      "Only imagery inside the dashed boundary is free &amp; public (Sentinel‑1/2, MODIS). Drawing outside is allowed, but answers stay inside the public zone.";
    toast("AOI cleared");
    updateStatus();
    cancelPoly();
    cancelRect();
  }

  /* ============================================================ results */
  function clearResults() {
    if (state.results) { map.removeLayer(state.results); state.results = null; }
    const body = $("answerBody");
    body.innerHTML =
      '<p class="answer-empty">Ask a question on the left. The assistant will pick <b>Optical</b>, ' +
      "<b>Thermal</b> or <b>SAR</b>, explain why, and highlight regions straight on the map.</p>";
    $("answerMeta").textContent = "waiting for a query…";
    $("answerModalityChip").textContent = "—";
    $("answerModalityChip").className = "chip chip-blue chip-mini";
    $("swResult").style.background = "rgba(224,58,69,.55)";
    updateStatus();
  }

  function drawResults(fc, modality) {
    clearResults();
    if (!fc) return;
    const info = MOD_INFO[modality] || MOD_INFO.Optical;
    state.results = L.geoJSON(fc, {
      style: {
        color: info.dark,
        weight: 3,
        fillColor: info.color,
        fillOpacity: 0.34,
      },
      onEachFeature: (feature, lyr) => {
        const p = feature.properties || {};
        lyr.bindTooltip(p.label || "detected region", { sticky: false, direction: "top" });
        lyr.bindPopup(
          `<b>${p.label || "Detected region"}</b><br/>${p.note || ""}`
        );
      },
    }).addTo(map);

    $("swResult").style.background = hexToRgba(info.color, 0.55);
    const bounds = state.results.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [34, 34], maxZoom: 13 });
    updateStatus();
  }

  function hexToRgba(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function fitResults() {
    if (state.results && state.results.getBounds().isValid()) {
      map.fitBounds(state.results.getBounds(), { padding: [34, 34], maxZoom: 13 });
    } else if (state.aoiBounds) {
      map.fitBounds(state.aoiBounds, { padding: [30, 30], maxZoom: 13 });
    } else if (state.freeBounds) {
      map.fitBounds(state.freeBounds, { padding: [26, 26] });
    }
  }

  /* ============================================================ live VLM */
  /**
   * Live vision-language routing.
   *
   * The browser never sees the API key: it POSTs the query plus downscaled
   * satellite imagery to /api/route, which proxies the configured provider
   * (groq / gemini / any OpenAI-compatible endpoint). Every failure path —
   * no key configured, server unreachable, provider error, unparseable reply —
   * resolves to null so the caller keeps the transparent rule engine.
   */
  const VLM = {
    status: { configured: false, reason: "unknown" },

    async init() {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (res.ok) this.status = await res.json();
      } catch (err) {
        // opened from file:// or the proxy is down — rule engine only
        this.status = { configured: false, reason: "server-unreachable" };
      }
      paintMode();
      return this.status;
    },

    /**
     * Choose which imagery to send, cropped to the user's AOI.
     *
     * Latency and cost both scale with the number of images, so start from the
     * freshest optical view plus whichever sensor the rule engine already
     * suspects. The model still makes the final call and may override it.
     */
    async images(query) {
      const samples = state.catalog.samples || [];
      const byId = (id) => samples.find((s) => s.id === id);
      const optical = samples.filter((s) => s.modality === "Optical");
      const wantsChange = /chang|differ|compar|before|after|since \d{4}|growth|expand/i.test(query);
      const guessed = (E.route(query) || {}).modality;

      const pick = [];
      if (optical.length) pick.push(optical[optical.length - 1]);

      if (wantsChange) {
        // a real before/after pair is the only way to see change
        if (byId("optical_2017")) pick.push(byId("optical_2017"));
      } else if (guessed === "Thermal") {
        if (byId("thermal_lst")) pick.push(byId("thermal_lst"));
      } else if (guessed === "SAR") {
        if (byId("sar_vv")) pick.push(byId("sar_vv"));
      } else {
        const extra = byId("thermal_lst") || byId("sar_vv");
        if (extra) pick.push(extra);
      }

      const out = [];
      for (const s of pick.slice(0, 3)) {
        try {
          out.push({ label: s.modality, dataUrl: await cropDataUrl(s) });
        } catch (err) {
          /* sample missing — send the rest */
        }
      }
      return out;
    },

    async route(query) {
      if (!this.status.configured) return null;
      const imgs = await this.images(query);
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          aoiName: state.catalog.aoi && state.catalog.aoi.name,
          bbox: boundsBox(state.freeBounds),
          aoi: state.aoiBounds ? boundsBox(state.aoiBounds) : null,
          modalities: imgs.map((i) => i.label),
          images: imgs.map((i) => i.dataUrl),
        }),
      });
      const json = await res.json().catch(() => null);
      if (!json || !json.ok || !json.decision) {
        return { error: (json && json.reason) || "http-" + res.status };
      }
      return { decision: json.decision, source: json.source };
    },
  };

  const boundsBox = (b) => [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("cannot load " + src));
      img.src = src;
    });
  }

  /** Overlap of two Leaflet bounds, or null when they do not touch. */
  function intersectBounds(a, b) {
    const w = Math.max(a.getWest(), b.getWest());
    const e = Math.min(a.getEast(), b.getEast());
    const s = Math.max(a.getSouth(), b.getSouth());
    const n = Math.min(a.getNorth(), b.getNorth());
    if (w >= e || s >= n) return null;
    return L.latLngBounds([s, w], [n, e]);
  }

  /**
   * Crop a sample down to the AOI and shrink it for transport.
   *
   * This is the single biggest lever on answer quality. Sending the whole city
   * and naming the AOI only in text gives the model no way to know which part
   * of the picture you mean, so it describes the entire scene. Sending the crop
   * makes the image *be* the AOI, and answers become about your area.
   */
  async function cropDataUrl(s, max, quality) {
    const img = await loadImage("data/" + s.file);
    const sb = sampleBounds(s);
    const free = state.freeBounds;

    // Start from the free public part of this sample, then cut down to the AOI.
    let box = (free && intersectBounds(sb, free)) || sb;

    if (state.aoiBounds) {
      const cut = intersectBounds(box, state.aoiBounds);
      // Drawing outside free coverage is allowed, but there is no public imagery
      // to send for it. Sending the uncropped scene while telling the model the
      // image *is* the AOI would be a lie, so send nothing instead.
      if (!cut) throw new Error("AOI has no free public coverage");
      box = cut;
    }

    const spanLon = sb.getEast() - sb.getWest();
    const spanLat = sb.getNorth() - sb.getSouth();
    const fx0 = (box.getWest() - sb.getWest()) / spanLon;
    const fx1 = (box.getEast() - sb.getWest()) / spanLon;
    const fy0 = (sb.getNorth() - box.getNorth()) / spanLat; // images start at the north edge
    const fy1 = (sb.getNorth() - box.getSouth()) / spanLat;

    const sx = Math.max(0, Math.round(fx0 * img.naturalWidth));
    const sy = Math.max(0, Math.round(fy0 * img.naturalHeight));
    const sw = Math.max(1, Math.round((fx1 - fx0) * img.naturalWidth));
    const sh = Math.max(1, Math.round((fy1 - fy0) * img.naturalHeight));

    const limit = max || 768;
    const scale = Math.min(1, limit / Math.max(sw, sh));
    const cw = Math.max(1, Math.round(sw * scale));
    const ch = Math.max(1, Math.round(sh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cw, ch);
    return canvas.toDataURL("image/jpeg", quality || 0.74);
  }

  /** Show the user which brain is answering. */
  function paintMode() {
    const chip = $("aiModeChip");
    const s = VLM.status;
    if (s.configured) {
      chip.textContent = "LIVE VLM";
      chip.className = "chip chip-green chip-mini";
      $("aiStatus").textContent =
        `ready · live VLM (${s.provider})${s.sendImages ? " · sees imagery" : " · text only"}`;
    } else {
      chip.textContent = "RULE-BASED";
      chip.className = "chip chip-blue chip-mini";
      $("aiStatus").textContent = "ready · rule-based router (add a key in .env for live VLM)";
    }
  }

  /** Adapt a model decision to exactly the shape the rule engine returns. */
  function adaptVlm(vlm, fallback, ctx) {
    const d = vlm.decision;
    const src = vlm.source || {};
    return {
      intent: d.intent || fallback.intent,
      modality: d.modality || fallback.modality,
      confidence: typeof d.confidence === "number" ? d.confidence : fallback.confidence,
      matched: [],
      live: src,
      insight: {
        title: d.title || fallback.insight.title,
        answer: () => (d.answer && d.answer.trim() ? d.answer : fallback.insight.answer(ctx)),
        why: d.why && d.why.length ? d.why : fallback.insight.why,
        dataset: src.model ? `${src.label || "live VLM"} · ${src.model}` : "live VLM",
        // no usable polygons from the model? fall back to the rule regions so
        // the answer stays grounded on the map instead of showing nothing
        regions: d.regions || fallback.insight.regions,
      },
    };
  }

  /* ============================================================ chat */
  const chat = $("chatMessages");

  function addMsg(kind, html) {
    const wrap = el("div", "msg msg-" + kind);
    if (kind === "ai") wrap.appendChild(el("div", "msg-avatar", "SQ"));
    else wrap.appendChild(el("div", "msg-avatar", "YOU"));
    const body = el("div", "msg-body", html);
    wrap.appendChild(body);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
    return body;
  }

  const STAGES = [
    "parsing query…",
    "routing modality…",
    "loading free tiles…",
    "grounding regions…",
  ];

  async function handleQuery(raw) {
    const q = (raw || "").trim();
    if (!q) return;

    addMsg("user", `<p>${escapeHtml(q)}</p>`);
    $("queryInput").value = "";

    // typing indicator + staged status
    const pending = addMsg("ai", '<span class="typing"><span></span><span></span><span></span></span>');
    for (let i = 0; i < STAGES.length; i++) {
      $("aiStatus").textContent = STAGES[i];
      await wait(i === 0 ? 260 : 220);
    }

    const ruleDecision = E.route(q);
    const ctx = {
      aoiName: state.catalog.aoi.name,
      aoiLabel: state.aoiBounds ? "your AOI" : `the ${state.catalog.aoi.name} free zone`,
      area: state.aoiAreaKm2,
      date: new Date().toISOString().slice(0, 10),
    };

    // Live vision-language first; the rule engine is the guaranteed fallback.
    let decision = ruleDecision;
    if (VLM.status.configured) {
      $("aiStatus").textContent = `asking ${VLM.status.label || VLM.status.provider}…`;
      try {
        const vlm = await VLM.route(q);
        if (vlm && vlm.decision) {
          decision = adaptVlm(vlm, ruleDecision, ctx);
        } else if (vlm && vlm.error === "rate-limited") {
          toast("Free-tier rate limit reached — rule engine answered this one", true);
        } else {
          toast(`live VLM unavailable (${vlm && vlm.error}) — rule engine used`, true);
        }
      } catch (err) {
        toast(`live VLM failed — rule engine used`, true);
      }
    }

    const ins = decision.insight;
    const modality = decision.modality;
    const info = modality ? MOD_INFO[modality] : null;

    // route the map
    if (modality) setModality(modality, { routed: true });

    // draw grounded regions
    let regionHtml = "";
    if (ins.regions) {
      drawResults(ins.regions, modality);
      regionHtml =
        '<ul class="region-list">' +
        ins.regions.features
          .map(
            (f, i) =>
              `<li data-region="${i}"><b>${escapeHtml(f.properties.label)}</b> — ${escapeHtml(f.properties.note)}</li>`
          )
          .join("") +
        "</ul>";
    }

    // tags
    const tags = [];
    tags.push(`<span class="chip chip-mini ${info ? info.cls : "chip-blue"}">${(modality || "ROUTER").toUpperCase()}</span>`);
    tags.push(`<span class="chip chip-mini chip-ghost">intent: ${decision.intent}</span>`);
    tags.push(
      `<span class="chip chip-mini chip-ghost">conf ${(decision.confidence || 0).toFixed(2)}</span>`
    );
    // be explicit about which brain produced this answer
    tags.push(
      decision.live
        ? `<span class="chip chip-mini chip-green">live ${escapeHtml(decision.live.label || "VLM")}${
            decision.live.images ? ` · ${decision.live.images} img` : ""
          }</span>`
        : '<span class="chip chip-mini chip-blue">rule engine</span>'
    );

    const bodyHtml =
      `<div class="msg-tags">${tags.join("")}</div>` +
      `<p><b>${escapeHtml(ins.title)}.</b> ${escapeHtml(ins.answer(ctx))}</p>` +
      '<p class="msg-hint"><b>Why this layer:</b></p>' +
      `<ul class="reason-list">${ins.why.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` +
      regionHtml +
      `<div class="msg-tags" style="margin-top:10px"><span class="chip chip-mini chip-blue">dataset</span>` +
      `<span class="chip chip-mini chip-ghost">${escapeHtml(ins.dataset)}</span></div>` +
      '<div class="answer-actions">' +
      '<button class="btn btn-ghost btn-sm" data-act="fit">⌖ Fit to results</button>' +
      (ins.regions ? '<button class="btn btn-ghost btn-sm" data-act="clear">✕ Clear highlights</button>' : "") +
      "</div>";

    pending.innerHTML = bodyHtml;

    // clickable region list → zoom to region
    pending.querySelectorAll("[data-region]").forEach((li) => {
      li.style.cursor = "pointer";
      li.addEventListener("click", () => {
        const idx = +li.dataset.region;
        const lyr = state.results && state.results.getLayers()[idx];
        if (lyr) {
          map.fitBounds(lyr.getBounds(), { padding: [40, 40], maxZoom: 14 });
          lyr.openPopup();
        }
      });
    });
    pending.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.dataset.act === "fit") fitResults();
        else clearResults();
      });
    });

    // mirror into the big answer card
    $("answerModalityChip").textContent = (modality || "ROUTER").toUpperCase();
    $("answerModalityChip").className = "chip chip-mini " + (info ? info.cls : "chip-blue");
    const sourceNote = decision.live
      ? `live ${decision.live.label || "VLM"}${decision.live.images ? ` · ${decision.live.images} img` : ""}${
          // a fast provider can legitimately report 0 ms, so test for a number
          Number.isFinite(decision.live.ms) ? ` · ${decision.live.ms} ms` : ""
        }`
      : decision.matched && decision.matched.length
        ? `matched: ${decision.matched.slice(0, 3).join(", ")}`
        : "rule engine";
    $("answerMeta").textContent =
      `intent ${decision.intent} · ${sourceNote} · ` +
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    $("answerBody").innerHTML =
      `<div class="answer-lead"><b>${escapeHtml(ins.title)}.</b> ${escapeHtml(ins.answer(ctx))}</div>` +
      `<ul class="reason-list">${ins.why.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` +
      regionHtml;

    $("aiStatus").textContent = modality
      ? `routed → ${modality} · ${decision.live ? "live VLM · " : "rule-based · "}${ins.dataset}`
      : "routing explanation · no layer change";
    updateStatus();
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ============================================================ samples */
  function sampleCard(s) {
    const cls = s.modality === "Optical" ? "m-optical" : s.modality === "Thermal" ? "m-thermal" : "m-sar";
    const card = el("article", "sample-card card");
    card.innerHTML =
      '<div class="sample-thumb">' +
      `<span class="sample-mod ${cls}">${s.modality.toUpperCase()}</span>` +
      `<img src="data/${s.file}" alt="${escapeHtml(s.title)}" loading="lazy" />` +
      "</div>" +
      '<div class="sample-body">' +
      `<span class="sample-title">${escapeHtml(s.title)}</span>` +
      `<span class="sample-meta">${escapeHtml(s.provider)}<br/>${escapeHtml(s.date)} · ${escapeHtml(s.sensor)}</span>` +
      `<span class="sample-res mono">${s.native_m ? `native ${s.native_m} m/px` : ""}${
        s.footprint === "sample" ? " · high-res 8 km footprint" : " · city footprint"
      }</span>` +
      `<span class="sample-use">${escapeHtml(s.best_for)}</span>` +
      '<div class="sample-tags">' +
      `<span class="chip chip-mini chip-ghost">${escapeHtml(s.license.slice(0, 42))}${s.license.length > 42 ? "…" : ""}</span>` +
      "</div>" +
      '<div class="sample-actions">' +
      `<button class="btn btn-ghost btn-sm" data-sample="${s.id}">Show on map</button>` +
      (s.source_url
        ? `<a class="btn btn-ghost btn-sm" href="${s.source_url}" target="_blank" rel="noopener">Source ↗</a>`
        : "") +
      "</div></div>";
    card.querySelector("[data-sample]").addEventListener("click", (ev) => toggleSample(s, ev.currentTarget));
    return card;
  }

  /**
   * The area a sample actually covers.
   *
   * Each sample carries its own bbox because the right footprint depends on
   * the sensor: Sentinel-2 (10 m) and Sentinel-1 (20 m) hold detail over a
   * small box, while MODIS (1 km) only has real detail at city scale. Stretching
   * a sample across a footprint it was not collected for is what makes it blur.
   */
  function sampleBounds(s) {
    const box = s && Array.isArray(s.bbox) && s.bbox.length === 4 ? s.bbox : null;
    if (box) return L.latLngBounds([box[1], box[0]], [box[3], box[2]]);
    const b = state.freeBounds || L.latLngBounds([18.85, 72.75], [19.35, 73.05]);
    return L.latLngBounds([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]);
  }

  function boundsOf(s) {
    return sampleBounds(s);
  }

  function toggleSample(s, btn) {
    const existing = state.sampleOverlays.get(s.id);
    if (existing) {
      map.removeLayer(existing);
      state.sampleOverlays.delete(s.id);
      if (btn) { btn.textContent = "Show on map"; btn.classList.remove("btn-primary"); }
      toast(`${s.modality} sample hidden`);
      return;
    }
    const bounds = boundsOf(s);
    const ov = L.imageOverlay("data/" + s.file, bounds, {
      opacity: 0.88,
      interactive: true,
      attribution: s.provider,
    }).addTo(map);
    ov.bindTooltip(s.title, { direction: "top" });
    state.sampleOverlays.set(s.id, ov);
    if (btn) { btn.textContent = "Hide sample"; btn.classList.add("btn-primary"); }
    // leave a little air around the footprint and stay inside the sharp range
    map.fitBounds(bounds, { padding: [26, 26], maxZoom: 13 });
    toast(
      `${s.modality} sample overlaid ✓ ${s.native_m ? `native ${s.native_m} m/px` : ""}${
        s.footprint === "sample" ? " · high-res footprint" : ""
      }`
    );
  }

  function toggleAllSamples(force) {
    const anyActive = state.sampleOverlays.size > 0;
    const turnOn = force != null ? force : !anyActive;
    if (turnOn && !anyActive) {
      (state.catalog.samples || []).forEach((s) => toggleSample(s, null));
      // fix button labels (they were toggled without btn refs)
      document.querySelectorAll("[data-sample]").forEach((b) => {
        b.textContent = "Hide sample";
        b.classList.add("btn-primary");
      });
      state.samplesActive = true;
      $("btnLoadSamples").textContent = "Hide sample overlays";
    } else if (!turnOn && anyActive) {
      Array.from(state.sampleOverlays.keys()).forEach((id) => {
        const s = (state.catalog.samples || []).find((x) => x.id === id);
        if (s) toggleSample(s, null);
      });
      document.querySelectorAll("[data-sample]").forEach((b) => {
        b.textContent = "Show on map";
        b.classList.remove("btn-primary");
      });
      state.samplesActive = false;
      $("btnLoadSamples").textContent = "Preview sample overlays";
    }
  }

  async function loadCatalog() {
    let cat = null;
    try {
      const res = await fetch("data/catalog.json", { cache: "no-store" });
      if (res.ok) cat = await res.json();
    } catch (err) {
      /* file:// or offline — fall back */
    }
    state.catalog = cat && cat.samples ? cat : FALLBACK_CATALOG;

    const g = $("gallery");
    g.innerHTML = "";
    if (!state.catalog.samples.length) {
      g.innerHTML = '<p class="gallery-loading">no samples found</p>';
      return;
    }
    state.catalog.samples.forEach((s) => g.appendChild(sampleCard(s)));
    if (cat) {
      $("aiStatus").textContent = `catalog loaded · ${cat.samples.length} free samples`;
    } else {
      $("aiStatus").textContent = "catalog fallback (serve over http to load data/catalog.json)";
    }
  }

  /* ============================================================ swipe compare */
  /**
   * Before/after comparison of the two Sentinel-2 mosaics.
   *
   * Both years were collected over the identical footprint, so they line up
   * pixel for pixel: 2017 is drawn underneath, 2025 sits on top and is clipped
   * horizontally, and the slider moves the clip. What you see left of the
   * divider is 2017, right of it is 2025.
   */
  const swipe = { on: false, below: null, above: null, divider: null, pct: 50 };

  function swipePair() {
    const cat = state.catalog.samples || [];
    return [cat.find((s) => s.id === "optical_2017"), cat.find((s) => s.id === "optical_2025")];
  }

  function setSwipe(force) {
    const [a, b] = swipePair();
    const want = force != null ? force : !swipe.on;

    if (want && (!a || !b)) {
      toast("both optical years are needed for the comparison", true);
      return;
    }

    if (!want) {
      if (swipe.below) { map.removeLayer(swipe.below); swipe.below = null; }
      if (swipe.above) { map.removeLayer(swipe.above); swipe.above = null; }
      if (swipe.divider) { swipe.divider.remove(); swipe.divider = null; }
      swipe.on = false;
      $("swipe").hidden = true;
      $("btnSwipe").classList.remove("is-active");
      return;
    }

    const bounds = boundsOf(b);
    swipe.below = L.imageOverlay("data/" + a.file, bounds, {
      opacity: 1, interactive: false, attribution: a.provider,
    }).addTo(map);
    swipe.above = L.imageOverlay("data/" + b.file, bounds, {
      opacity: 1, interactive: false, attribution: b.provider,
    }).addTo(map);

    swipe.on = true;
    swipe.pct = +$("swipeRange").value;
    $("swipe").hidden = false;
    $("btnSwipe").classList.add("is-active");
    map.fitBounds(bounds, { padding: [20, 20], maxZoom: 13 });
    paintSwipe();
    toast("Drag the slider: 2017 on the left, 2025 on the right");
  }

  function paintSwipe() {
    if (!swipe.on || !swipe.above) return;
    const el = swipe.above.getElement();
    if (el) el.style.clipPath = `inset(0 0 0 ${swipe.pct}%)`;

    // the divider tracks the same percentage across the shared footprint
    const b = swipe.above.getBounds();
    const nw = map.latLngToContainerPoint(b.getNorthWest());
    const se = map.latLngToContainerPoint(b.getSouthEast());
    if (!swipe.divider) {
      swipe.divider = L.DomUtil.create("div", "swipe-divider", map.getContainer());
    }
    swipe.divider.style.left = nw.x + (se.x - nw.x) * (swipe.pct / 100) + "px";
    swipe.divider.style.top = nw.y + "px";
    swipe.divider.style.height = Math.max(0, se.y - nw.y) + "px";
  }

  /* ============================================================ wiring */
  // tools
  document.querySelectorAll("[data-tool]").forEach((btn) =>
    btn.addEventListener("click", () => setTool(btn.dataset.tool))
  );
  // basemap
  document.querySelectorAll("[data-base]").forEach((btn) =>
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-base]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      if (btn.dataset.base === "satellite") {
        map.removeLayer(streets);
        satellite.addTo(map);
        // keep modality layer on top
        if (layers[state.modality] && !map.hasLayer(layers[state.modality])) layers[state.modality].addTo(map);
      } else {
        map.removeLayer(satellite);
        streets.addTo(map);
        if (layers[state.modality] && !map.hasLayer(layers[state.modality])) layers[state.modality].addTo(map);
      }
      toast(btn.dataset.base === "satellite" ? "Base: satellite imagery" : "Base: streets");
    })
  );
  $("btnRecenter").addEventListener("click", () => {
    if (state.freeBounds) map.fitBounds(state.freeBounds, { padding: [26, 26] });
    toast("Fitted to free public data zone");
  });
  $("btnClearResults").addEventListener("click", clearResults);
  $("btnLoadSamples").addEventListener("click", () => toggleAllSamples());

  // change comparison + keep the divider glued to the imagery
  $("btnSwipe").addEventListener("click", () => setSwipe());
  $("swipeClose").addEventListener("click", () => setSwipe(false));
  $("swipeRange").addEventListener("input", (e) => {
    swipe.pct = +e.target.value;
    paintSwipe();
  });
  map.on("zoomend move", paintSwipe);

  // "Open console" should put the caret in the box, not just scroll there
  document.querySelectorAll('a[href="#console"]').forEach((link) =>
    link.addEventListener("click", () => {
      window.setTimeout(() => {
        const input = $("queryInput");
        if (input) input.focus({ preventScroll: true });
        const panel = document.querySelector(".chat-panel");
        if (panel) {
          panel.classList.remove("flash");
          void panel.offsetWidth; // restart the animation
          panel.classList.add("flash");
          window.setTimeout(() => panel.classList.remove("flash"), 1000);
        }
      }, 420);
    })
  );

  // modality cards (manual override)
  document.querySelectorAll(".mod-card").forEach((card) =>
    card.addEventListener("click", () => setModality(card.dataset.modality, { routed: false }))
  );

  // chat form + example chips
  $("queryForm").addEventListener("submit", (e) => {
    e.preventDefault();
    handleQuery($("queryInput").value);
  });
  document.querySelectorAll("#exampleChips [data-q]").forEach((chip) =>
    chip.addEventListener("click", () => handleQuery(chip.dataset.q))
  );

  /* ============================================================ boot */
  async function boot() {
    await loadCatalog();
    await VLM.init();
    drawFreeZone(state.catalog.aoi.bbox);
    $("factZone").textContent = state.catalog.aoi.name;
    $("factBounds").textContent =
      `${state.freeBounds.getWest().toFixed(3)}, ${state.freeBounds.getSouth().toFixed(3)} → ` +
      `${state.freeBounds.getEast().toFixed(3)}, ${state.freeBounds.getNorth().toFixed(3)}`;
    setModality("Optical", { silent: true });
    updateStatus();
    // register a SAR mosaic for the demo zone so the layer is live on first use
    ensureSarMosaic(currentSarBbox(), false);
    setTimeout(() => toast("Draw an AOI, then ask the assistant a question ▶"), 900);
  }
  boot();
})();
