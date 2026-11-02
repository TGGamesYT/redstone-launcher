// The resource-pack tools: the totem generator and Vanilla Tweaks.
//
// What a tool makes should be visible before it is made, and what Vanilla
// Tweaks offers should be shown the way their own site shows it -- a name
// like "SolidHoney" or "StemToLog" says nothing, and every one of their packs
// has a picture of what it actually does.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "node_modules", ".cache", "packtools");
fs.mkdirSync(OUT, { recursive: true });
const src = fs.readFileSync(path.join(FE, "instances.html"), "utf8");

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

const styles = src.slice(src.indexOf("<style>"), src.indexOf("</style>") + 8);
const code = src.slice(
  src.indexOf("        // ── Resource-pack tools ──"),
  src.indexOf("        // ── Dev-mods modal: register mod build-output folders"));
if (!code.includes("openVanillaTweaksPicker")) { console.log("FAIL could not slice the pack tools out of instances.html"); process.exit(1); }

// Vanilla Tweaks' real shape: top categories, sub-categories, packs at both,
// and the two fields the cards are built from.
const CATS = [
  {
    category: "Aesthetic",
    categories: [{
      category: "More Zombies",
      warning: { text: "Although marked as <b>incompatible</b>, selecting all of them works with some mods." },
      packs: [{ name: "MZSteve", display: "Steve Zombies", description: "Retextures <b>Zombies</b>." }],
    }],
    packs: [{ name: "BetterBedrock", display: "Better Bedrock", previewExtension: "gif" }],
  },
  {
    category: "Terrain",
    packs: [
      { name: "AshDust", display: "Ash & Dust", incompatible: ["CleanerGlass"] },
      { name: "CleanerGlass", display: "Cleaner Glass" },
    ],
  },
  // Enough to run well off the bottom of the window, so "only what is on
  // screen" is a claim that can fail.
  {
    category: "Many",
    packs: Array.from({ length: 60 }, (_, i) => ({ name: `Filler${i}`, display: `Filler ${i}` })),
  },
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "server.css")}">
${styles}</head><body>
<script>
  window.__calls = []; window.__built = null; window.__totem = null;
  window.__generated = {}; window.__skins = []; window.__vtFails = false; window.__notes = [];
  window.DEFAULT_ICON = 'fallback.png';
  const CATS = ${JSON.stringify(CATS)};
  const ipcRenderer = {
    invoke: async (ch, arg) => {
      window.__calls.push([ch, arg]);
      if (ch === 'pack:generated') return { success: true, packs: window.__generated };
      if (ch === 'pack:skinChoices') return { success: true, account: { name: 'Me' }, skins: window.__skins };
      if (ch === 'pack:totemPreview') return { success: true, png: 'data:image/png;base64,PREVIEW' + (arg.skin.kind === 'fixed' ? arg.skin.base64.slice(-3) : 'ACC') };
      if (ch === 'pack:totem') { window.__totem = arg; return { success: true, file: 'redstone-totem.zip', png: 'data:image/png;base64,AAA' }; }
      if (ch === 'pack:forget') { window.__forgot = arg; return { success: true }; }
      if (ch === 'pack:vtCategories') {
        if (window.__vtFails) return { success: false, error: 'Vanilla Tweaks has nothing for 1.4' };
        return { success: true, version: String(arg.version || '').split('.').slice(0, 2).join('.'), categories: CATS };
      }
      if (ch === 'pack:vtBuild') { window.__built = arg; return { success: true, count: 3, version: '1.21' }; }
      return null;
    },
  };
  window.notify = (m, k) => window.__notes.push([m, k]);
<\/script>
<script>
  (function () {
${code}
    window.openPackToolsModal = openPackToolsModal;
    window.openVanillaTweaksPicker = openVanillaTweaksPicker;
  })();
<\/script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "probe.html"), html);

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 900, height: 900 } })).newPage();
// Their artwork, served locally: the point of these checks is which URL the
// page asks for and when, not whether the internet is reachable. Without it
// every icon fails to load and removes itself, which is right in the app and
// useless in a test.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const asked = [];
await p.route("**vanillatweaks.net/**", (route) => {
  asked.push(route.request().url());
  route.fulfill({ status: 200, contentType: "image/png", body: PIXEL });
});
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("file://" + path.join(OUT, "probe.html"));
await p.waitForTimeout(120);

const open = () => p.evaluate(() => {
  document.querySelectorAll('.modal-overlay').forEach(o => o.remove());
  window.__calls = []; window.__totem = null; window.__built = null; window.__notes = [];
  return window.openPackToolsModal({ id: 7, version: '1.21.4' }, () => { window.__changed = (window.__changed || 0) + 1; });
});

// ── the tools ──
await p.evaluate(() => { window.__generated = {}; });
await open();
await p.waitForTimeout(250);
check("both tools are offered",
  await p.$$eval(".pt-name", els => els.map(e => e.textContent)), ["Totem of Undying", "Vanilla Tweaks"]);
// The totem IS the tool, so the tool shows one the moment it is opened. This
// used to be an empty square until Generate was pressed, and empty again the
// next time the tools were opened.
check("the totem it would make is shown straight away, without generating anything",
  [await p.$eval("#ptTotemShot", e => e.src), await p.evaluate(() => window.__totem)],
  ["data:image/png;base64,PREVIEWACC", null]);
check("and Vanilla Tweaks has an icon of its own too",
  await p.$eval("#ptVtShot", e => e.src), "https://vanillatweaks.net/assets/images/logo.png");
await p.screenshot({ path: path.join(OUT, "tools.png") });

// ── pinning a skin redraws the preview ──
await p.evaluate(() => { window.__skins = [{ id: "a", name: "Builder", base64: "AAA" }, { id: "b", name: "Winter", base64: "BBB" }]; });
await p.click("#ptTotemPin");
await p.waitForTimeout(250);
await p.click(".pt-skin:nth-child(2)");
await p.waitForTimeout(200);
check("picking a skin redraws the preview from THAT skin",
  await p.$eval("#ptTotemShot", e => e.src), "data:image/png;base64,PREVIEWBBB");
await p.click("#ptTotemMake");
await p.waitForTimeout(250);
check("and generating pins it rather than following the account",
  await p.evaluate(() => [window.__totem.skin.kind, window.__totem.skin.base64]),
  ["fixed", "data:image/png;base64,BBB"]);

// ── what is already in ──
await p.evaluate(() => {
  window.__generated = {
    "redstone-totem.zip": { kind: "totem", follows: true },
    "redstone-vanillatweaks.zip": { kind: "vanillatweaks", version: "1.21", picks: { aesthetic: ["BetterBedrock"], terrain: ["AshDust"] } },
  };
});
await open();
await p.waitForTimeout(300);
check("the Vanilla Tweaks packs are counted",
  await p.$eval("#ptVtState", e => e.textContent), "In this instance: 2 packs for 1.21.");
check("and shown, as their own icons rather than only a number",
  await p.$$eval("#ptVtIcons img", els => els.map(e => e.src)),
  ["https://vanillatweaks.net/assets/resources/icons/resourcepacks/1.21/BetterBedrock.png?v1",
   "https://vanillatweaks.net/assets/resources/icons/resourcepacks/1.21/AshDust.png?v1"]);

// ── the picker ──
await p.evaluate(() => { window.__generated = {}; });
await open();
await p.waitForTimeout(220);
await p.click("#ptVtPick");
await p.waitForTimeout(350);
check("their categories are listed as they list them",
  await p.$$eval(".vt-group-name .nm", els => els.map(e => e.textContent)),
  ["Aesthetic", "Aesthetic · More Zombies", "Terrain", "Many"],
  "a sub-category is shown under the one it belongs to");
// Every category open at once is a wall of a few hundred cards.
check("a category is a header you open, and only the first starts open",
  await p.$$eval(".vt-group", els => els.map(e => e.classList.contains("open"))),
  [true, false, false, false]);
check("a closed category's cards are not on the page at all",
  await p.$$eval(".vt-group", els => els.slice(1).map(e => e.querySelector(".vt-body").offsetParent !== null)),
  [false, false, false],
  "which is also what stops their previews being fetched");
check("and the header says how many packs are in it",
  await p.$$eval(".vt-group-name .num", els => els.map(e => e.textContent)),
  ["1", "1", "2", "60"]);
// The rest of these are about the cards, so open the lot.
await p.evaluate(() => { for (const g of document.querySelectorAll(".vt-group")) g.classList.add("open"); });
await p.waitForTimeout(400);
check("with a card per pack, by its display name",
  await p.$$eval(".vt-tile .n", els => els.slice(0, 4).map(e => e.textContent)),
  ["Better Bedrock", "Steve Zombies", "Ash & Dust", "Cleaner Glass"]);
check("each carrying their picture of what the pack does",
  await p.$$eval(".vt-tile .bg", els => els.slice(0, 4).map(e => e.dataset.src)),
  ["https://vanillatweaks.net/assets/resources/previews/resourcepacks/1.21/BetterBedrock.gif?v2",
   "https://vanillatweaks.net/assets/resources/previews/resourcepacks/1.21/MZSteve.png?v2",
   "https://vanillatweaks.net/assets/resources/previews/resourcepacks/1.21/AshDust.png?v2",
   "https://vanillatweaks.net/assets/resources/previews/resourcepacks/1.21/CleanerGlass.png?v2"],
  "an animated one where they say it is animated, a still where they do not");
check("and its icon",
  await p.$eval(".vt-tile .ic", e => e.src),
  "https://vanillatweaks.net/assets/resources/icons/resourcepacks/1.21/BetterBedrock.png?v1");
// Hundreds of packs at a few hundred kilobytes each: fetching them all on
// open would be tens of megabytes before a single card is looked at.
const loaded = () => p.$$eval(".vt-tile .bg", els => els.filter(e => e.style.backgroundImage).length);
const cards = await p.$$eval(".vt-tile", els => els.length);
const onOpen = await loaded();
check("a picture is only fetched once its card comes into view",
  [cards > 50, onOpen > 0, onOpen < cards / 2], [true, true, true],
  `${onOpen} of ${cards} loaded — fetching them all would be tens of megabytes before a single card is looked at`);
await p.evaluate(() => { document.getElementById("vtList").scrollTop = 4000; });
await p.waitForTimeout(400);
check("and scrolling down fetches the ones that arrive", await loaded() > onOpen, true);
check("their own warning about a group is kept, as plain text",
  await p.$eval(".vt-warn", e => e.textContent),
  "Although marked as incompatible, selecting all of them works with some mods.");
check("a pack's description is plain text",
  await p.$$eval(".vt-tile .d", els => els.map(e => e.textContent).filter(Boolean)), ["Retextures Zombies."]);
await p.evaluate(() => { document.getElementById("vtList").scrollTop = 0; });
await p.waitForTimeout(200);
await p.screenshot({ path: path.join(OUT, "vt.png") });

// ── choosing ──
const clickPack = (name) => p.evaluate((n) => {
  [...document.querySelectorAll(".vt-tile")].find(t => t.textContent.includes(n)).click();
}, name);
await clickPack("Better Bedrock");
await p.waitForTimeout(80);
check("choosing one counts it and marks the card",
  [await p.$eval("#vtCount", e => e.textContent), await p.$$eval(".vt-tile.on .n", els => els.map(e => e.textContent))],
  ["1 pack chosen", ["Better Bedrock"]]);

await clickPack("Ash & Dust");
await clickPack("Cleaner Glass");
await p.waitForTimeout(80);
check("two packs they call incompatible are marked once both are on",
  await p.$$eval(".vt-tile.clash .n", els => els.map(e => e.textContent)), ["Ash & Dust", "Cleaner Glass"],
  "the warning is mutual even though only one of them lists the other");
check("the clash says what it is against",
  await p.evaluate(() => [...document.querySelectorAll(".vt-tile")].find(t => t.textContent.includes("Cleaner Glass")).title),
  "Vanilla Tweaks says this changes the same things as AshDust");
check("but neither is refused", await p.$eval("#vtCount", e => e.textContent), "3 packs chosen");
await clickPack("Ash & Dust");
await clickPack("Cleaner Glass");
await p.waitForTimeout(60);

// Searching, and a pack out of a SUB-category.
await p.evaluate(() => { const s = document.getElementById("vtSearch"); s.value = "glass"; s.dispatchEvent(new Event("input")); });
await p.waitForTimeout(100);
check("searching narrows to the matching packs",
  await p.$$eval(".vt-tile", els => els.filter(e => e.style.display !== "none").map(e => e.querySelector(".n").textContent)),
  ["Cleaner Glass"]);
check("and hides the groups with nothing left in them",
  await p.$$eval(".vt-group", els => els.filter(e => e.style.display !== "none").length), 1);
await p.evaluate(() => { const s = document.getElementById("vtSearch"); s.value = ""; s.dispatchEvent(new Event("input")); });
await p.waitForTimeout(80);
await clickPack("Steve Zombies");
await p.waitForTimeout(60);
await p.click("#vtOk");
await p.waitForTimeout(200);
check("what was chosen comes back, and is shown as icons there too",
  [await p.$eval("#ptVtState", e => e.textContent), await p.$$eval("#ptVtIcons img", els => els.map(e => e.alt))],
  ["2 packs chosen — press Generate.", ["BetterBedrock", "MZSteve"]]);

await p.click("#ptVtMake");
await p.waitForTimeout(250);
check("generating posts the picks keyed by the TOP category",
  await p.evaluate(() => [window.__built.profileId, window.__built.version, window.__built.picks]),
  [7, "1.21.4", { aesthetic: ["BetterBedrock", "MZSteve"] }],
  "a sub-category's pack goes under its top category, which is what their own site does");

// A version they have nothing for says so rather than failing silently.
await open();
await p.waitForTimeout(200);
await p.evaluate(() => { window.__vtFails = true; });
await p.click("#ptVtPick");
await p.waitForTimeout(300);
check("a version they do not cover is explained",
  await p.$eval("#vtList", e => e.textContent.includes("nothing for")), true);

if (errors.length) { console.log("PAGE ERRORS:", errors.join(" | ")); bad += errors.length; }
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
