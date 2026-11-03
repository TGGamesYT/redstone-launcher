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
