// What the launcher's background is made of, and whether it travels with the
// page when it is asked to.
//
// The scrolling half is the whole point of this file: the toggle existed and
// did nothing on any page, because of where the background was painted rather
// than what it was set to. So the check is a real scroll in a real browser,
// not the value of a CSS property.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "node_modules", ".cache", "bg");
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

// A page shaped like the launcher's: a body that does not scroll, and the
// scrolling happening inside a container the way every page here does it.
const page = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "server.css")}">
</head><body>
<div id="scroller" data-fit-height style="height:300px; overflow-y:auto;">
  <div style="height:3000px;"></div>
</div>
<script>
  // sidebar.js is written for a page that already has these.
  window.ipcRenderer = { on() {}, send() {}, invoke: async () => null };
  window.require = () => ({ ipcRenderer: window.ipcRenderer });
<\/script>
<script src="${path.join(FE, "sidebar.js")}"></script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "probe.html"), page);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 700, height: 400 } })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.waitForTimeout(150);

const BLOCK = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
// A 2x2 tile with one bright corner, so moving it is plain to see.
const TILE = "data:image/gif;base64,R0lGODlhAgACAPAAAP9QUBQUFCH5BAAAAAAALAAAAAACAAIAAAIDRAJZADs=";

const apply = (block) => p.evaluate((b) => {
  window.LauncherBackground.apply({ background: { mode: "block", block: b } });
}, block);

// ── where the wall is painted ──
await apply({ url: BLOCK, size: 64, scroll: false });
check("held still, the wall is on the page itself",
  await p.evaluate(() => [
    document.documentElement.classList.contains("custom-bg"),
    document.documentElement.classList.contains("bg-scrolls"),
    getComputedStyle(document.documentElement).backgroundImage !== "none",
  ]), [true, false, true]);

await apply({ url: BLOCK, size: 64, scroll: true });
check("asked to travel, it moves onto what actually scrolls",
  await p.evaluate(() => [
    document.documentElement.classList.contains("bg-scrolls"),
    getComputedStyle(document.documentElement).backgroundImage !== "none",
    getComputedStyle(document.getElementById("scroller")).backgroundImage !== "none",
    getComputedStyle(document.getElementById("scroller")).backgroundAttachment,
  ]), [true, false, true, "local"],
  "<html>'s background belongs to the canvas, and the canvas never scrolls here");

// ── and it really does move ──
// Not by reading a property back, but by looking: the wall is a tile with one
// bright corner, and scrolling has to move where that corner lands.
const shot = async (name) => {
  const box = await p.$("#scroller");
  const file = path.join(OUT, name + ".png");
  await box.screenshot({ path: file });
  return fs.readFileSync(file);
};
const scrollTo = async (y) => {
  await p.evaluate((v) => { document.getElementById("scroller").scrollTop = v; }, y);
  await p.waitForTimeout(120);
};
// A change now fades, so a screenshot taken straight after one catches the
// fade halfway and nothing can be compared.
const settled = () => p.waitForTimeout(500);

await apply({ url: TILE, size: 64, scroll: true });
await settled();
await scrollTo(0);
const movingTop = await shot("moving-top");
await scrollTo(96);                       // not a whole number of tiles
const movingDown = await shot("moving-down");
check("so scrolling the page really does carry the wall with it",
  Buffer.compare(movingTop, movingDown) !== 0, true,
  "the tiles have to land somewhere else than they did");

await apply({ url: TILE, size: 64, scroll: false });
await settled();
await scrollTo(0);
const stillTop = await shot("still-top");
await scrollTo(96);
const stillDown = await shot("still-down");
check("and held still it stays exactly where it was",
  Buffer.compare(stillTop, stillDown), 0);



// ── changing it fades ──
// A background-image cannot be transitioned, so the one leaving is held on a
// layer of its own and faded out over the one arriving. Without it a change
// was a hard cut.
await apply({ url: TILE, size: 64, scroll: false });
await p.waitForTimeout(400);
await p.evaluate(() => {
  window.LauncherBackground.apply({ background: { mode: "color", color: "#101820" } });
});
check("the one leaving is held at full strength for a frame",
  await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement, "::after");
    return [document.documentElement.classList.contains("bg-changing"), cs.opacity];
  }), [true, "1"]);
check("and it is the OLD background on that layer, not the new one",
  await p.evaluate(() => getComputedStyle(document.documentElement, "::after").backgroundImage.startsWith("url(")), true);
await p.waitForTimeout(500);
check("then it fades away, leaving the new one",
  await p.evaluate(() => {
    const cs = getComputedStyle(document.documentElement, "::after");
    return [document.documentElement.classList.contains("bg-changing"), cs.opacity];
  }), [false, "0"]);
check("and the layer is never in the way of a click",
  await p.evaluate(() => getComputedStyle(document.documentElement, "::after").pointerEvents), "none");

// ── the other modes still work ──
const css = (bg) => p.evaluate((b) => {
  const c = window.LauncherBackground.css(b);
  return c && { image: c.image.slice(0, 32), color: c.color, attach: c.attach };
}, bg);
check("a flat colour is a colour, not an image",
  await css({ mode: "color", color: "#101820" }), { image: "none", color: "#101820", attach: "fixed" });
check("a gradient is an image",
  (await css({ mode: "gradient", gradient: { colors: ["#111", "#222"], angle: 45 } })).image.startsWith("linear-gradient"), true);
check("and the app's own panel asks for no background at all",
  await css({ mode: "theme" }), null);

// sidebar.js wires up a whole page's worth of buttons; this probe has none
// of them, and its complaints about that are not what is under test here.
const mine = errors.filter((e) => !/setting '(onclick|src|textContent)'|is not defined/.test(e));
if (mine.length) { console.log("PAGE ERRORS:", mine.join(" | ")); bad += mine.length; }
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
