import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8175;
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, "scripts", "serve.mjs"), String(PORT)], { cwd: ROOT, stdio: "ignore" });
await sleep(700);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"], defaultViewport: { width: 1440, height: 1000 } });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e)));
let bad = 0;
page.on("response", async (r) => {
  if (r.status() >= 400 && bad < 1) {
    bad++;
    let body = "";
    try { body = (await r.text()).slice(0, 300); } catch {}
    console.log("HTTP", r.status(), r.url());
    console.log("BODY:", body);
  }
});

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
await sleep(2500);

await page.evaluate(() => {
  window.__ev = [];
  const c = document.getElementById("map");
  ["click", "dblclick", "mousedown", "mouseup"].forEach((t) =>
    c.addEventListener(t, (e) => window.__ev.push(t), true)
  );
});
const events = () => page.evaluate(() => window.__ev.splice(0).join(","));
const toastText = () => page.$eval("#mapToast", (n) => `${n.classList.contains("show") ? "[show] " : ""}${n.textContent}`).catch(() => "?");

const hint = async () => page.$eval(".draw-hint", (n) => `${n.classList.contains("show") ? "[show] " : "[hidden] "}${n.textContent}`).catch(() => "no-hint-el");

await page.click('[data-tool="poly"]');
console.log("after poly click:", await hint());

const box = await (await page.$("#map")).boundingBox();
console.log("map box:", JSON.stringify(box));

// what element is at the click point?
const at = await page.evaluate(([x, y]) => {
  const e = document.elementFromPoint(x, y);
  return e ? `${e.tagName}.${e.className}` : "none";
}, [box.x + 420, box.y + 160]);
console.log("element at click point:", at);

await page.mouse.click(box.x + 420, box.y + 160);
await sleep(300);
console.log("after 1st click:", await hint());
await page.mouse.click(box.x + 560, box.y + 220);
await page.mouse.click(box.x + 520, box.y + 360);
await sleep(300);
console.log("after 3rd click:", await hint());

const tmpPathCount = await page.$$eval(".leaflet-overlay-pane path", (n) => n.length);
console.log("overlay paths:", tmpPathCount);

console.log("events during 4 clicks:", await events());
await page.mouse.click(box.x + 400, box.y + 330, { clickCount: 2 });
await sleep(600);
console.log("events during dblclick:", await events());
console.log("toast:", await toastText());
console.log("finish btn visible:", await page.$eval(".draw-hint .finish-btn", (n) => !n.hidden && n.offsetParent !== null).catch(() => "no-btn"));
console.log("after dblclick:", await hint());
console.log("aoiMeta:", await page.$eval("#aoiMeta", (n) => n.textContent));
console.log("bounds:", await page.$eval("#factBounds", (n) => n.textContent));
console.log("area:", await page.$eval("#factArea", (n) => n.textContent));

await browser.close();
server.kill();
