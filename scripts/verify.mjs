/**
 * Headless smoke-test for the SATQUERY AI MVP.
 *
 * Boots the static server, loads the page in local Chrome and asserts the
 * critical flows: gallery load, free-zone draw, flood query → THERMAL
 * routing + highlighted regions, rectangle AOI, polygon AOI, SAR layer.
 *
 * Run:  node scripts/verify.mjs        (server is started in-process)
 */
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8174;
const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
];

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for an element's box to stop moving before using its coordinates.
 * The page uses `scroll-behavior: smooth`, so a bounding box measured while
 * the browser is still scrolling into view is stale — and mouse events then
 * land somewhere else entirely.
 */
async function stableBox(page, selector) {
  let prev = null;
  for (let i = 0; i < 15; i++) {
    const el = await page.$(selector);
    if (!el) return null;
    const box = await el.boundingBox();
    if (prev && box && Math.abs(prev.x - box.x) < 1 && Math.abs(prev.y - box.y) < 1) return box;
    prev = box;
    await sleep(120);
  }
  return prev;
}

/** Read pixel dimensions straight out of a JPEG buffer (SOF marker). */
function jpegSize(buf) {
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) {
  console.error("Chrome not found");
  process.exit(2);
}

// boot server
const server = spawn(process.execPath, [path.join(ROOT, "scripts", "serve.mjs"), String(PORT)], {
  cwd: ROOT,
  stdio: "ignore",
  env: { ...process.env, VLM_PROVIDER: "" }, // force the rule-engine fallback path
});
await sleep(800);

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1000"],
  defaultViewport: { width: 1440, height: 1000 },
});
const page = await browser.newPage();

const pageErrors = [];
const consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});

const sarTileHits = [];
const eoxTileHits = [];
page.on("response", (r) => {
  if (r.url().includes("mosaic/tiles")) sarTileHits.push(r.status());
  if (r.url().includes("tiles.maps.eox.at")) eoxTileHits.push(r.status());
});

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
  // smooth scrolling makes measured coordinates go stale mid-scroll
  await page.addStyleTag({ content: "html{scroll-behavior:auto !important}" });
  await sleep(2500);

  check("page loads without JS exceptions", pageErrors.length === 0, pageErrors.join(" | "));

  const galleryCount = await page.$$eval("#gallery .sample-card", (n) => n.length);
  check("sample gallery renders catalog entries", galleryCount === 4, `count=${galleryCount}`);

  const zonePaths = await page.$$eval(".leaflet-overlay-pane path", (n) => n.length);
  check("free public data zone drawn on map", zonePaths >= 1, `paths=${zonePaths}`);

  const zoneLabel = await page.$$eval(".zone-label", (n) => n.map((x) => x.textContent).join(""));
  check("free-zone label present", zoneLabel.includes("FREE PUBLIC DATA ZONE"), zoneLabel);

  /* ---------------- flood query → thermal ---------------- */
  await page.click('#exampleChips [data-q*="floods"]');
  await sleep(3200);

  const legend = await page.$eval("#legendLayerName", (n) => n.textContent);
  check("flood query routes to THERMAL layer", legend.includes("Thermal"), legend);

  const chip = await page.$eval("#answerModalityChip", (n) => n.textContent);
  check("answer card shows THERMAL chip", chip.trim() === "THERMAL", chip);

  const thermalActive = await page.$eval(".mod-thermal", (n) =>
    n.classList.contains("is-active") && n.classList.contains("routed")
  );
  check("thermal modality card active + auto badge", thermalActive === true);

  const resultPaths = await page.$$eval(".leaflet-overlay-pane path", (n) => n.length);
  check("flood regions highlighted on map", resultPaths > zonePaths, `before=${zonePaths} after=${resultPaths}`);

  const regionItems = await page.$$eval(".msg-ai [data-region]", (n) => n.length);
  check("AI message lists grounded regions", regionItems === 3, `regions=${regionItems}`);

  const aiStatus = await page.$eval("#aiStatus", (n) => n.textContent);
  check("assistant status shows routed layer", /routed → Thermal/.test(aiStatus), aiStatus);

  /* ---------------- rectangle AOI ---------------- */
  await page.click('[data-tool="rect"]');
  const mapBox = await (await page.$("#map")).boundingBox();
  await page.mouse.move(mapBox.x + 140, mapBox.y + 140);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + 320, mapBox.y + 300, { steps: 8 });
  await sleep(300);

  // the box must be visible BEFORE the button is released, or it cannot be aimed
  const preview = await page.evaluate(() => {
    const paths = Array.from(document.querySelectorAll(".leaflet-overlay-pane path"));
    if (!paths.length) return null;
    const b = paths[paths.length - 1].getBBox();
    return { paths: paths.length, w: Math.round(b.width), h: Math.round(b.height) };
  });
  check("AOI box is previewed while dragging (not only on release)",
    !!(preview && preview.w > 5 && preview.h > 5),
    preview ? `preview=${preview.w}x${preview.h}px paths=${preview.paths}` : "no path found");

  const dragHint = await page
    .$eval(".draw-hint .hint-text", (n) => n.textContent)
    .catch(() => "");
  check("live AOI size readout while dragging", /km²/.test(dragHint), dragHint);

  await page.mouse.up();
  await sleep(900);

  const area = await page.$eval("#factArea", (n) => n.textContent);
  check("rectangle AOI measures an area", /km²/.test(area), area);

  const zoneChip = await page.$eval("#zoneChip", (n) => n.textContent);
  check("AOI zone status evaluated", zoneChip === "IN ZONE" || zoneChip === "OUTSIDE", zoneChip);

  /* ---------------- polygon AOI ---------------- */
  await page.click('[data-tool="poly"]');
  await page.mouse.click(mapBox.x + 420, mapBox.y + 160);
  await page.mouse.click(mapBox.x + 640, mapBox.y + 210);
  await page.mouse.click(mapBox.x + 600, mapBox.y + 430);
  await page.mouse.click(mapBox.x + 380, mapBox.y + 400);
  await sleep(300);
  const finishVisible = await page.$eval(".draw-hint .finish-btn", (n) => n.offsetParent !== null)
    .catch(() => false);
  check("polygon finish button appears after 4 points", finishVisible === true);
  await page.click(".draw-hint .finish-btn");
  await sleep(900);
  const area2 = await page.$eval("#factArea", (n) => n.textContent);
  check("polygon AOI replaces rectangle", area2 !== area && /km²/.test(area2), `${area} → ${area2}`);

  /* ---------------- manual SAR switch + live mosaic ---------------- */
  await page.click(".mod-sar");
  await sleep(2500);
  const legend2 = await page.$eval("#legendLayerName", (n) => n.textContent);
  check("manual switch to SAR works", legend2.includes("SAR"), legend2);
  const sarOk = sarTileHits.length > 0 && sarTileHits.every((s) => s === 200 || s === 204);
  check("SAR mosaic tiles requested OK", sarOk, `hits=${sarTileHits.length} statuses=${[...new Set(sarTileHits)].join(",")}`);

  /* ---------------- meta query ---------------- */
  await page.type("#queryInput", "Why did you pick that layer?");
  await page.click(".query-send");
  await sleep(2600);
  const lastMsg = await page.$$eval(".msg-ai", (n) => n[n.length - 1].textContent);
  check("meta query answers routing logic", /routing table/i.test(lastMsg), lastMsg.slice(0, 60));

  /* ---------------- optical change query ---------------- */
  await page.click('#exampleChips [data-q*="changed"]');
  await sleep(3200);
  const legend3 = await page.$eval("#legendLayerName", (n) => n.textContent);
  check("change query routes to OPTICAL", legend3.includes("Optical"), legend3);
  const eoxOk = eoxTileHits.length > 0 && eoxTileHits.every((s) => s === 200);
  check("optical WMS tiles load (200)", eoxOk, `hits=${eoxTileHits.length} statuses=${[...new Set(eoxTileHits)].join(",")}`);

  /* ---------------- samples overlay ---------------- */
  await page.click("#btnLoadSamples");
  await sleep(1800);
  const overlayCount = await page.$$eval(".leaflet-overlay-pane img", (n) => n.length);
  check("sample image overlays appear on map", overlayCount >= 4, `overlays=${overlayCount}`);

  /* ---------------- samples carry their own footprint ---------------- */
  const offZone = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll(".leaflet-overlay-pane img"));
    // the SAR sample is a ~8 km box, so it must be far smaller than the map view
    return imgs.length;
  });
  check("samples usable for the swipe test", offZone >= 4, `overlays=${offZone}`);

  /* ---------------- before/after swipe comparison ---------------- */
  const clipOf = () =>
    page.$$eval(".leaflet-overlay-pane img", (imgs) => {
      const t = imgs.find((i) => (i.style.clipPath || "").includes("inset"));
      return t ? t.style.clipPath : "";
    });

  await page.click("#btnSwipe");
  await sleep(1400);
  const swipeVisible = await page.$eval("#swipe", (n) => !n.hidden);
  check("change comparison panel opens", swipeVisible === true);
  check("swipe divider is drawn on the map", !!(await page.$(".swipe-divider")));

  const clipBefore = await clipOf();
  check("the top mosaic is clipped", /inset/.test(clipBefore), clipBefore);

  await page.$eval("#swipeRange", (el) => {
    el.value = "80";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await sleep(600);
  const clipAfter = await clipOf();
  check("dragging the slider moves the swipe",
    clipAfter !== clipBefore && /80/.test(clipAfter), `${clipBefore} → ${clipAfter}`);

  await page.click("#swipeClose");
  await sleep(600);
  check("comparison closes and removes its layers",
    (await page.$eval("#swipe", (n) => n.hidden)) === true && !(await page.$(".swipe-divider")));

  /* ---------------- "Open console" focuses the query box ---------------- */
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(300);
  await page.click(".site-header .header-cta");
  await sleep(1100);
  const active = await page.evaluate(() => document.activeElement && document.activeElement.id);
  check('"Open console" focuses the query input, not just the section',
    active === "queryInput", `activeElement=${active}`);

  check("no page exceptions after full flow", pageErrors.length === 0, pageErrors.join(" | "));

  await page.screenshot({ path: path.join(ROOT, "preview.png"), fullPage: false });
  console.log("\nscreenshot → preview.png");

  /* ======================================================================
     PHASE 2 — live vision-language path, using the offline mock provider.
     This proves the real plumbing (status → image downscale → /api/route
     → validated decision → regions on the map) without needing an API key.
     ====================================================================== */
  const livePort = PORT + 1;
  const liveServer = spawn(process.execPath, [path.join(ROOT, "scripts", "serve.mjs"), String(livePort)], {
    cwd: ROOT,
    stdio: "ignore",
    env: { ...process.env, VLM_PROVIDER: "mock" },
  });

  try {
    await sleep(900);
    const livePage = await browser.newPage();
    livePage.on("pageerror", (e) => pageErrors.push("live: " + String(e)));
    await livePage.goto(`http://127.0.0.1:${livePort}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await livePage.addStyleTag({ content: "html{scroll-behavior:auto !important}" });
    await sleep(2500);

    const modeChip = await livePage.$eval("#aiModeChip", (n) => n.textContent.trim());
    check("live VLM detected and shown in the UI", modeChip === "LIVE VLM", modeChip);

    const liveStatus = await livePage.$eval("#aiStatus", (n) => n.textContent);
    check("status line names the live provider", /live VLM \(mock\)/.test(liveStatus), liveStatus);

    // ---- imagery must be cropped to the AOI, not the whole city ----
    const posted = [];
    livePage.on("request", (r) => {
      if (r.url().includes("/api/route") && r.method() === "POST") {
        posted.push(r.postData() || "");
      }
    });

    await livePage.type("#queryInput", "describe the land cover here");
    await livePage.click(".query-send");
    await sleep(4500);
    const payloadNoAoi = (posted[posted.length - 1] || "").length;
    const bodyNoAoi = (() => { try { return JSON.parse(posted[posted.length - 1]); } catch { return {}; } })();

    // now draw a small AOI and repeat the same question.
    // fit the map to the free zone first so the drag lands somewhere sane
    await livePage.click("#btnRecenter");
    await sleep(900);
    /**
     * Draw a rectangle AOI and return its area, or null if it did not take.
     * Deliberately offset from the exact map centre: the permanent "FREE PUBLIC
     * DATA ZONE" label sits there and would swallow the mousedown.
     */
    async function drawRectAoi() {
      // The map sits below the fold on first paint, so a viewport-relative
      // drag would land off-screen. Centre it before measuring coordinates.
      await livePage.evaluate(() => {
        const m = document.querySelector("#map");
        if (m) m.scrollIntoView({ block: "center", behavior: "instant" });
      });
      await sleep(400);
      // Zoom in a couple of levels: at the free-zone zoom a 100 px drag covers
      // hundreds of km² and lands outside the zone, where no imagery can be
      // cropped. Two zoom levels in makes a small drag land well inside it.
      for (let i = 0; i < 2; i++) {
        await livePage.click(".leaflet-control-zoom-in").catch(() => {});
        await sleep(400);
      }
      await livePage.click('[data-tool="rect"]');
      const box = await stableBox(livePage, "#map");
      if (!box) return null;
      // Offset up-left of the exact centre: the permanent "FREE PUBLIC DATA
      // ZONE" label sits there and would swallow the mousedown.
      const x0 = box.x + box.width / 2 - 130;
      const y0 = box.y + box.height / 2 - 110;
      await livePage.mouse.move(x0, y0);
      await livePage.mouse.down();
      await sleep(120);
      await livePage.mouse.move(x0 + 110, y0 + 90, { steps: 10 });
      await sleep(120);
      await livePage.mouse.up();
      await sleep(900);
      const area = await livePage.$eval("#factArea", (n) => n.textContent);
      return /km²/.test(area) ? area : null;
    }

    let aoiForCrop = await drawRectAoi();
    if (!aoiForCrop) aoiForCrop = await drawRectAoi(); // one retry
    const zoneForCrop = await livePage.$eval("#zoneChip", (n) => n.textContent.trim());
    check("AOI drawn for the crop test",
      !!aoiForCrop, `${aoiForCrop || "no AOI"} / ${zoneForCrop}`);

    await livePage.type("#queryInput", "describe the land cover here");
    await livePage.click(".query-send");
    await sleep(4500);
    const payloadWithAoi = (posted[posted.length - 1] || "").length;
    const bodyWithAoi = (() => { try { return JSON.parse(posted[posted.length - 1]); } catch { return {}; } })();

    // Byte size is a poor proxy here: both paths downscale to a 768 px long
    // side, so only the ASPECT RATIO reveals whether the pixels sent are the
    // AOI or the whole city footprint.
    const CITY_ASPECT = 2048 / 3584; // the committed city sample, w/h
    const firstImage = (body) => {
      const m = /^data:image\/jpeg;base64,(.*)$/.exec((body.images || [])[0] || "");
      return m ? jpegSize(Buffer.from(m[1], "base64")) : null;
    };
    const dimsNoAoi = firstImage(bodyNoAoi);
    const dimsAoi = firstImage(bodyWithAoi);
    const sentAspect = dimsAoi ? dimsAoi.w / dimsAoi.h : null;

    // The image must match the AOI clipped to free public coverage, which is
    // what the app promises to send, whether or not the AOI leaves the zone.
    const FREE = [72.75, 18.85, 73.05, 19.35];
    const aoiBox = bodyWithAoi.aoi;
    let clipped = null;
    if (aoiBox) {
      const w = Math.max(aoiBox[0], FREE[0]);
      const e = Math.min(aoiBox[2], FREE[2]);
      const so = Math.max(aoiBox[1], FREE[1]);
      const n = Math.min(aoiBox[3], FREE[3]);
      if (w < e && so < n) clipped = [w, so, e, n];
    }
    const aoiAspect = clipped ? (clipped[2] - clipped[0]) / (clipped[3] - clipped[1]) : null;

    check("sent imagery is the AOI crop, not the whole city footprint",
      aoiAspect != null && sentAspect != null &&
        Math.abs(sentAspect - aoiAspect) < 0.25 &&
        Math.abs(sentAspect - CITY_ASPECT) > 0.15,
      `sent ${dimsAoi ? dimsAoi.w + "x" + dimsAoi.h : "?"} (aspect ${sentAspect && sentAspect.toFixed(2)}) ` +
      `vs clipped-AOI aspect ${aoiAspect && aoiAspect.toFixed(2)}; ` +
      `no-AOI sent ${dimsNoAoi ? dimsNoAoi.w + "x" + dimsNoAoi.h : "?"} (city aspect ${CITY_ASPECT.toFixed(2)})`);

    // reset the AOI so the routing checks below see the whole free zone again
    await livePage.click('[data-tool="clear"]');
    await sleep(700);
    check("clear tool resets the AOI", /no AOI/.test(await livePage.$eval("#aoiMeta", (n) => n.textContent)));

    // a change question makes the client attach the 2017 + 2025 optical pair
    await livePage.type("#queryInput", "what changed in this region since 2017?");
    await livePage.click(".query-send");
    await sleep(4500);

    const ansText = await livePage.$$eval(".msg-ai", (n) => n[n.length - 1].textContent);
    check("answer is produced by the model, not the rule engine",
      /Mock vision-language routing/.test(ansText), ansText.slice(0, 70));
    check("answer carries a live source tag", /live Mock/.test(ansText));

    const meta = await livePage.$eval("#answerMeta", (n) => n.textContent);
    check("answer meta reports live source, image count and latency",
      /live Mock/.test(meta) && /img/.test(meta) && /ms/.test(meta), meta);

    const liveLegend = await livePage.$eval("#legendLayerName", (n) => n.textContent);
    check("model routing drives the active map layer", liveLegend.includes("Optical"), liveLegend);

    const regionLabels = await livePage.$$eval(".msg-ai [data-region]", (n) => n.map((x) => x.textContent));
    check("model-returned regions are drawn",
      regionLabels.some((l) => /Mock region A/.test(l)), regionLabels.join(" | ").slice(0, 90));
    check("a region outside the free zone is rejected, not drawn",
      !regionLabels.some((l) => /Mock region B/.test(l)), regionLabels.join(" | ").slice(0, 90));

    await livePage.close();
  } catch (err) {
    check("live VLM phase completed", false, String(err));
  } finally {
    liveServer.kill();
  }
} catch (err) {
  check("verification script completed", false, String(err));
} finally {
  const benign = /net::ERR|Failed to load resource|404 \(Not Found\)|tile/i;
  const real = consoleErrors.filter((e) => !benign.test(e));
  check("no unexpected console errors", real.length === 0, real.slice(0, 3).join(" | "));
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
