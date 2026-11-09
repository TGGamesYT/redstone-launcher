// What every page looks like, so a refactor can prove it changed nothing.
//
// The launcher is being folded into one page: one shell with the title bar and
// the sidebar in it, and the content swapped underneath. The requirement on
// that work is that every page comes out EXACTLY as it was -- so the only
// honest way to do it is to photograph all of them first and compare
// afterwards, rather than clicking around and hoping.
//
//   node tests/pages-baseline.mjs --save     write the baselines
//   node tests/pages-baseline.mjs            compare against them
//
// Each page gets a screenshot and a fingerprint: the box of every element that
// has an id or looks like a container, and the computed values of the
// properties this refactor could plausibly disturb. The fingerprint is what
// actually catches things -- a screenshot tells you something moved, the
// fingerprint tells you what.
//
// Everything that would differ between two runs is frozen: the clock, the
// random greeting, and every answer the main process would give. A baseline
// that moves on its own is worse than none.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FINGERPRINT, diffPrints, settled } from "./lib/pageprint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const BASE = path.join(ROOT, "tests", "baseline");
const SHOTS = path.join(ROOT, "node_modules", ".cache", "pages");

const SAVE = process.argv.includes("--save");
const ONLY = (process.argv.find(a => a.startsWith("--only=")) || "").slice(7);

// 1280x800 is big enough that nothing is in its mobile arrangement and small
// enough to be quick.
const VIEW = { width: 1280, height: 800 };

// Pages that are a window of their own rather than somewhere you navigate to,
// so the single-page refactor does not touch them.
const NOT_VIEWS = new Set(["launch-splash.html", "admin.html", "adminpanel.html"]);

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);

fs.mkdirSync(BASE, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// Everything the page would ask the main process, answered the same way every
// time. Shapes rather than data: enough for a page to lay itself out.
const STUB = `
(() => {
  // A fixed clock and a fixed coin, so a greeting or a "2 minutes ago" is the
  // same in every run.
  const FIXED = new Date("2026-01-15T12:00:00Z").getTime();
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...a) { if (!a.length) { super(FIXED); } else { super(...a); } }
    static now() { return FIXED; }
  }
  globalThis.Date = FrozenDate;
  let seed = 42;
  Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  const SETTINGS = {
    baseColor: "#b30c0c", secondaryColor: "#ff4d4d", thirdColor: "#d92d2d",
    textColor: "#ffffff", font: "Pixel", fontSmoothing: "sharp", borderRadius: 0,
    autoThird: true, ramInstancesMin: 2048, ramInstancesMax: 4096,
    ramServersMin: 2048, ramServersMax: 4096,
    background: { mode: "theme", color: "#121212",
      gradient: { colors: ["#ff4d4d", "#b30c0c"], angle: 180 },
      image: { file: null, fit: "cover", followColors: false },
      block: { id: null, name: null, url: null, size: 64, scroll: false, followColors: false } },
    homeLayout: null, devMode: false, customCss: "",
  };
  try { localStorage.setItem("launcherTheme", JSON.stringify(SETTINGS)); } catch {}

  const answer = (channel) => {
    const c = String(channel);
    if (/settings/i.test(c) && !/save|set|update/i.test(c)) return SETTINGS;
    if (/^(get-|list-|.*:list$|.*-list$)/.test(c)) return [];
    if (/runs|instances|servers|profiles|accounts|skins|friends|packs|mods|items|entries|suggestions|themes/i.test(c)) return [];
    if (/^relay:(status)$/.test(c)) return { active: false };
    if (/^relay:(backend)$/.test(c)) return { setting: "auto", inUse: "own", e4mcAvailable: false };
    if (/adminInfo/i.test(c)) return { isAdmin: false };
    if (/available|enabled|has/i.test(c)) return false;
    return { success: true };
  };

  const ipcRenderer = {
    invoke: async (channel, arg) => answer(channel, arg),
    send() {}, on() {}, once() {}, off() {},
    removeAllListeners() {}, removeListener() {},
    sendSync: () => null,
  };
  const shell = { openExternal() {}, openPath() {}, showItemInFolder() {} };
  const clipboard = { writeText() {}, readText: () => "" };
  const electron = {
    ipcRenderer, shell, clipboard,
    app: { getPath: () => "/tmp", getName: () => "Redstone Launcher", getVersion: () => "1.18.0" },
    remote: {},
  };
  globalThis.require = (what) => {
    if (what === "electron") return electron;
    if (what === "path") return { join: (...p) => p.join("/"), basename: (p) => String(p).split("/").pop(), dirname: (p) => String(p).split("/").slice(0, -1).join("/"), extname: (p) => { const b = String(p).split("/").pop(); const i = b.lastIndexOf("."); return i < 0 ? "" : b.slice(i); }, sep: "/" };
    if (what === "fs") return { existsSync: () => false, readFileSync: () => "", writeFileSync() {}, readdirSync: () => [], mkdirSync() {}, statSync: () => ({ size: 0, isDirectory: () => false, isFile: () => true, mtimeMs: 0 }) };
    if (what === "os") return { homedir: () => "/home/test", platform: () => "linux", totalmem: () => 16 * 1024 ** 3 };
    return {};
  };
  // Nothing moves while it is being photographed.
  //
  // A CSS animation is not frozen by freezing the clock, so an element that
  // is always moving -- the splash screen's progress bar -- is in a different
  // place in every run, and the comparison fails for a reason that has
  // nothing to do with the code. Paused, every run catches it in the same
  // place. Transitions go too: a photograph taken mid-fade is of the fade.
  const hold = () => {
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after {'
      + ' animation-play-state: paused !important;'
      + ' transition: none !important; }';
    (document.head || document.documentElement).appendChild(style);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hold);
  else hold();

  globalThis.module = { exports: {} };
  globalThis.process = globalThis.process || { platform: "linux", versions: {}, env: {}, cwd: () => "/" };
})();
`;

/**
 * Where everything is and what it looks like.
 *
 * Only the properties a refactor like this could plausibly move: a page folded
 * into a shell can lose its own positioning context, inherit something it did
 * not before, or be laid out by a different box. Colour and font are in there
 * because a page's own <style> block applying to another page is exactly the
 * failure mode of putting them all in one document.
 */
async function capture(page, file) {
  await page.goto("file://" + path.join(FE, file), { waitUntil: "load" });
  // Let the page settle: fonts, the theme being applied, data-fit-height, and
  // whatever an inline script does on a timer.
  try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* no font API */ }
  // Read until it stops moving rather than after a guessed wait: these pages
  // fade an overlay out and fill a list in after load.
  const print = await settled(page);
  const shot = await page.screenshot({ fullPage: false, timeout: 15000 });
  return { print, shot };
}

const pages = fs.readdirSync(FE)
  .filter(f => f.endsWith(".html"))
  .filter(f => !ONLY || f === ONLY || f === ONLY + ".html")
  .sort();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
await page.addInitScript(STUB);
const errors = [];
page.on("pageerror", (e) => errors.push(`${page.url().split("/").pop()}: ${e.message.split("\n")[0]}`));

for (const file of pages) {
  const name = file.replace(/\.html$/, "");
  const printPath = path.join(BASE, `${name}.json`);
  const shotPath = path.join(BASE, `${name}.png`);
  let got;
  try { got = await capture(page, file); }
  catch (e) { fail(`${file} loads`, e.message); continue; }

  if (SAVE) {
    fs.writeFileSync(printPath, JSON.stringify(got.print, null, 1));
    fs.writeFileSync(shotPath, got.shot);
    ok(`${file} captured`, `${got.print.count} elements, ${got.print.scroll.join("x")}`
      + (NOT_VIEWS.has(file) ? " (a window of its own, not a view)" : ""));
    continue;
  }

  if (!fs.existsSync(printPath)) { fail(`${file} has a baseline`, "none saved; run with --save on the unrefactored tree"); continue; }
  const want = JSON.parse(fs.readFileSync(printPath, "utf8"));
  const differences = diffPrints(want, got.print);
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), got.shot);
  if (differences.length) {
    fail(`${file} is unchanged`, differences.join("\n       "));
    console.log(`       the new screenshot is at node_modules/.cache/pages/${name}.png`);
  } else {
    ok(`${file} is unchanged`, `${got.print.count} elements, all in the same place`);
  }
}

if (errors.length) {
  // A page that throws is not necessarily broken here -- the stubs are not the
  // real main process -- but it has to throw the SAME way before and after.
  const errPath = path.join(BASE, "errors.json");
  // One file for every page, so only a run of every page may write it.
  // `--save --only=settings` used to rewrite it with settings' one error
  // and throw the other five away, which then read as five pages that had
  // stopped throwing rather than as a baseline that had been truncated.
  if (SAVE && !ONLY) {
    fs.writeFileSync(errPath, JSON.stringify(errors.sort(), null, 1));
    ok("page errors recorded", `${errors.length} of them, which must not change`);
  } else if (SAVE) {
    ok("page errors left alone", `--only is one page; the list is for all of them`);
  } else if (fs.existsSync(errPath)) {
    const was = JSON.parse(fs.readFileSync(errPath, "utf8"));
    const now = errors.sort();
    const added = now.filter(e => !was.includes(e));
    if (added.length) fail("no page throws anything new", added.join("\n       "));
    else ok("no page throws anything new", `${now.length} known, same as before`);
  }
} else if (!SAVE && fs.existsSync(path.join(BASE, "errors.json"))) {
  ok("no page throws anything new", "and the ones that used to have stopped");
}

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : `\nall pass (${pages.length} pages)`);
process.exit(bad ? 1 : 0);
