// The shell, and the claim that nothing else changed.
//
// The launcher is one page now: a shell holding the title bar and the sidebar,
// with the page you are on in a frame beneath them. The requirement on that
// work was that every page comes out EXACTLY as it was, with only the bars no
// longer reloading -- so this compares each page FRAMED against the
// photographs of that same page standing on its own, taken before any of this
// existed (tests/baseline, written by pages-baseline.mjs).
//
// The two bars are the one allowed difference: a framed page hides its own,
// because the shell is drawing identical ones in exactly the same places.
// Everything else has to be in the same place to a tenth of a pixel, with the
// same computed styles -- which is only possible because the frame covers the
// whole window rather than the space left over, so a page is still laid out
// for a 38px title bar and a 70px sidebar. They are still there; the shell
// just owns them.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { FINGERPRINT, diffPrints, settled } from "./lib/pageprint.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const BASE = path.join(ROOT, "tests", "baseline");
const OUT = path.join(ROOT, "node_modules", ".cache", "shell");
fs.mkdirSync(OUT, { recursive: true });

const VIEW = { width: 1280, height: 800 };

// The pages you navigate to. The others are windows of their own -- the splash
// and the admin window -- and the shell does not frame them.
const VIEWS = [
  "index.html", "instances.html", "settings.html", "players.html",
  "server.html", "modrinth.html", "events.html", "profile-manager.html",
  "skin-editor.html", "modrinth_user.html",
];

// The page's own copies of the bars, which are hidden when framed. That IS the
// refactor, so they are the one thing not compared.
const CHROME = new Set(["#toolbar", "div.sidebar", "#instance-processes",
  "#backBtn", "#forwardBtn", "#min-btn", "#max-btn", "#close-btn",
  "#instances", "#update", "#updateText", "#players-login", "div.drag-region",
  "div.toolbar-buttons", "div.toolbar-buttons-left",
  // The running-instances pill's own stylesheet, injected by the code that
  // builds the pill -- which a framed page deliberately no longer runs,
  // because the pill belongs to the title bar and the title bar is the
  // shell's. The shell has it instead.
  "#ib-style",
  // The "add an instance" button, which lives IN the sidebar -- so inside the
  // hidden one it collapses to nothing, as it should.
  "#sidebar-add-instance"]);

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);

const STUB = fs.readFileSync(path.join(ROOT, "tests", "pages-baseline.mjs"), "utf8")
  .match(/const STUB = `([\s\S]*?)`;\n/)[1];

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: VIEW });
await page.addInitScript(STUB);     // applies to the shell AND the frame
const errors = [];
page.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

// A second tab, for photographing each page on its own RIGHT NOW rather than
// trusting a saved baseline. That is what lets this live in the ordinary test
// suite: a page being changed on purpose changes both sides of the comparison,
// so the only thing that can fail it is framing actually doing something.
const alone = await browser.newPage({ viewport: VIEW });
await alone.addInitScript(STUB);
alone.on("pageerror", (e) => errors.push(e.message.split("\n")[0]));

async function standalonePrint(file) {
  await alone.goto("file://" + path.join(FE, file), { waitUntil: "load" });
  try { await alone.evaluate(() => document.fonts && document.fonts.ready); } catch { /* no font API */ }
  return settled(alone);
}

await page.goto("file://" + path.join(FE, "shell.html"), { waitUntil: "load" });
await page.waitForTimeout(1200);

// ── the shell itself ──
const shape = await page.evaluate(() => {
  const frame = document.getElementById("view");
  const bar = document.getElementById("toolbar");
  const side = document.querySelector(".sidebar");
  const r = (el) => { const b = el.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
  const z = (el) => Number(getComputedStyle(el).zIndex) || 0;
  return {
    frame: r(frame), bar: r(bar), side: r(side),
    frameZ: z(frame), barZ: z(bar), sideZ: z(side),
    window: [window.innerWidth, window.innerHeight],
  };
});
check("the frame covers the whole window",
  [shape.frame, shape.window], [[0, 0, shape.window[0], shape.window[1]], shape.window],
  "not the space left over -- that is what keeps every page's own layout intact");
check("and the bars are drawn over it",
  [shape.barZ > shape.frameZ, shape.sideZ > shape.frameZ], [true, true]);
check("the title bar is where every page expects one",
  [shape.bar[1], shape.bar[3]], [0, 38]);
check("and the sidebar likewise",
  [shape.side[0], shape.side[2]], [0, 70]);

function check(label, got, want, note) {
  const good = JSON.stringify(got) === JSON.stringify(want);
  if (good) ok(label, note); else fail(label, `got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
}

// ── every page, framed, against itself standalone ──
async function frameTo(file) {
  await page.evaluate((f) => { document.getElementById("view").setAttribute("src", f); }, file);
  // Wait for the frame to be on that page and settled.
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    // Through Playwright's own frame list: a file:// frame is an opaque
    // origin, so the shell itself cannot read this and neither can a script
    // running in it.
    if (page.frames().some(f => f.url().endsWith("/" + file))) break;
  }
  const fr = page.frames().find(f => f.url().endsWith("/" + file));
  if (!fr) throw new Error("the frame never got there");
  return fr;
}

for (const file of VIEWS) {
  const name = file.replace(/\.html$/, "");
  let standalone;
  try { standalone = await standalonePrint(file); }
  catch (e) { fail(`${file} loads on its own`, e.message); continue; }

  let fr;
  try { fr = await frameTo(file); }
  catch (e) { fail(`${file} loads in the shell`, e.message); continue; }

  const framed = await settled(fr);

  // The page knows it is framed, and has put its own bars away.
  const hidden = await fr.evaluate(() => {
    const bar = document.querySelector("body > #toolbar");
    const side = document.querySelector("body > .sidebar");
    return {
      inShell: document.documentElement.classList.contains("in-shell"),
      bar: bar ? getComputedStyle(bar).display : "absent",
      side: side ? getComputedStyle(side).display : "absent",
    };
  });
  if (!hidden.inShell) fail(`${file} knows it is framed`, "the in-shell class is not set");
  if (!["none", "absent"].includes(hidden.bar) || !["none", "absent"].includes(hidden.side)) {
    fail(`${file} does not draw its own bars over the shell's`,
      `title bar: ${hidden.bar}, sidebar: ${hidden.side}`);
  }

  // Everything that is not a bar, in exactly the place it was.
  const strip = (p) => ({
    scroll: p.scroll,
    count: p.nodes.filter(n => !CHROME.has(n.key)).length,
    nodes: p.nodes.filter(n => !CHROME.has(n.key)),
  });
  const differences = diffPrints(strip(standalone), strip(framed));
  if (differences.length) {
    fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(framed, null, 1));
    fail(`${file} framed is identical to ${file} standalone`, differences.join("\n       "));
  } else {
    ok(`${file} framed is identical to ${file} standalone`,
      `${strip(framed).count} elements, all to the same tenth of a pixel`);
  }
}

// ── modals, and where they centre ──
//
// An overlay is fixed at top:38px left:70px with its contents centred, so a
// modal is centred in the area BETWEEN the bars rather than in the window.
// That is a thing worth checking rather than assuming: it is the most visible
// way this refactor could have gone subtly wrong, and it would have gone
// wrong if the frame had been given the space left over instead of the whole
// window -- the page would then have centred inside a box that was already
// inset, and every modal would sit low and to the right.
const measureModal = `(() => {
  const ov = document.querySelector(".modal-overlay, .modal-base");
  if (!ov) return null;
  const had = ov.className;
  ov.classList.add("active");
  // No animation, or the box is measured mid-fade.
  ov.style.animation = "none";
  const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
  const inner = ov.querySelector(".modal-content, .modal-inner");
  const out = {
    overlay: box(ov),
    content: inner ? box(inner) : null,
    justify: getComputedStyle(ov).justifyContent,
    align: getComputedStyle(ov).alignItems,
  };
  ov.className = had;
  ov.style.animation = "";
  return out;
})()`;

for (const file of ["server.html", "settings.html", "instances.html", "players.html"]) {
  await alone.goto("file://" + path.join(FE, file), { waitUntil: "load" });
  await settled(alone);
  const standalone = await alone.evaluate(measureModal);
  if (!standalone) { ok(`${file} has no modal in its markup to check`); continue; }

  const fr = await frameTo(file);
  await settled(fr);
  const framed = await fr.evaluate(measureModal);

  check(`a modal on ${file} is in exactly the same place framed`,
    framed, standalone,
    `centred at [${standalone.content || standalone.overlay}] in the area between the bars`);
  // And that it really is the content area, not the window.
  check(`and that area starts below the title bar and right of the sidebar`,
    [framed.overlay[0], framed.overlay[1]], [70, 38]);
}

// ── navigating ──
await frameTo("index.html");
const nav = await page.evaluate(async () => {
  const before = location.href;
  const link = document.querySelector('.sidebar a[href="settings.html"]');
  link.click();
  await new Promise(r => setTimeout(r, 1400));
  return {
    shellStayedPut: location.href === before,
    // What the frame was pointed at. Its own location is unreadable from
    // here -- opaque origin -- but the src attribute is the shell's own.
    framed: document.getElementById("view").getAttribute("src"),
  };
});
check("clicking a sidebar link moves the FRAME",
  nav.framed, "settings.html",
  "the point of the whole thing: the bars are not rebuilt");
check("and leaves the shell where it is",
  nav.shellStayedPut, true,
  "navigating the shell itself would take the bars with it");

const marked = await page.evaluate(() => {
  // The link may be the li's parent OR its child: the sidebar uses both
  // shapes, which is why the marking code looks in both directions too.
  return [...document.querySelectorAll(".sidebar li.current")].map((li) => {
    const a = li.closest("a[href]") || li.querySelector("a[href]");
    return a ? a.getAttribute("href") : (li.id || "?");
  });
});
check("the sidebar says which page is open", marked, ["settings.html"],
  "the shell's own URL never changes, so it cannot be worked out from that");

// The bars must be the SAME elements after navigating -- that is the whole
// point. A rebuilt bar would be a different node.
const persisted = await page.evaluate(async () => {
  const bar = document.getElementById("toolbar");
  bar.dataset.marked = "yes";
  document.getElementById("view").setAttribute("src", "instances.html");
  await new Promise(r => setTimeout(r, 1600));
  const after = document.getElementById("toolbar");
  return { same: after && after.dataset.marked === "yes" };
});
check("and the bars themselves are never rebuilt", persisted.same, true,
  "a mark put on the title bar survives navigating, because it is the same element");

// ── the loading screen, the notch, and the buttons ────────────────────────
//
// All three used to belong to the page, and all three were visibly wrong for
// it: the notch between the bars blinked out and back on every page change,
// the frame went blank before the new page had painted, and the loading
// screen only appeared once the page it belonged to had parsed -- so a page
// change was a flash of nothing followed by a loading screen that had
// nothing left to wait for.
await frameTo("index.html");

const loading = await page.evaluate(async () => {
  const ov = document.getElementById("shell-loading");
  const frame = document.getElementById("view");
  // Settled first: the page just framed raised it, like any other change.
  for (let i = 0; i < 80; i++) {
    if (!ov.classList.contains("on") && !ov.classList.contains("going")) break;
    await new Promise(r => setTimeout(r, 100));
  }
  const seen = { before: getComputedStyle(ov).display };
  document.querySelector('.sidebar a[href="players.html"]').click();
  await new Promise(r => requestAnimationFrame(r));
  const b = ov.getBoundingClientRect();
  seen.up = ov.classList.contains("on");
  seen.says = (ov.querySelector(".loading-subtext") || {}).textContent || "";
  seen.at = [Math.round(b.x), Math.round(b.y)];
  seen.overFrame = (Number(getComputedStyle(ov).zIndex) || 0) > (Number(getComputedStyle(frame).zIndex) || 0);
  // And down again once the page says it is ready, rather than on a timer.
  for (let i = 0; i < 80 && ov.classList.contains("on"); i++) await new Promise(r => setTimeout(r, 100));
  seen.down = !ov.classList.contains("on");
  return seen;
});
check("a page change shows the SHELL's loading screen",
  [loading.before, loading.up, loading.overFrame], ["none", true, true],
  "up the moment the change starts, so the frame is never seen empty");
check("and it covers the area between the bars", loading.at, [70, 38]);
check("and it says what it is opening", /^Opening /.test(loading.says), true, loading.says);
check("and the page itself takes it down when it is ready", loading.down, true,
  "the page's own loading screen is what hands over, so there is one of them, not two");

// The wedge joining the two bars. Only drawn over a background of the user's
// own -- the app's own panel makes it for free -- so the class that means
// that is set by hand here rather than by faking a whole settings object.
const notch = await page.evaluate(() => {
  document.documentElement.classList.add("custom-bg");
  const n = document.getElementById("shell-notch");
  const s = getComputedStyle(n);
  const b = n.getBoundingClientRect();
  return {
    display: s.display,
    at: [Math.round(b.x), Math.round(b.y)],
    overFrame: (Number(s.zIndex) || 0) > (Number(getComputedStyle(document.getElementById("view")).zIndex) || 0),
  };
});
const inFrame = await frameTo("players.html");
const pageNotch = await inFrame.evaluate(() => {
  document.documentElement.classList.add("custom-bg");
  return getComputedStyle(document.documentElement, "::before").display;
});
check("the notch between the bars is the shell's",
  [notch.display, notch.at, notch.overFrame], ["block", [70, 38], true],
  "drawn by the page it was thrown away and built again on every page change");
check("and a framed page does not draw its own", pageNotch, "none",
  "two of them, one of which blinked");

// The whole button, not the 24 pixels of icon in it.
await frameTo("index.html");
const spot = await page.evaluate(() => {
  const li = [...document.querySelectorAll(".sidebar li")]
    .find(l => l.querySelector('a[href="settings.html"]'));
  const b = li.getBoundingClientRect();
  const a = li.querySelector("a").getBoundingClientRect();
  // Below the icon, up the middle of the button. NOT a corner: the buttons
  // are as round as the corner-rounding setting makes them, and at the
  // default that is a circle -- a point five pixels into the corner of its
  // box is outside the button itself, which would be a test failing over
  // where it aimed rather than over what it is checking.
  const pt = [Math.round(b.x + b.width / 2), Math.round(b.bottom - 5)];
  return {
    pt,
    // The point really is outside the link, or this proves nothing.
    insideTheLink: pt[0] >= a.x && pt[0] <= a.right && pt[1] >= a.y && pt[1] <= a.bottom,
  };
});
check("the point clicked is in the button but NOT on its icon", spot.insideTheLink, false);
await page.mouse.click(spot.pt[0], spot.pt[1]);
await page.waitForTimeout(600);
check("clicking a sidebar button anywhere in it works",
  await page.evaluate(() => document.getElementById("view").getAttribute("src")), "settings.html",
  "Skins, Settings and the instance shortcuts have the link around the icon alone");

// Hovering the page you are already on has to do SOMETHING.
//
// The pointer is on that very button -- it was just clicked -- so it is moved
// off before the un-hovered look is read, or both reads are the hovered one.
await page.mouse.move(640, 500);
await page.waitForTimeout(400);
const hover = await page.evaluate(() => {
  const li = document.querySelector(".sidebar li.current");
  const s = getComputedStyle(li);
  return { bg: s.backgroundColor, shadow: s.boxShadow, bar: getComputedStyle(li, "::after").height };
});
await page.hover(".sidebar li.current");
await page.waitForTimeout(400);
const hovered = await page.evaluate(() => {
  const li = document.querySelector(".sidebar li.current");
  const s = getComputedStyle(li);
  return { bg: s.backgroundColor, shadow: s.boxShadow, bar: getComputedStyle(li, "::after").height };
});
check("the current page's button answers a hover",
  [hovered.bg !== hover.bg, hovered.shadow !== hover.shadow, hovered.bar !== hover.bar],
  [true, true, true],
  "it brightens, takes a ring, and its edge bar stretches -- it used to do none of it");

// The lit/unlit marker is on every button, so becoming the current one is
// something that can be watched rather than something the next page arrives
// already having done.
const litness = await page.evaluate(() => {
  const li = [...document.querySelectorAll(".sidebar li")].find(l => !l.classList.contains("current"));
  const s = getComputedStyle(li, "::after");
  const cur = getComputedStyle(document.querySelector(".sidebar li.current"), "::after");
  return { unlit: [s.content !== "none", s.opacity], lit: cur.opacity };
});
check("an unlit sidebar button has the marker, invisible",
  litness.unlit, [true, "0"]);
// The transition is read from the stylesheet rather than from the page: the
// stub these pages are photographed under turns transitions off, so that
// nothing is caught mid-fade, and a computed transition would say what the
// stub did rather than what the launcher does.
check("and it is something that happens over time rather than at once",
  /\.sidebar \.menu li::after \{[^}]*transition:[^}]*(opacity|transform)/s
    .test(fs.readFileSync(path.join(FE, "server.css"), "utf8")), true);
check("and the current one's is visible", litness.lit, "1");

// The instance shortcuts are not rebuilt when told the same thing twice.
//
// `profiles-updated` is broadcast for all sorts of reasons a page load sets
// off, and the list is built from scratch each time it arrives -- every icon
// a new <img>, so every icon blinks. That was invisible while the sidebar
// went away on a page change anyway. It does not any more.
const shortcuts = await page.evaluate(() => {
  const list = [{ id: "a", name: "One" }, { id: "b", name: "Two" }];
  renderInstances(list);
  const first = document.querySelector("#instances li");
  if (!first) return { built: false };
  first.dataset.mark = "yes";
  renderInstances(list.map(p => ({ ...p })));           // same thing, said again
  const kept = (document.querySelector("#instances li") || {}).dataset;
  renderInstances([{ id: "c", name: "Three" }]);        // actually different
  const after = (document.querySelector("#instances li") || {}).dataset;
  return { built: true, kept: kept && kept.mark === "yes", rebuilt: !(after && after.mark === "yes") };
});
check("the instance shortcuts are left alone when nothing about them changed",
  [shortcuts.built, shortcuts.kept, shortcuts.rebuilt], [true, true, true],
  "and still rebuilt when something does");

// A page that throws under these stubs throws standing on its own too -- the
// stubs are not the real main process. What matters is that framing one does
// not make it throw anything NEW, so the errors are checked against the ones
// recorded while photographing the pages standalone.
{
  const errPath = path.join(BASE, "errors.json");
  const known = fs.existsSync(errPath)
    ? JSON.parse(fs.readFileSync(errPath, "utf8")).map(e => e.replace(/^[^:]+: /, ""))
    : [];
  const unseen = [...new Set(errors)].filter(e => !known.includes(e));
  if (unseen.length) fail("framing a page makes it throw nothing new", unseen.join("\n       "));
  else ok("framing a page makes it throw nothing new",
    errors.length ? `${new Set(errors).size} seen, all of them thrown standalone too` : "nothing thrown at all");
}

await browser.close();
console.log(bad ? `\n${bad} FAILURES` : `\nall pass (${VIEWS.length} pages framed)`);
process.exit(bad ? 1 : 0);
