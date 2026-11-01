// Making a new instance, and making a new server.
//
// They are not the same question. An instance picks a mod loader; a server
// picks what it runs, and most servers run plugins, which have no client-side
// loader at all. And the blur over the page belongs to the flow -- leaving it
// behind when the flow ends is how the launcher ended up unusable until a
// reload.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "node_modules", ".cache", "ni");
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "server.css")}"></head><body>
<script>
  window.__loaderOffer = ["vanilla", "fabric", "neoforge"];
  window.require = () => ({ ipcRenderer: {
    on() {}, send() {},
    invoke: async (ch) => ch === "loader:supported"
      ? { success: true, offer: window.__loaderOffer } : null,
  } });
  // The flow reaches for these; none of them is what is under test here.
  window.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
  window.uiAlert = async () => {};
<\/script>
<script src="${path.join(FE, "modalfx.js")}"><\/script>
<script src="${path.join(FE, "newinstance.js")}"><\/script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "probe.html"), html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1100, height: 760 } })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.waitForTimeout(150);

const tiles = () => p.$$eval(".ni-tile .n", els => els.map(e => e.textContent));
const title = () => p.$eval(".ni-card h2", e => e.textContent);
// Each call uses a version of its own: which loaders a version supports is
// asked once and remembered, so reusing one would answer from the last call.
let nth = 0;
const openLoaderStep = (target, version) => p.evaluate(([t, v]) => {
  document.querySelectorAll(".ni-overlay, .ni-backdrop").forEach(x => x.remove());
  window.NewInstance.build({ target: t, onCreate() {}, onCustom() {} }, { supportedVersions: [v] });
}, [target, version || `1.21.${++nth}`]);

// ── an instance ──
await openLoaderStep("instance");
await p.waitForTimeout(400);
check("an instance is asked which mod loader", await title(), "Which mod loader?");
check("and offered the loaders that have a build for the version",
  await tiles(), ["Vanilla", "Fabric", "NeoForge"],
  "Forge and Quilt have no build for it, so they are not offered");
await p.screenshot({ path: path.join(OUT, "instance.png") });

// ── a server ──
await openLoaderStep("server");
await p.waitForTimeout(400);
check("a server is asked what KIND of server", await title(), "What kind of server?");
check("and offered the plugin kinds as well as the loaders",
  await tiles(), ["Vanilla", "Paper", "Purpur", "Folia", "Fabric", "NeoForge"],
  "most servers run plugins, and those were not offered at all");
await p.screenshot({ path: path.join(OUT, "server.png") });

// A version no mod loader supports still has servers to choose from.
await p.evaluate(() => { window.__loaderOffer = ["vanilla"]; });
await openLoaderStep("server");
await p.waitForTimeout(400);
check("a version no loader supports still offers the plugin kinds",
  await tiles(), ["Vanilla", "Paper", "Purpur", "Folia"],
  "the per-version list is about mod loaders, and must not take Paper away");
await p.evaluate(() => { window.__loaderOffer = ["vanilla", "fabric", "neoforge"]; });

// ── the blur ──
const blur = () => p.$$eval(".ni-backdrop", els => els.length);
await openLoaderStep("instance");
await p.waitForTimeout(350);
check("the flow puts a blur over the page", await blur(), 1);
await p.evaluate(() => window.NewInstance.closeAll());
await p.waitForTimeout(250);
check("and closing it takes the blur with it", await blur(), 0,
  "it stayed, which left the page blurred and unusable after making an instance or opening More settings");

// ── one step replacing another ──
await openLoaderStep("instance");
await p.waitForTimeout(350);
await p.evaluate(() => {
  // Going back a step: the loaders leave, the versions arrive.
  document.querySelector(".ni-back").click();
});
await p.waitForTimeout(60);
check("a step that is leaving is still on screen while the next arrives",
  await p.$$eval(".ni-overlay", els => [els.length, els.filter(e => e.dataset.rlmClosing).length]),
  [2, 1],
  "it used to be taken away first, leaving a blurred empty screen for the whole of the incoming animation");
check("but the one leaving cannot be clicked",
  await p.$eval(".ni-overlay[data-rlm-closing]", e => getComputedStyle(e).pointerEvents), "none");
await p.waitForTimeout(300);
check("and it is gone once it has gone", await p.$$eval(".ni-overlay", els => els.length), 1);

if (errors.length) { console.log("PAGE ERRORS:", errors.join(" | ")); bad += errors.length; }
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
