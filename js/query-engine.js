/* ==========================================================================
   SATQUERY AI — query → modality routing engine (MVP)

   Transparent rule-based stand-in for the GEOCHAT / LLaVA service.
   Routing contract (from the problem statement demo):
     · change / description questions      → OPTICAL
     · "where are the floods" questions    → THERMAL
     · night / radar questions             → SAR
   The engine returns the routing decision, the answer copy, the "why this
   layer" reasoning and a GeoJSON FeatureCollection of regions to highlight.
   ========================================================================== */
(function (global) {
  "use strict";

  /* ---------------------------------------------------------------- palette */
  const COLORS = {
    Optical: "#12a150",
    Thermal: "#e03a45",
    SAR: "#e8930c",
  };

  /* -------------------------------------------------- preloaded datasets */
  const DATASETS = {
    Optical: "Sentinel‑2 true colour · EOX s2cloudless · 10–60 m · free",
    Thermal: "MODIS Terra LST · NASA GIBS · 1 km · 2025‑02‑15 · free",
    SAR: "Sentinel‑1 IW GRD VV · Planetary Computer · 20 m · free",
  };

  /* -------------------------------------------------------- keyword tables */
  const KEYWORDS = {
    Optical: [
      "change", "changed", "difference", "differ", "compare", "comparison",
      "before", "after", "describe", "description", "land cover", "landuse",
      "land use", "vegetation", "green", "ndvi", "crop", "crops", "agriculture",
      "urban growth", "growth", "expansion", "built-up", "built up",
      "deforestation", "forest", "construction", "visible", "look like",
      "looks like", "what does", "sentinel-2", "optical", "colour", "color",
      "mangrove", "water bodies", "since 2017",
    ],
    Thermal: [
      "flood", "floods", "flooding", "flooded", "inundation", "waterlogged",
      "standing water", "submerged", "heat", "hot", "hotspot", "hotspot",
      "temperature", "warm", "drought", "fire", "burning", "thermal",
      "urban heat", "cool", "lake level",
    ],
    SAR: [
      "night", "nighttime", "night-time", "dark", "radar", "cloud", "cloudy",
      "all-weather", "all weather", "ship", "ships", "vessel", "vessels",
      "port", "shipping", "harbour", "harbor", "anchorage", "oil spill",
      "backscatter", "synthetic aperture", "sentinel-1", "illumination",
      "through clouds", "day or night",
    ],
  };

  /* ------------------------------------------------------------- regions */
  const FC = (features) => ({ type: "FeatureCollection", features });
  const poly = (label, note, ring) => ({
    type: "Feature",
    properties: { label, note },
    geometry: { type: "Polygon", coordinates: [ring] },
  });

  const REGIONS = {
    flood: FC([
      poly(
        "Mithi River corridor",
        "Cold, flat standing-water signature along the Mithi floodplain (Kurla → Mahim).",
        [[72.873, 19.077], [72.887, 19.067], [72.870, 19.052], [72.854, 19.043],
         [72.840, 19.036], [72.834, 19.044], [72.850, 19.053], [72.863, 19.063],
         [72.866, 19.072]]
      ),
      poly(
        "Mahim Creek & bay",
        "Creek mouth holds a persistent cool anomaly — tidal backwater and pooled inundation.",
        [[72.838, 19.048], [72.826, 19.054], [72.816, 19.049], [72.820, 19.039],
         [72.833, 19.037], [72.839, 19.042]]
      ),
      poly(
        "Kurla–Chembur low belt",
        "Filled low ground between drains — thermal minima under sustained waterlogging.",
        [[72.887, 19.062], [72.906, 19.054], [72.914, 19.041], [72.901, 19.031],
         [72.884, 19.040], [72.879, 19.053]]
      ),
    ]),
    heat: FC([
      poly(
        "Dharavi–Sion heat core",
        "Dense low-rise fabric + waste heat: strongest urban heat-island signature.",
        [[72.833, 19.036], [72.858, 19.041], [72.866, 19.052], [72.850, 19.060],
         [72.830, 19.054], [72.825, 19.043]]
      ),
      poly(
        "Santacruz–airport tarmac",
        "Runway and apron surfaces run several °C above the vegetated surroundings.",
        [[72.862, 19.088], [72.897, 19.090], [72.900, 19.108], [72.866, 19.110],
         [72.857, 19.099]]
      ),
      poly(
        "Taloja–Panvel industrial belt",
        "Industrial roofs and hard surfaces: persistent warm plume downwind.",
        [[72.998, 19.040], [73.034, 19.037], [73.038, 19.058], [73.004, 19.062]],
      ),
    ]),
    change: FC([
      poly(
        "Northern growth corridor",
        "Borivali → Dahisar → Mira Road: largest built-up gain between the 2017 and 2025 mosaics.",
        [[72.830, 19.228], [72.862, 19.236], [72.884, 19.266], [72.866, 19.286],
         [72.834, 19.268], [72.820, 19.242]]
      ),
      poly(
        "Ulwe–Panvel expansion",
        "Navi Mumbai: new reclaimed blocks, road grid and construction visible since 2017.",
        [[72.972, 18.975], [73.020, 18.968], [73.032, 18.930], [72.996, 18.917],
         [72.966, 18.941]]
      ),
      poly(
        "Gorai–Versova edge",
        "Salt-pan and mangrove edge converted to settlement — loss of dark, wet pixels.",
        [[72.797, 19.150], [72.822, 19.160], [72.834, 19.130], [72.812, 19.117],
         [72.795, 19.128]]
      ),
    ]),
    landcover: FC([
      poly(
        "Sanjay Gandhi National Park",
        "Continuous dense canopy — the green heart of the AOI (NDVI-high).",
        [[72.864, 19.150], [72.918, 19.156], [72.944, 19.196], [72.924, 19.256],
         [72.874, 19.250], [72.854, 19.200]]
      ),
      poly(
        "Thane Creek mudflats & mangroves",
        "Tidal mudflats + mangrove belt — wet, dark, tidally varying reflectance.",
        [[72.945, 19.122], [72.978, 19.140], [73.002, 19.112], [72.975, 19.082],
         [72.946, 19.092]]
      ),
      poly(
        "Built-up island city core",
        "High-density built-up: bright, rough, impervious surface dominant.",
        [[72.798, 18.958], [72.852, 18.966], [72.874, 19.006], [72.844, 19.028],
         [72.796, 19.008]]
      ),
    ]),
    ports: FC([
      poly(
        "Mumbai Port docks & Ballard Estate",
        "Quay walls and cranes give strong double-bounce returns — bright linear features.",
        [[72.826, 18.988], [72.852, 18.996], [72.860, 19.024], [72.836, 19.032],
         [72.818, 19.012]]
      ),
      poly(
        "JNPA / Nhava Sheva terminal",
        "Container stacks and gantries: the brightest cluster in the western harbour.",
        [[72.972, 18.938], [73.018, 18.936], [73.030, 18.960], [73.000, 18.974],
         [72.970, 18.966]]
      ),
      poly(
        "Harbour approach & anchorage",
        "Calm water (dark) with isolated point targets — vessels at anchor waiting for berth.",
        [[72.902, 18.902], [72.948, 18.912], [72.956, 18.880], [72.912, 18.868]],
      ),
    ]),
    night: FC([
      poly(
        "Airport apron — 24 h lighting",
        "Tarmac and apron stay bright at night; double-bounce from parked airframes.",
        [[72.858, 19.086], [72.898, 19.088], [72.900, 19.112], [72.862, 19.112]],
      ),
      poly(
        "Flood-lit port terminals",
        "Night crane operations are visible as bright, structured clusters in SAR.",
        [[72.978, 18.942], [73.020, 18.940], [73.026, 18.962], [72.984, 18.968]],
      ),
      poly(
        "Sion–Kurla arterial corridor",
        "Elevated road corridor: metal structures + traffic render as a bright ribbon.",
        [[72.866, 19.038], [72.900, 19.030], [72.906, 19.046], [72.872, 19.056]],
      ),
    ]),
  };

  /* ------------------------------------------------------------- insights */
  // ctx = { aoiName, area, aoiLabel, date }
  const INSIGHTS = {
    meta: {
      modality: null,
      title: "How I route your query",
      answer: (c) =>
        `Here is my transparent routing table, ${c.aoiLabel}:`,
      why: [
        "change · difference · describe · land cover questions → OPTICAL (Sentinel‑2 sees reflectance, ideal for before/after).",
        "flood · standing water · heat questions → THERMAL (MODIS LST flags cold flood anomalies and hotspots).",
        "night · dark · radar · cloud · port questions → SAR (Sentinel‑1 carries its own light, day or night).",
        "Ties fall back to OPTICAL — it is the most broadly descriptive sensor.",
      ],
      dataset: "rule-based router · GEOCHAT/LLaVA slot-in",
      regions: null,
    },
    flood: {
      modality: "Thermal",
      title: "Flood extent via thermal anomalies",
      answer: (c) =>
        `THERMAL is now active over ${c.aoiLabel}. Standing water holds and evaporates heat, so flooded ground reads several degrees colder than the built-up fabric around it — I highlighted ${REGIONS.flood.features.length} zones where the land-surface temperature drops sharply against the surrounding city.`,
      why: [
        "Flood water + wet soil stay cooler than roads and roofs → reliable cold signature in LST.",
        "Thermal keeps working under cloud cover that blinds optical sensors during monsoon storms.",
        "MODIS LST is free & public (NASA EOSDIS) — no key, no billing.",
      ],
      dataset: DATASETS.Thermal,
      regions: REGIONS.flood,
    },
    heat: {
      modality: "Thermal",
      title: "Heat hotspots & urban heat island",
      answer: (c) =>
        `THERMAL is active over ${c.aoiLabel}. I compared land-surface temperature across the zone and highlighted ${REGIONS.heat.features.length} hotspots where surfaces run hottest — dense built-up cores and industrial/asphalt belts with almost no canopy.`,
      why: [
        "LST directly measures emitted infrared — the actual surface temperature, not air temperature.",
        "Cool zones (water, canopy) act as the control: warm/cool contrast isolates the heat island.",
        "NASA GIBS serves it as free, dated WMTS tiles.",
      ],
      dataset: DATASETS.Thermal,
      regions: REGIONS.heat,
    },
    change: {
      modality: "Optical",
      title: "Change detection, 2017 → 2025",
      answer: (c) =>
        `OPTICAL is active over ${c.aoiLabel}. I differenced the 2017 and 2025 Sentinel‑2 mosaics: bright, newly gridded pixels are new construction, while lost dark pixels are removed canopy or wetlands. ${REGIONS.change.features.length} areas changed significantly in that window.`,
      why: [
        "Two annual mosaics (2017 vs 2025) share geometry → pixel-wise difference is valid.",
        "Reflectance change = built-up gain, vegetation loss, reclamation, or new water.",
        "Both mosaics are free (Copernicus Sentinel‑2 via EOX s2cloudless).",
      ],
      dataset: DATASETS.Optical,
      regions: REGIONS.change,
    },
    description: {
      modality: "Optical",
      title: "Land-cover description",
      answer: (c) =>
        `OPTICAL is active over ${c.aoiLabel}. Reading the true-colour mosaic I can separate ${REGIONS.landcover.features.length} main units — dense canopy, tidal mudflats/mangroves, and the built-up core — and I have outlined each one on the map with its signature.`,
      why: [
        "True colour maps directly to land-cover classes you can verify by eye.",
        "Spectral texture separates canopy (dark green), mudflat (dark smooth) and city (bright rough).",
        "Sentinel‑2 at 10–60 m resolves streets, parks and shorelines at city scale.",
      ],
      dataset: DATASETS.Optical,
      regions: REGIONS.landcover,
    },
    night: {
      modality: "SAR",
      title: "Night activity with radar",
      answer: (c) =>
        `SAR is active over ${c.aoiLabel}. Sentinel‑1 transmits its own microwave pulse, so this pass works in total darkness: metal structures, lit infrastructure and vessels bounce energy straight back as bright pixels. I highlighted ${REGIONS.night.features.length} zones of strong night-time response.`,
      why: [
        "Active sensor → no sunlight required; identical acquisition day or night.",
        "Double-bounce from cranes, airframes and overpasses = very bright returns.",
        "Works through cloud and rain — critical during monsoon nights when optical is blind.",
      ],
      dataset: DATASETS.SAR,
      regions: REGIONS.night,
    },
    port: {
      modality: "SAR",
      title: "Ports, ships & harbour activity",
      answer: (c) =>
        `SAR is active over ${c.aoiLabel}. Harbour surfaces read cleanly in C-band: calm water goes dark, ships and container stacks flare bright. I highlighted ${REGIONS.ports.features.length} operational areas — docks, terminals and the offshore anchorage.`,
      why: [
        "Specular (dark) water vs double-bounce (bright) steel = instant ship/port contrast.",
        "Radar sees through the haze and low cloud that often sits over the harbour.",
        "20 m Sentinel‑1 GRD is free & open from Copernicus.",
      ],
      dataset: DATASETS.SAR,
      regions: REGIONS.ports,
    },
    opticalDefault: {
      modality: "Optical",
      title: "Optical analysis",
      answer: (c) =>
        `OPTICAL is active over ${c.aoiLabel}. I could not detect a strong flood/night signal, so I defaulted to the most descriptive sensor and outlined ${REGIONS.landcover.features.length} land-cover units for you.`,
      why: [
        "No dominant keyword for thermal or SAR → optical is the safe, information-rich default.",
        "Sentinel‑2 true colour is verifiable by eye — a good baseline answer.",
        "Free & public (Copernicus via EOX s2cloudless).",
      ],
      dataset: DATASETS.Optical,
      regions: REGIONS.landcover,
    },
    thermalDefault: {
      modality: "Thermal",
      title: "Thermal scan",
      answer: (c) =>
        `THERMAL is active over ${c.aoiLabel}. I highlighted the strongest temperature anomalies — the hot industrial/dense zones — as a starting point for your query.`,
      why: [
        "Your wording signalled temperature/water rather than land cover or night activity.",
        "LST anomalies are the fastest thermal screening signal.",
        "NASA GIBS LST tiles are free & open.",
      ],
      dataset: DATASETS.Thermal,
      regions: REGIONS.heat,
    },
    sarDefault: {
      modality: "SAR",
      title: "Radar scan",
      answer: (c) =>
        `SAR is active over ${c.aoiLabel}. Strongest radar returns come from port structures and the harbour approach — I highlighted ${REGIONS.ports.features.length} response zones.`,
      why: [
        "Your wording pointed at night/radar/structures rather than land cover or temperature.",
        "C-band backscatter isolates metal structures and water edges instantly.",
        "Sentinel‑1 is free & open (Copernicus via Planetary Computer).",
      ],
      dataset: DATASETS.SAR,
      regions: REGIONS.ports,
    },
  };

  /* ------------------------------------------------------- intent detection */
  const INTENT_TESTS = [
    { intent: "flood", modality: "Thermal",
      re: /\b(flood|floods|flooding|flooded|inundat\w*|waterlog\w*|submerg\w*|standing water|deluge|monsoon water|high water)\b/i },
    { intent: "heat", modality: "Thermal",
      re: /\b(heat|hotspot|hot spot|hot|temperature|warm|drought|fire|burning|burnt|heatwave|urban heat)\b/i },
    { intent: "night", modality: "SAR",
      re: /\b(night|nighttime|night-time|in the dark|dark|pitch|no light|through clouds|cloud cover|cloudy|all-weather|all weather|day or night)\b/i },
    { intent: "port", modality: "SAR",
      re: /\b(port|ports|ship|ships|vessel|vessels|harbour|harbor|anchorage|anchored|cargo|container terminal|oil spill|radar target)\b/i },
    { intent: "change", modality: "Optical",
      re: /\b(chang\w*|differ\w*|compar\w*|before|after|growth|expand\w*|urbanis\w*|urbaniz\w*|new construction|since \d{4}|deforest\w*)\b/i },
    { intent: "description", modality: "Optical",
      re: /\b(describ\w*|land ?cover|land ?use|vegetation|forest|mangrove|crop\w*|agricultur\w*|what does .* look|looks? like|explain what|greenness|ndvi)\b/i },
  ];

  const META_RE = /\b(why|how (did|do|does) you|which layer|explain your|reason for|routing|rule)\b/i;

  function countMatches(text, words) {
    const hits = [];
    for (const w of words) {
      const re = new RegExp("(^|[^a-z0-9])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      if (re.test(text)) hits.push(w);
    }
    return hits;
  }

  /**
   * route(query) → decision
   * { intent, modality, insight, matched, confidence }
   */
  function route(query) {
    const q = String(query || "").trim();
    const lower = " " + q.toLowerCase() + " ";

    if (!q) return null;
    if (META_RE.test(q) && !INTENT_TESTS.some((t) => t.re.test(lower))) {
      return { intent: "meta", modality: null, insight: INSIGHTS.meta, matched: [], confidence: 1 };
    }

    for (const t of INTENT_TESTS) {
      if (t.re.test(lower)) {
        const insightKey =
          t.intent === "flood" ? "flood"
            : t.intent === "heat" ? "heat"
            : t.intent === "night" ? "night"
            : t.intent === "port" ? "port"
            : t.intent === "change" ? "change"
            : "description";
        return {
          intent: insightKey,
          modality: t.modality,
        insight: INSIGHTS[insightKey],
        matched: countMatches(lower, KEYWORDS[t.modality]),
        confidence: 0.9,
        };
      }
    }

    // generic keyword scoring
    const scores = {};
    const matched = {};
    for (const m of Object.keys(KEYWORDS)) {
      matched[m] = countMatches(lower, KEYWORDS[m]);
      scores[m] = matched[m].length;
    }
    const best = Object.keys(scores).reduce((a, b) => (scores[b] > scores[a] ? b : a), "Optical");
    const tie = Object.values(scores).filter((v) => v === scores[best]).length > 1;
    const modality = tie || scores[best] === 0 ? "Optical" : best;
    const insightKey = modality + "Default";
    return {
      intent: "default-" + modality.toLowerCase(),
      modality,
      insight: INSIGHTS[insightKey],
      matched: matched[modality],
      confidence: scores[best] === 0 ? 0.4 : Math.min(0.85, 0.5 + scores[best] * 0.1),
    };
  }

  global.SatQueryEngine = {
    route,
    COLORS,
    DATASETS,
    REGIONS,
    INSIGHTS,
    VERSION: "mvp-1",
  };
})(window);
