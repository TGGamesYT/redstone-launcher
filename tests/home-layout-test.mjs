// The home page's layout.
//
// One grid for the whole page, and a segment is a rectangle in it: x and w
// across, y and h down. There are no rows and nothing is a container, which
// is what makes every one of these true -- a segment can be made taller
// without anything else moving, two can sit side by side at any heights at
// all, an edge stops where it meets something instead of shoving it, and a
// gap stays a gap.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");
const OUT = path.join(ROOT, "node_modules", ".cache", "home");
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};
const shot = async (p, name) => { try { await p.screenshot({ path: path.join(OUT, name), fullPage: false, timeout: 4000 }); } catch { /* fonts */ } };

// Segment types kept plain: what is under test is where they go, not what
// they draw. Each one simply writes its own name.
const TYPES = [
  { type: "greeting", name: "Greeting", options: [
    { id: "text", label: "What it says", kind: "text", default: "" },
    { id: "size", label: "Size", kind: "number", default: 32, min: 10, max: 90 },
    { id: "align", label: "Where", kind: "choice", default: "left",
      choices: [{ value: "left", label: "Left" }, { value: "center", label: "Middle" }] },
  ] },
  { type: "recent", name: "Instances", options: [
    { id: "title", label: "Heading", kind: "text", default: "Continue playing" },
    { id: "count", label: "How many", kind: "number", default: 6, min: 1, max: 24 },
    { id: "view", label: "Shown as", kind: "choice", default: "list",
      choices: [{ value: "list", label: "A list" }, { value: "grid", label: "Tiles" }] },
  ] },
  { type: "player", name: "Player", options: [
    { id: "movable", label: "Let it be turned", kind: "toggle", default: true },
  ] },
  { type: "projects", name: "Projects", options: [] },
];

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(FE, "server.css")}">
<!-- Laid out as the real page is: <body> insets the content on the left
     only, and the scroller adds more on that side again. -->
<style>body{margin:0;padding:0 0 0 20px;width:1000px;box-sizing:border-box;}</style></head><body>
<div class="main-scrolly" data-fit-height style="height:700px;"><div id="home-segments"></div></div>
<script>
  window.__layout = [];
  window.__saved = null;
  window.DEFAULT_ICON = "x.png";
  window.require = () => ({
    shell: { openExternal() {} },
    ipcRenderer: {
      on() {}, send() {},
      invoke: async (ch, arg) => {
        if (ch === "home:layout") return { success: true, types: ${JSON.stringify(TYPES)}, columns: 100, layout: window.__layout };
        if (ch === "home:setLayout") {
          window.__saved = arg.layout.map(x => ({ ...x }));
          return { success: true, layout: await window.__tidy(arg.layout) };
        }
        return null;
      },
    },
  });
<\/script>
<script src="${path.join(FE, "home.js")}"><\/script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "probe.html"), html);

// The REAL tidier out of the main process, so the page and the launcher
// agree about what a layout means.
const src = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const cut = (a, b) => {
  const i = src.indexOf(a), j = src.indexOf(b, i);
  if (i < 0 || j < 0) { console.log(`FAIL could not find ${JSON.stringify(i < 0 ? a : b)} in main.js`); process.exit(1); }
  return src.slice(i, j);
};
const backend = new Function(`
  const HOME_COLUMNS = 100, HOME_W_MIN = 12, HOME_W_DEFAULT = 100;
  const HOME_TYPES = [];
  const clampW = (v) => Math.max(HOME_W_MIN, Math.min(HOME_COLUMNS, Math.round(Number(v) || HOME_W_DEFAULT)));
  ${cut("// How tall a segment is, in grid rows.", "ipcMain.handle(\"home:layout\"")}
  return { tidyGrid, placeGrid, clampX, clampY, clampH, HOME_UNIT };
`)();
const UNIT = backend.HOME_UNIT;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1000, height: 760 } })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.exposeFunction("__tidy", (layout) => backend.tidyGrid(layout));
await p.waitForTimeout(100);

const set = async (layout) => {
  await p.evaluate((l) => { window.__layout = l.map(x => ({ ...x })); }, layout);
  await p.evaluate(() => window.Home.mount());
  await p.waitForTimeout(250);
};
// Where every segment actually is ON SCREEN, read back in grid units: the
// hundredths across, and the rows of UNIT pixels down. Measured rather than
// read off the styles, so what is checked is what is drawn.
const placed = (unit) => p.$$eval("#home-segments .hs", (els, u) => {
  // The grid's CONTENT box. The page carries its right-hand gutter as
  // padding on this element, so the element is two columns wider than the
  // columns in it.
  const el = document.getElementById("home-segments");
  const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const left = b.left + parseFloat(cs.paddingLeft);
  const top = b.top + parseFloat(cs.paddingTop);
  const width = b.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return els.map((e) => {
    const r = e.getBoundingClientRect();
    return {
      id: e.dataset.id,
      x: Math.round(((r.left - left) / width) * 100),
      y: Math.round((r.top - top) / u),
      w: Math.round((r.width / width) * 100),
      h: Math.round(r.height / u),
    };
  }).sort((a, b) => (a.y - b.y) || (a.x - b.x));
}, unit);
const layout = () => p.evaluate(() => window.__layout);
const saved = () => p.evaluate(() => window.__saved);

// ── a segment is a rectangle in one grid ──
await set([
  { id: "a", type: "greeting", x: 0, y: 0, w: 100, h: 3 },
  { id: "b", type: "recent", x: 0, y: 3, w: 58, h: 15 },
  { id: "c", type: "player", x: 58, y: 3, w: 42, h: 15 },
]);
check("there are no row containers left at all",
  await p.$$eval("#home-segments .hs-rowbox", (e) => e.length), 0,
  "a row was a box, and the box is what made a segment's height somebody else's business");
check("every segment sits exactly where it says it does", await placed(UNIT), [
  { id: "a", x: 0, y: 0, w: 100, h: 3 },
  { id: "b", x: 0, y: 3, w: 58, h: 15 },
  { id: "c", x: 58, y: 3, w: 42, h: 15 },
]);
await shot(p, "grid.png");

// ── side by side, at different heights ──
//
// THE thing rows made impossible, reported twice. A row was as tall as the
// tallest thing in it, so two segments beside each other were the same
// height whatever they said; making one taller made the row taller and
// pushed everything below it down the page. Nothing is worked out from
// anything else now, so these are simply three rectangles.
await set([
  { id: "tall", type: "player", x: 0, y: 0, w: 50, h: 18 },
  { id: "top", type: "greeting", x: 50, y: 0, w: 50, h: 7 },
  { id: "bot", type: "recent", x: 50, y: 7, w: 50, h: 11 },
]);
check("two segments can sit beside one that is taller than both of them",
  await placed(UNIT), [
    { id: "tall", x: 0, y: 0, w: 50, h: 18 },
    { id: "top", x: 50, y: 0, w: 50, h: 7 },
    { id: "bot", x: 50, y: 7, w: 50, h: 11 },
  ]);
const stack = await p.$$eval("#home-segments .hs", (els) => {
  const box = (id) => els.find(e => e.dataset.id === id).getBoundingClientRect();
  const t = box("top"), b = box("bot"), tall = box("tall");
  return {
    topIsAbove: Math.round(t.bottom) <= Math.round(b.top) + 1,
    theyMeet: Math.abs(t.bottom - b.top) < 2,
    together: Math.abs((b.bottom - t.top) - tall.height) < 2,
  };
});
check("one is drawn above the other, they meet, and together they are the tall one",
  stack, { topIsAbove: true, theyMeet: true, together: true });

// And that surviving a save.
check("it survives being saved",
  (await p.evaluate(() => window.__tidy([
    { id: "tall", type: "player", x: 0, y: 0, w: 50, h: 18 },
    { id: "top", type: "greeting", x: 50, y: 0, w: 50, h: 7 },
    { id: "bot", type: "recent", x: 50, y: 7, w: 50, h: 11 },
  ]))).map(s => [s.id, s.x, s.y, s.w, s.h]),
  [["tall", 0, 0, 50, 18], ["top", 50, 0, 50, 7], ["bot", 50, 7, 50, 11]]);

// Two on the same ground still cannot be, which only a layout edited by
// hand can ask for. The later one is moved straight down and nothing else
// is touched.
check("two on the same ground do not overlap",
  (await p.evaluate(() => window.__tidy([
    { id: "a", type: "greeting", x: 0, y: 0, w: 60, h: 6 },
    { id: "b", type: "recent", x: 30, y: 3, w: 60, h: 6 },
  ]))).map(s => [s.id, s.x, s.y]),
  [["a", 0, 0], ["b", 30, 6]]);

// ── a layout from when there were rows ──
//
// Every layout anybody has is one of these. Each old row becomes a band of
// grid rows as tall as the tallest thing in it, in order down the page, so
// a page comes forward looking as it did.
const brought = backend.placeGrid([
  { id: "a", type: "greeting", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "recent", row: 1, x: 0, w: 58, h: 220 },
  { id: "c", type: "player", row: 1, x: 58, w: 42, h: 0 },
]);
check("an old layout comes forward with its rows one under the other",
  brought.map(s => [s.id, s.x, s.y, s.w]),
  [["a", 0, 0, 100], ["b", 0, 3, 58], ["c", 58, 3, 42]],
  "a greeting is worth three rows and a row of instances ten, so the second band starts at 3");
check("and nothing is left of the row it was in",
  brought.every(s => !("row" in s) && !("vh" in s)), true);
const split = backend.placeGrid([
  { id: "tall", type: "player", row: 0, x: 0, w: 50, h: 0, y: 0, vh: 12 },
  { id: "top", type: "greeting", row: 0, x: 50, w: 50, h: 0, y: 0, vh: 6 },
  { id: "bot", type: "recent", row: 0, x: 50, w: 50, h: 0, y: 6, vh: 6 },
]);
check("a row that was divided up and down keeps its halves",
  split.map(s => [s.id, s.y, s.h]),
  [["tall", 0, 15], ["top", 0, 8], ["bot", 8, 8]],
  "the twelfths of a row become that share of the band the row became");

// ── going back ──
//
// Every change took effect and was saved at once with no way back from any
// of it: a segment dragged somewhere by accident had to be put back by hand.
await set([
  { id: "a", type: "greeting", x: 0, y: 0, w: 100, h: 6 },
  { id: "b", type: "recent", x: 0, y: 6, w: 100, h: 6 },
]);
await p.evaluate(() => window.Home.apply([
  { id: "a", type: "greeting", x: 0, y: 0, w: 40, h: 6 },
  { id: "b", type: "recent", x: 40, y: 0, w: 60, h: 6 },
]));
await p.waitForTimeout(150);
check("a change takes effect", (await placed(UNIT)).map(s => [s.id, s.x, s.y, s.w]),
  [["a", 0, 0, 40], ["b", 40, 0, 60]]);
await p.evaluate(() => window.Home.undo());
await p.waitForTimeout(200);
check("and can be undone", (await placed(UNIT)).map(s => [s.id, s.x, s.y, s.w]),
  [["a", 0, 0, 100], ["b", 0, 6, 100]]);
await p.evaluate(() => window.Home.redo());
await p.waitForTimeout(200);
check("and done again", (await placed(UNIT)).map(s => [s.id, s.x, s.y, s.w]),
  [["a", 0, 0, 40], ["b", 40, 0, 60]]);

// ── a gap stays a gap ──
//
// Nothing compacts. A page that quietly rearranges itself after every change
// is not a page anyone can lay out.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 30, h: 6 },
  { id: "b", type: "player", x: 60, y: 4, w: 40, h: 8 },
]);
check("a gap across and a gap down are both left alone", await placed(UNIT), [
  { id: "a", x: 0, y: 0, w: 30, h: 6 },
  { id: "b", x: 60, y: 4, w: 40, h: 8 },
], "nothing slides up against anything or closes up behind it");

// ── one segment's height is its own ──
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 50, h: 14 },
  { id: "b", type: "player", x: 50, y: 0, w: 50, h: 14 },
  { id: "c", type: "projects", x: 0, y: 14, w: 100, h: 10 },
]);
const before = await placed(UNIT);
await p.evaluate(() => window.Home.apply(window.__layout.map(s =>
  s.id === "a" ? { ...s, h: 6 } : { ...s })));
await p.waitForTimeout(200);
const after = await placed(UNIT);
check("making one segment shorter moves NOTHING else",
  after.filter(s => s.id !== "a"), before.filter(s => s.id !== "a"),
  "the row used to be as tall as its tallest, so this dragged the whole page up with it");
check("and the one that changed is the only one that did",
  after.find(s => s.id === "a").h, 6);

// ── the page's own margins ──
await set([{ id: "a", type: "greeting", row: 0, x: 0, w: 100, h: 0 }]);
const gutters = await p.evaluate(() => {
  // Measured from the window's edges, which is what anybody looking at it
  // sees -- not from inside whatever happens to be padding it.
  const seg = document.querySelector("#home-segments .hs");
  const r = seg.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(seg).paddingLeft);
  return [Math.round(r.left + pad), Math.round(window.innerWidth - (r.right - pad))];
});
check("the page has the same margin on both sides", gutters[0], gutters[1],
  `left ${gutters[0]}px, right ${gutters[1]}px — the scroller padded only the left, so there was a shelf between the sidebar and the content`);

// ── moving one ──────────────────────────────────────────────────────────
await p.evaluate(() => window.Home.setEditing ? window.Home.setEditing(true) : null);
const edit = async () => {
  await p.evaluate(() => {
    const bar = document.getElementById("home-edit");
    const b = bar && [...bar.querySelectorAll("button")].find(x => /edit/i.test(x.innerHTML) || x.textContent === "");
    if (b) b.click();
  });
  await p.waitForTimeout(200);
};
// Press and hold a segment, move to a point, let go.
//
// Taken by the middle of its top edge, which is clear of the handles in the
// corners -- so it keeps that grip as it moves and lands with its CENTRE
// where the pointer is, not a corner. Every expectation below is written
// from that: a segment w wide dropped at column c lands at c - w/2.
const dragTo = async (id, to) => {
  const from = await p.evaluate((i) => {
    const e = document.querySelector(`#home-segments .hs[data-id="${i}"]`).getBoundingClientRect();
    return { x: Math.round(e.left + e.width / 2), y: Math.round(e.top + 4) };
  }, id);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.waitForTimeout(260);           // past the hold
  await p.mouse.move(to.x, to.y, { steps: 8 });
  await p.waitForTimeout(140);
  return from;
};
// A point in the grid, at a given column and row.
const at = async (col, row) => p.evaluate(([c, r, u]) => {
  const el = document.getElementById("home-segments");
  const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const left = b.left + parseFloat(cs.paddingLeft);
  const width = b.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { x: Math.round(left + (width * c) / 100), y: Math.round(b.top + parseFloat(cs.paddingTop) + r * u) };
}, [col, row, UNIT]);

// ── moving one ──
//
// A drop used to mean one of five things, because where a segment could go
// was decided by the rows that happened to exist: a gap in a row, half of
// somebody's width, half of their height, a new row above, a new row below.
// It goes WHERE THE POINTER IS now, at the size it already is.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 40, h: 8 },
  { id: "b", type: "player", x: 0, y: 8, w: 30, h: 8 },
]);
await edit();
await dragTo("b", await at(75, 2));
check("the landing place is shown where it will land, at the size it is",
  await p.$$eval("#home-segments .hs-slot", (e) => e.map(x => ["x", "y", "w", "h"]
    .map(k => Number(x.style.getPropertyValue("--" + k))))),
  [[60, 2, 30, 8]],
  "and it is a rectangle in the same grid, not a line down somebody's side");
await p.mouse.up();
await p.waitForTimeout(300);
check("and it lands there", (await placed(UNIT)).find(s => s.id === "b"),
  { id: "b", x: 60, y: 2, w: 30, h: 8 });

// Onto something it cannot trade with -- `c` is standing where `a` would
// have to go -- so it takes the nearest clear space to where it was aimed.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 60, h: 8 },
  { id: "b", type: "player", x: 0, y: 10, w: 30, h: 6 },
  { id: "c", type: "clock", x: 40, y: 12, w: 40, h: 8 },
]);
await edit();
await dragTo("b", await at(20, 2));
await p.mouse.up();
await p.waitForTimeout(300);
check("dropped on top of something, it takes the nearest clear space instead",
  (await placed(UNIT)).find(s => s.id === "b"), { id: "b", x: 5, y: 8, w: 30, h: 6 },
  "straight down out of the way, which is nearer than right across the page");
check("and the one it was dropped on has not moved",
  (await placed(UNIT)).find(s => s.id === "a"), { id: "a", x: 0, y: 0, w: 60, h: 8 },
  "a drop used to halve the segment under the pointer and take half of it");

// Two the same size trade places, which is the one thing "drop it on that
// one" can mean that is not a guess.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 50, h: 8 },
  { id: "b", type: "player", x: 50, y: 0, w: 50, h: 8 },
]);
await edit();
await dragTo("b", await at(25, 4));
await p.mouse.up();
await p.waitForTimeout(300);
check("dropped squarely onto one it could trade with, they swap",
  (await placed(UNIT)).map(s => [s.id, s.x, s.y]).sort(),
  [["a", 50, 0], ["b", 0, 0]].sort(),
  "each one into the other\'s place exactly, not wherever the pointer was over it");

// And a swap trades their PLACES, not how big they are.
await set([
  { id: "big", type: "recent", x: 0, y: 0, w: 50, h: 14 },
  { id: "small", type: "player", x: 50, y: 0, w: 50, h: 5 },
]);
await edit();
await dragTo("small", await at(25, 7));
await p.mouse.up();
await p.waitForTimeout(300);
check("and they keep their own sizes through it",
  (await placed(UNIT)).map(s => [s.id, s.x, s.h]).sort(),
  [["big", 50, 14], ["small", 0, 5]].sort(),
  "the one standing still used to be given the mover\'s height as well as its place");

// ── resizing ────────────────────────────────────────────────────────────
const dragGrip = async (id, corner, dx, dy = 0) => {
  const g = await p.evaluate(([i, c]) => {
    const el = document.querySelector(`#home-segments .hs[data-id="${i}"] .hs-grip.${c}`);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, [id, corner]);
  await p.mouse.move(g.x, g.y);
  await p.mouse.down();
  await p.mouse.move(g.x + dx, g.y + dy, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(260);
};
const colPx = await p.evaluate(() => {
  const el = document.getElementById("home-segments"), cs = getComputedStyle(el);
  return (el.getBoundingClientRect().width
    - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 100;
});

// The left edge moves left, and the right edge stays put.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 40, h: 8 },
  { id: "b", type: "player", x: 60, y: 0, w: 40, h: 8 },
]);
await edit();
await dragGrip("b", "nw", Math.round(-10 * colPx));
check("dragging a left edge moves the LEFT edge",
  (await placed(UNIT)).find(s => s.id === "b"), { id: "b", x: 50, y: 0, w: 50, h: 8 },
  "it used to pin the segment to the left of the row and grow it the wrong way");

// And it stops where it meets its neighbour, rather than pushing it.
await dragGrip("b", "nw", Math.round(-30 * colPx));
check("an edge stops where it meets its neighbour",
  (await placed(UNIT)).find(s => s.id === "b"), { id: "b", x: 40, y: 0, w: 60, h: 8 });
check("and the neighbour is not moved or squeezed by it",
  (await placed(UNIT)).find(s => s.id === "a"), { id: "a", x: 0, y: 0, w: 40, h: 8 },
  "nothing on the page moves because something else was resized");

// Past a neighbour that is NOT level with it, because it is not in the way.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 40, h: 6 },
  { id: "b", type: "player", x: 60, y: 8, w: 40, h: 6 },
]);
await edit();
await dragGrip("b", "nw", Math.round(-55 * colPx));
check("an edge goes past something that is not level with it",
  (await placed(UNIT)).find(s => s.id === "b"), { id: "b", x: 5, y: 8, w: 95, h: 6 },
  "the one above is nowhere near this row of the page, so it is not in the way");

// ── UP AND DOWN, which is the half rows made impossible ──
//
// A row was a box as tall as what was in it. Dragging the bottom edge down
// made the BOX taller and shoved everything below it further down the page;
// dragging the top edge up had nowhere at all to go. What was there instead
// was a special gesture -- drag far enough past the end of the row and the
// row below is taken into this one -- which is the thing that was reported,
// twice, as still being a rowed system.
await set([
  { id: "tall", type: "player", x: 0, y: 2, w: 50, h: 6 },
  { id: "mate", type: "greeting", x: 50, y: 0, w: 50, h: 10 },
  { id: "under", type: "recent", x: 50, y: 10, w: 50, h: 6 },
]);
await edit();
await dragGrip("tall", "se", 0, 4 * UNIT);
check("dragging the bottom edge down simply makes it taller",
  (await placed(UNIT)).find(s => s.id === "tall"), { id: "tall", x: 0, y: 2, w: 50, h: 10 });
check("and nothing else on the page moves a pixel",
  (await placed(UNIT)).filter(s => s.id !== "tall"),
  [{ id: "mate", x: 50, y: 0, w: 50, h: 10 }, { id: "under", x: 50, y: 10, w: 50, h: 6 }],
  "this used to make the row taller and push the next one down the page");

await dragGrip("tall", "nw", 0, -2 * UNIT);
check("dragging the top edge UP makes it taller upwards",
  (await placed(UNIT)).find(s => s.id === "tall"), { id: "tall", x: 0, y: 0, w: 50, h: 12 },
  "the top edge used to have nowhere to go, because a row had no space above it");

// And it stops at what is above it rather than taking that row in.
await set([
  { id: "over", type: "greeting", x: 0, y: 0, w: 50, h: 4 },
  { id: "tall", type: "recent", x: 0, y: 8, w: 50, h: 6 },
]);
await edit();
await dragGrip("tall", "nw", 0, -8 * UNIT);
check("a top edge stops at what is above it",
  (await placed(UNIT)).find(s => s.id === "tall"), { id: "tall", x: 0, y: 4, w: 50, h: 10 });
check("and what was above it is exactly where it was",
  (await placed(UNIT)).find(s => s.id === "over"), { id: "over", x: 0, y: 0, w: 50, h: 4 },
  "the row above used to be swallowed into this one and divided in half");

// Down past the end of everything: the page simply grows.
await set([{ id: "a", type: "recent", x: 0, y: 0, w: 100, h: 6 }]);
await edit();
await dragGrip("a", "se", 0, 10 * UNIT);
check("the bottom edge has somewhere to go even at the end of the page",
  (await placed(UNIT)).find(s => s.id === "a").h, 16);

// Never shorter than the least a segment may be.
await dragGrip("a", "se", 0, -40 * UNIT);
check("and never shorter than a segment may be",
  (await placed(UNIT)).find(s => s.id === "a").h, 3);

// And the side NOT being dragged is left completely alone.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 30, h: 6 },
  { id: "b", type: "player", x: 30, y: 0, w: 30, h: 6 },
  { id: "c", type: "clock", x: 60, y: 0, w: 40, h: 6 },
]);
await edit();
await dragGrip("b", "ne", Math.round(20 * colPx));
check("dragging the right edge touches only this segment",
  await placed(UNIT),
  [{ id: "a", x: 0, y: 0, w: 30, h: 6 }, { id: "b", x: 30, y: 0, w: 30, h: 6 },
   { id: "c", x: 60, y: 0, w: 40, h: 6 }],
  "it meets the one on its right at once, and the one on the left must not move either way");

// The right edge of the last one reaches the edge of the page.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 30, h: 6 },
  { id: "b", type: "player", x: 30, y: 0, w: 40, h: 6 },
]);
await edit();
await dragGrip("b", "ne", Math.round(40 * colPx));
check("the last segment across can be taken out to the page's edge",
  (await placed(UNIT)).find(s => s.id === "b"), { id: "b", x: 30, y: 0, w: 70, h: 6 });

// ── after Done ──
await set([{ id: "a", type: "recent", x: 0, y: 0, w: 100, h: 6 }]);
await edit();
check("editing puts the handles on", await p.$$eval("#home-segments .hs-grip", (e) => e.length > 0), true);
await p.evaluate(() => {
  const bar = document.getElementById("home-edit");
  [...bar.querySelectorAll("button")].find(b => b.textContent === "Done").click();
});
await p.waitForTimeout(200);
check("Done takes them off", await p.$$eval("#home-segments .hs-grip, #home-segments .hs-tools", (e) => e.length), 0);
await dragTo("a", { x: 400, y: 400 });
await p.mouse.up();
await p.waitForTimeout(200);
check("and a segment cannot still be dragged after it",
  await p.$$eval("#home-segments .hs.dragging, .hs-slot", (e) => e.length), 0,
  "the hold listener was left on every segment, so they all still moved");

// ── what is inside a segment ────────────────────────────────────────────
// The inside-size setting is a multiplier on the contents and nothing else.
// It reached some segments and not others, and where it did reach, a wider
// segment made the contents jump smaller.
const sizeOf = (sel) => p.evaluate((q) => {
  const e = document.querySelector(q);
  return e ? Math.round(e.getBoundingClientRect().width) : null;
}, sel);

await set([{ id: "a", type: "projects", x: 0, y: 0, w: 50, h: 10, scale: 100 }]);
await p.evaluate(() => {
  // Stand-in contents of the shape the real segments build.
  const n = document.querySelector("#home-segments .hs");
  const g = document.createElement("div"); g.className = "hs-grid";
  for (let i = 0; i < 6; i++) { const c = document.createElement("div"); c.className = "hs-card"; g.appendChild(c); }
  n.appendChild(g);
});
const narrow = await sizeOf(".hs-card");
await p.evaluate(() => {
  const n = document.querySelector("#home-segments .hs");
  n.style.setProperty("--w", "100");
});
await p.waitForTimeout(80);
const wide = await sizeOf(".hs-card");
check("a card is the same size however wide its segment is", [narrow, wide], [narrow, narrow],
  "they used to grow until another column fitted and then snap smaller -- the contents randomly shrinking");

await p.evaluate(() => { document.querySelector("#home-segments .hs").style.setProperty("--s", "1.5"); });
await p.waitForTimeout(80);
const bigger = await sizeOf(".hs-card");
check("and the inside size is what changes it", bigger > wide * 1.3, true, `${wide}px to ${bigger}px`);

// The pieces the setting had not reached.
const css = await p.evaluate(() => document.getElementById("home-style").textContent);
for (const [what, rule] of [
  ["the news heading", /\.hs-news h4 \{[^}]*font-size:calc\(13px \* var\(--s\)\)/],
  ["the news picture", /\.hs-news img \{[^}]*height:calc\(120px \* var\(--s\)\)/],
  ["the small print under a number", /\.hs-sub \{ font-size:calc\(12px \* var\(--s\)\)/],
]) {
  check(`the inside size reaches ${what}`, rule.test(css), true);
}
const homeSrc = fs.readFileSync(path.join(FE, "home.js"), "utf8");
check("the player render is scaled by it too",
  /const scale = \(Number\(seg\.scale\)/.test(homeSrc) && /Number\(seg\.height\) \|\| 320\)\) \* scale/.test(homeSrc),
  true, "the setting did nothing here: the render was the height option and no more");

// Every segment's contents stay inside it.
check("nothing hangs over the edge of its segment",
  /\.hs > \* \{ max-width:100%; min-width:0; \}/.test(css), true,
  "the player render spilled over where the others were cut off, which looked like two rules because it was");

// ── what the drop preview shows ─────────────────────────────────────────
//
// Two the same size, one above the other, so dropping one on the other is a
// trade and there is something for the preview to act out.
const swapSet = async () => {
  await set([
    { id: "a", type: "recent", x: 0, y: 0, w: 100, h: 6 },
    { id: "b", type: "player", x: 0, y: 6, w: 100, h: 6 },
  ]);
  await edit();
  await dragTo("b", await at(50, 2));
};
await swapSet();
check("the landing place is a darkened area, not a coloured one",
  await p.evaluate(() => {
    const s = document.querySelector(".hs-slot");
    if (!s) return null;
    const cs = getComputedStyle(s);
    return [cs.backgroundColor, cs.outlineStyle, (s.dataset.what || "") === ""];
  }), ["rgba(0, 0, 0, 0.42)", "none", true],
  "a green box with a word on it is the launcher talking about itself");

// Nothing is acted out until you have settled on a place.
check("nothing moves the instant the pointer crosses something",
  await p.$$eval("#home-segments .hs.hs-would", (e) => e.length), 0);
await p.waitForTimeout(1100);
check("but holding still acts out what would happen",
  await p.$$eval("#home-segments .hs.hs-would", (e) => e.map(n => [n.dataset.id,
    Number(n.style.getPropertyValue("--y")), Number(n.style.getPropertyValue("--h"))])),
  [["a", 6, 6]],
  "the one being traded with slides to the place it would end up in");
check("at half strength, so it reads as a suggestion",
  await p.$eval("#home-segments .hs.hs-would", (e) => getComputedStyle(e).opacity), "0.5");

// Move on to empty ground, where nothing would have to move, and the one
// that was sliding goes back to where it really is.
const away = await at(50, 20);
await p.mouse.move(away.x, away.y, { steps: 4 });
await p.waitForTimeout(200);
check("moving on puts everything back",
  await p.$$eval("#home-segments .hs", (e) => e.map(n => [n.dataset.id,
    n.classList.contains("hs-would"), n.style.getPropertyValue("--y")])),
  [["a", false, "0"], ["b", false, "6"]]);
await p.mouse.up();
await p.waitForTimeout(300);

// And what it acted out is what happens.
await swapSet();
await p.waitForTimeout(1100);
const previewed = await p.$$eval("#home-segments .hs.hs-would", (e) => e.map(n => [n.dataset.id,
  Number(n.style.getPropertyValue("--x")), Number(n.style.getPropertyValue("--y"))]));
await p.mouse.up();
await p.waitForTimeout(350);
const landed = (await placed(UNIT)).filter(s => s.id !== "b").map(s => [s.id, s.x, s.y]);
check("and dropping does what was acted out", landed, previewed);

// No green anywhere in the page's own styles.
check("none of the moving markers are coloured",
  await p.evaluate(() => (document.getElementById("home-style").textContent.match(/5ad65a/g) || []).length), 1,
  "the one left is the dot on a friend who is online, which is not about moving anything");

// ── the settings of one segment ─────────────────────────────────────────
await set([
  { id: "g", type: "greeting", x: 0, y: 0, w: 100, h: 6, size: 32, align: "left", text: "" },
  { id: "r", type: "recent", x: 0, y: 6, w: 100, h: 9, title: "Continue playing", count: 6, view: "list", scale: 100 },
]);
await edit();
await p.evaluate(() => {
  document.querySelector('#home-segments .hs[data-id="r"] .hs-tools button').click();
});
await p.waitForTimeout(250);
check("a segment's settings open with what it is set to",
  await p.$$eval(".he-opt input, .he-opt select", (els) => els.map(e => e.type === "checkbox" ? e.checked : e.value)),
  ["Continue playing", "6", "list", "100", "9", "100", "stretch"],
  "its own options, then the width, height in rows, inside size and where its contents sit");

await p.evaluate(() => {
  const all = [...document.querySelectorAll(".he-opt input, .he-opt select")];
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input")); };
  set(all[0], "Jump back in");      // heading
  set(all[1], "3");                 // how many
  set(all[2], "grid");              // shown as
  set(all[3], "60");                // width
  set(all[5], "140");               // inside size
  [...document.querySelectorAll(".modal-overlay button")].find(b => b.textContent === "Done").click();
});
await p.waitForTimeout(400);
check("changing them changes the segment",
  await p.evaluate(() => {
    const s = window.__saved.find(x => x.id === "r");
    return [s.title, s.count, s.view, s.w, s.scale];
  }), ["Jump back in", 3, "grid", 60, 140],
  "and is stored, not only shown");
check("and the page shows it",
  await p.evaluate(() => {
    const n = document.querySelector('#home-segments .hs[data-id="r"]');
    return [Number(n.style.getPropertyValue("--w")), n.style.getPropertyValue("--s")];
  }), [60, "1.4"]);
check("a toggle reads and writes too", await (async () => {
  await p.evaluate(() => document.querySelector('#home-segments .hs[data-id="g"] .hs-tools button').click());
  await p.waitForTimeout(200);
  const before = await p.$$eval(".he-opt input, .he-opt select", (e) => e.length);
  await p.evaluate(() => {
    const all = [...document.querySelectorAll(".he-opt input, .he-opt select")];
    all[1].value = "48"; all[1].dispatchEvent(new Event("input"));
    all[2].value = "center"; all[2].dispatchEvent(new Event("change"));
    [...document.querySelectorAll(".modal-overlay button")].find(b => b.textContent === "Done").click();
  });
  await p.waitForTimeout(300);
  const g = await p.evaluate(() => window.__saved.find(x => x.id === "g"));
  return [before > 0, g.size, g.align];
})(), [true, 48, "center"]);

// ── what a redraw leaves alone ──────────────────────────────────────────
// Adding one segment used to reload every other one on the page: every
// clock restarted, every row of projects fetched again, for a change that
// touched none of them.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 50, h: 8 },
  { id: "b", type: "player", x: 50, y: 0, w: 50, h: 8 },
]);
await p.evaluate(() => {
  // A mark on each node, which only survives if the node itself does.
  document.querySelectorAll("#home-segments .hs").forEach((n, i) => { n.dataset.mark = "m" + i; });
});
// Added the way the page adds one: through the layout and a save.
await p.evaluate(async () => {
  const L = window.__layout;
  if (!L.some(x => x.id === "c")) L.push({ id: "c", type: "projects", x: 0, y: 8, w: 100, h: 8 });
  await window.Home.apply(L);
});
await p.waitForTimeout(300);
check("adding a segment leaves the ones already drawn alone",
  await p.$$eval("#home-segments .hs", (e) => e.map(n => n.dataset.mark || "new")),
  ["m0", "m1", "new"],
  "they were all torn down and drawn again for a change that touched none of them");

// Moving one does not redraw it either -- where it sits is not what it draws.
await p.evaluate(async () => {
  const L = window.__layout;
  L.find(x => x.id === "b").w = 30;
  await window.Home.apply(L);
});
await p.waitForTimeout(250);
check("and resizing one does not redraw anything",
  await p.$$eval("#home-segments .hs", (e) => e.map(n => n.dataset.mark || "new")),
  ["m0", "m1", "new"]);

// ── text and rounded corners ────────────────────────────────────────────
// The corner radius is a setting and can be large. With a fixed inset the
// curve reached the first letter of a heading and clipped it.
await set([{ id: "n", type: "projects", x: 0, y: 0, w: 60, h: 8 }]);
const insetAt = (radius) => p.evaluate((r) => {
  document.documentElement.style.setProperty("--border-radius", r + "px");
  const n = document.querySelector("#home-segments .hs");
  n.innerHTML = '<div class="hs-news"><div class="bd"><h4>Wednesday</h4></div></div>';
  const bd = n.querySelector(".bd");
  const cs = getComputedStyle(bd);
  return [parseFloat(cs.paddingLeft), parseFloat(cs.paddingTop)];
}, radius);
const small = await insetAt(0);
const large = await insetAt(40);
check("a small corner leaves the usual inset", small, [12, 10]);
check("and a large one pushes the text clear of the curve",
  [large[0] >= 30, large[1] >= 30], [true, true],
  `${large[0]}px across and ${large[1]}px down at a 40px radius — the curve cannot reach the text`);
await p.evaluate(() => document.documentElement.style.removeProperty("--border-radius"));

// ── a segment that fills the page does not make it scroll ──
//
// The room above the first row and below the last used to be padding on the
// content. Padding inside a scroll container is part of what scrolls, so a
// segment sized to exactly fill the visible area came out fifty-four pixels
// too tall: the page became scrollable and scrolling it showed nothing but
// that blank. The room is a transparent border on the scroller now, which is
// outside the padding box and never scrolls.
await set([{ id: "a", type: "recent", x: 0, y: 0, w: 100, h: 6 }]);
const fills = await p.evaluate(() => {
  const sc = document.querySelector("[data-fit-height]");
  const node = document.querySelector('#home-segments .hs[data-id="a"]');
  node.style.height = sc.clientHeight + "px";
  const cs = getComputedStyle(sc);
  return {
    overflow: sc.scrollHeight - sc.clientHeight,
    room: parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth),
  };
});
check("filling the visible area exactly leaves nothing to scroll", fills.overflow, 0,
  "padding on the content is part of what scrolls; a border is not");
check("and the breathing room is still there", fills.room > 0, true,
  `${fills.room}px of it, above and below`);
await set([{ id: "a", type: "recent", x: 0, y: 0, w: 100, h: 6 }]);

// ── what is inside a segment, up and down ──
//
// It matters more than it did: every segment has a height of its own now and
// most are taller than what is in them.
await set([
  { id: "a", type: "recent", x: 0, y: 0, w: 50, h: 14, valign: "bottom" },
]);
const inside = await p.evaluate(() => {
  const n = document.querySelector('#home-segments .hs[data-id="a"]');
  n.insertAdjacentHTML("beforeend", '<div class="hs-list" style="height:40px"></div>');
  const r = n.getBoundingClientRect(), k = n.lastElementChild.getBoundingClientRect();
  return { place: getComputedStyle(n).justifyContent, roomAbove: Math.round(k.top - r.top) };
});
check("a segment set to the bottom holds its contents at the bottom",
  [inside.place, inside.roomAbove > 100], ["flex-end", true],
  `${inside.roomAbove}px of room above them in a 14-row segment`);

// ── the player render, in a segment too narrow for it ──
//
// skinview3d writes the render's size onto the canvas as INLINE styles, so the
// stylesheet cannot set it: an inline height beats a rule, which is why
// capping the width with max-width squashed the width and left the height
// where it was. That is the stretching. Two things stop it -- the canvas does
// not flex, and what is drawn is letterboxed rather than scaled to the box --
// and the segment measures the room and tells the viewer, which is what keeps
// it sharp.
await set([{ id: "a", type: "player", x: 0, y: 0, w: 18, h: 14 }]);
const squash = await p.evaluate(() => {
  const n = document.querySelector('#home-segments .hs[data-id="a"]');
  n.innerHTML = "";
  const box = document.createElement("div");
  box.className = "hs-player";
  box.style.flexDirection = "column";
  box.style.alignItems = "center";
  const c = document.createElement("canvas");
  // Exactly what skinview3d does: the bitmap, and the size, written inline.
  c.width = 192; c.height = 320;
  c.style.width = "192px";
  c.style.height = "320px";
  box.appendChild(c);
  n.appendChild(box);
  const cs = getComputedStyle(c);
  const r = c.getBoundingClientRect();
  return {
    shrink: cs.flexShrink,
    fit: cs.objectFit,
    width: Math.round(r.width),
    height: Math.round(r.height),
    room: Math.round(n.getBoundingClientRect().width),
  };
});
check("the canvas is not squashed along the column it sits in",
  squash.shrink, "0",
  "a flex column shrinks a too-tall item's HEIGHT and leaves its width, which is a stretch");
check("and what is drawn keeps its proportions when the box is capped",
  squash.fit, "contain",
  `the box came out ${squash.width}x${squash.height} in ${squash.room}px of room`);
check("the box is held inside the segment rather than spilling out of it",
  squash.width <= squash.room, true);

if (errors.length) { console.log("PAGE ERRORS:", errors.join(" | ")); bad += errors.length; }
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
