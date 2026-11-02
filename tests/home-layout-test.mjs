// The home page's layout.
//
// A row is a row now, rather than something that fell out of the widths.
// That one change is what makes a gap in a row possible, keeps one row's
// size from disturbing the next, lets a segment be dropped into empty space
// or between two rows, and lets a left edge be dragged left.
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
  const clampW = (v) => Math.max(HOME_W_MIN, Math.min(HOME_COLUMNS, Math.round(Number(v) || HOME_W_DEFAULT)));
  ${cut("const clampRow =", "ipcMain.handle(\"home:layout\"")}
  return { tidyRows, placeRows, clampX, clampRow };
`)();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox"] });
const p = await (await browser.newContext({ viewport: { width: 1000, height: 760 } })).newPage();
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
await p.goto("file://" + path.join(OUT, "probe.html"), { waitUntil: "domcontentloaded" });
await p.exposeFunction("__tidy", (layout) => backend.tidyRows(layout));
await p.waitForTimeout(100);

const set = async (layout) => {
  await p.evaluate((l) => { window.__layout = l.map(x => ({ ...x })); }, layout);
  await p.evaluate(() => window.Home.mount());
  await p.waitForTimeout(250);
};
// Where every segment actually is on screen, in columns of the row it is in.
const placed = () => p.$$eval("#home-segments .hs", (els) => els.map((e) => {
  const box = e.parentElement.getBoundingClientRect();
  const r = e.getBoundingClientRect();
  return {
    id: e.dataset.id,
    row: Number(e.parentElement.dataset.row),
    x: Math.round(((r.left - box.left) / box.width) * 100),
    w: Math.round((r.width / box.width) * 100),
  };
}));
const layout = () => p.evaluate(() => window.__layout);
const saved = () => p.evaluate(() => window.__saved);

// ── rows are real ──
await set([
  { id: "a", type: "greeting", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "recent", row: 1, x: 0, w: 58, h: 0 },
  { id: "c", type: "player", row: 1, x: 58, w: 42, h: 0 },
]);
check("each row is drawn as a row of its own",
  await p.$$eval("#home-segments .hs-rowbox", (e) => e.length), 2);
check("and every segment sits where it says it does", await placed(), [
  { id: "a", row: 0, x: 0, w: 100 },
  { id: "b", row: 1, x: 0, w: 58 },
  { id: "c", row: 1, x: 58, w: 42 },
]);
await shot(p, "rows.png");

// ── a gap in a row ──
// Impossible before: the segments were laid end to end and a row was just
// where they happened to wrap.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 30, h: 0 },
  { id: "b", type: "player", row: 0, x: 60, w: 40, h: 0 },
]);
check("a row can have a gap in it", await placed(), [
  { id: "a", row: 0, x: 0, w: 30 },
  { id: "b", row: 0, x: 60, w: 40 },
], "the second one stays where it was put, rather than sliding up against the first");

// ── one row's height is its own ──
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 50, h: 300 },
  { id: "b", type: "player", row: 0, x: 50, w: 50, h: 300 },
  { id: "c", type: "projects", row: 1, x: 0, w: 100, h: 0 },
]);
const tops = await p.$$eval("#home-segments .hs-rowbox", (e) => e.map(b => Math.round(b.getBoundingClientRect().top)));
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 50, h: 120 },
  { id: "b", type: "player", row: 0, x: 50, w: 50, h: 120 },
  { id: "c", type: "projects", row: 1, x: 0, w: 100, h: 0 },
]);
const after = await p.$$eval("#home-segments .hs-rowbox", (e) => e.map(b => Math.round(b.getBoundingClientRect().top)));
check("shrinking a row moves the next one UP, not into it",
  [after[0] === tops[0], after[1] < tops[1], (await placed()).filter(s => s.row === 1).length], [true, true, 1],
  "the next row used to curl up into the one above as the wrapping re-flowed");

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
const dragTo = async (id, to) => {
  const from = await p.evaluate((i) => {
    const e = document.querySelector(`#home-segments .hs[data-id="${i}"]`).getBoundingClientRect();
    return { x: Math.round(e.left + e.width / 2), y: Math.round(e.top + 20) };
  }, id);
  await p.mouse.move(from.x, from.y);
  await p.mouse.down();
  await p.waitForTimeout(260);           // past the hold
  await p.mouse.move(to.x, to.y, { steps: 8 });
  await p.waitForTimeout(140);
  return from;
};
// A point inside a row, at a given column.
const at = async (row, col, dy = 0) => p.evaluate(([r, c, d]) => {
  const box = [...document.querySelectorAll("#home-segments .hs-rowbox")].find(b => Number(b.dataset.row) === r);
  const g = box.getBoundingClientRect();
  return { x: Math.round(g.left + (g.width * c) / 100), y: Math.round(g.top + g.height / 2 + d) };
}, [row, col, dy]);

// Into empty space, which was not possible at all before.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 40, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 30, h: 0 },
]);
await edit();
await dragTo("b", await at(0, 75));
check("dropping into empty space shows where it will land",
  await p.$$eval("#home-segments .hs-slot", (e) => e.map(x => [Number(x.style.getPropertyValue("--x")), Number(x.style.getPropertyValue("--w"))])),
  [[60, 30]], "a line down somebody's side was all there was, and empty space was not a target");
await p.mouse.up();
await p.waitForTimeout(300);
check("and it lands there", (await placed()).find(s => s.id === "b"), { id: "b", row: 0, x: 60, w: 30 });

// A big one into a small space: narrowed to fit rather than ignored.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 75, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 80, h: 0 },
]);
await edit();
await dragTo("b", await at(0, 88));
await p.mouse.up();
await p.waitForTimeout(300);
check("a big segment dropped into a small space shrinks to fit",
  (await placed()).find(s => s.id === "b"), { id: "b", row: 0, x: 75, w: 25 },
  "the drop used to be ignored outright, and the segment spilled into the next row");

// Onto another: they share ITS space, half each.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 100, h: 0 },
]);
await edit();
await dragTo("b", await at(0, 20));
await p.mouse.up();
await p.waitForTimeout(300);
check("dropping onto a segment shares that segment's space between the two",
  (await placed()).sort((x, y) => x.x - y.x),
  [{ id: "b", row: 0, x: 0, w: 50 }, { id: "a", row: 0, x: 50, w: 50 }],
  "it used to drop a line and then put the segment on a row of its own");

// Onto the right-hand one of a split row: it shares THAT one's half.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 50, h: 0 },
  { id: "b", type: "player", row: 0, x: 50, w: 50, h: 0 },
  { id: "c", type: "projects", row: 1, x: 0, w: 100, h: 0 },
]);
await edit();
await dragTo("c", await at(0, 90));
await p.mouse.up();
await p.waitForTimeout(300);
check("dropping onto the right-hand one of a split row shares that row",
  (await placed()).filter(s => s.row === 0).sort((x, y) => x.x - y.x),
  [{ id: "a", row: 0, x: 0, w: 50 }, { id: "b", row: 0, x: 50, w: 25 }, { id: "c", row: 0, x: 75, w: 25 }],
  "it used to land in the next row instead");

// Between two rows: a row of its own, there.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 100, h: 0 },
  { id: "c", type: "projects", row: 2, x: 0, w: 100, h: 0 },
]);
await edit();
const join = await p.evaluate(() => {
  const boxes = [...document.querySelectorAll("#home-segments .hs-rowbox")];
  const r = boxes[0].getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom) };
});
await dragTo("c", join);
await p.mouse.up();
await p.waitForTimeout(300);
check("and dropping between two rows makes a row of its own there",
  (await placed()).map(s => [s.id, s.row]), [["a", 0], ["c", 1], ["b", 2]]);

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

// The left edge moves left, and the right edge stays put.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 40, h: 0 },
  { id: "b", type: "player", row: 0, x: 60, w: 40, h: 0 },
]);
await edit();
const colPx = await p.evaluate(() => document.querySelector("#home-segments .hs-rowbox").getBoundingClientRect().width / 100);
await dragGrip("b", "nw", Math.round(-10 * colPx));
check("dragging a left edge moves the LEFT edge",
  (await placed()).find(s => s.id === "b"), { id: "b", row: 0, x: 50, w: 50 },
  "it used to pin the segment to the left of the row and grow it the wrong way");

// And the neighbour gives way rather than being a wall. An edge that simply
// stopped at its neighbour meant a segment could never be made bigger once
// there was anything beside it.
await dragGrip("b", "nw", Math.round(-30 * colPx));
check("an edge dragged into its neighbour makes the neighbour give way",
  (await placed()).find(s => s.id === "b"), { id: "b", row: 0, x: 20, w: 80 });
check("and the neighbour shrinks rather than being shoved along",
  (await placed()).find(s => s.id === "a"), { id: "a", row: 0, x: 0, w: 20 },
  "its left edge stays where it is; the room comes off its right");

// Only up to MIN_W, though: it gives way, it does not disappear.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 40, h: 0 },
  { id: "b", type: "player", row: 0, x: 40, w: 60, h: 0 },
]);
await edit();
await dragGrip("b", "nw", Math.round(-90 * colPx));
check("a neighbour is never squeezed past the narrowest a segment may be",
  (await placed()).find(s => s.id === "a").w, 12);

// And the side NOT being dragged is left completely alone.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 30, h: 0 },
  { id: "b", type: "player", row: 0, x: 30, w: 30, h: 0 },
  { id: "c", type: "clock", row: 0, x: 60, w: 40, h: 0 },
]);
await edit();
await dragGrip("b", "ne", Math.round(20 * colPx));
check("dragging the right edge touches only what is to the right",
  (await placed()).filter(s => s.id !== "b"),
  [{ id: "a", row: 0, x: 0, w: 30 }, { id: "c", row: 0, x: 80, w: 20 }],
  "the one on the left must not move because the right edge did");

// The right edge of the last one on a row reaches the edge of the page.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 30, h: 0 },
  { id: "b", type: "player", row: 0, x: 30, w: 40, h: 0 },
]);
await edit();
await dragGrip("b", "ne", Math.round(40 * colPx));
check("the last segment on a row can be taken out to the page's edge",
  (await placed()).find(s => s.id === "b"), { id: "b", row: 0, x: 30, w: 70 },
  "there was no sharing of that edge between rows, and pulling it there resized from the other side instead");

// ── after Done ──
await set([{ id: "a", type: "recent", row: 0, x: 0, w: 100, h: 0 }]);
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

await set([{ id: "a", type: "projects", row: 0, x: 0, w: 50, h: 0, scale: 100 }]);
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
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 100, h: 0 },
]);
await edit();
await dragTo("b", await at(0, 20));
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
  await p.$$eval("#home-segments .hs.hs-would, #home-segments .hs.hs-would-dim", (e) => e.length), 0);
await p.waitForTimeout(1100);
check("but holding still acts out what would happen",
  await p.$$eval("#home-segments .hs.hs-would", (e) => e.map(n => [n.dataset.id,
    Number(n.style.getPropertyValue("--x")), Number(n.style.getPropertyValue("--w"))])),
  [["a", 50, 50]],
  "the segment being dropped onto slides to the half it would end up in");
check("at half strength, so it reads as a suggestion",
  await p.$eval("#home-segments .hs.hs-would", (e) => getComputedStyle(e).opacity), "0.5");

// Move on, and it goes back to where it really is.
await p.mouse.move(5, 5, { steps: 4 });
await p.waitForTimeout(200);
check("moving on puts everything back",
  await p.$$eval("#home-segments .hs", (e) => e.map(n => [n.classList.contains("hs-would"), n.style.getPropertyValue("--x")])),
  [["a", false, "0"], ["b", false, "0"]].map(x => [x[1], x[2]]));
await p.mouse.up();
await p.waitForTimeout(300);

// And what it acted out is what happens.
await set([
  { id: "a", type: "recent", row: 0, x: 0, w: 100, h: 0 },
  { id: "b", type: "player", row: 1, x: 0, w: 100, h: 0 },
]);
await edit();
await dragTo("b", await at(0, 20));
await p.waitForTimeout(1100);
const previewed = await p.$$eval("#home-segments .hs.hs-would", (e) => e.map(n => [n.dataset.id,
  Number(n.style.getPropertyValue("--x")), Number(n.style.getPropertyValue("--w"))]));
await p.mouse.up();
await p.waitForTimeout(350);
const landed = (await placed()).filter(s => s.id !== "b").map(s => [s.id, s.x, s.w]);
check("and dropping does what was acted out", landed, previewed);

// No green anywhere in the page's own styles.
check("none of the moving markers are coloured",
  await p.evaluate(() => (document.getElementById("home-style").textContent.match(/5ad65a/g) || []).length), 1,
  "the one left is the dot on a friend who is online, which is not about moving anything");

// ── the settings of one segment ─────────────────────────────────────────
await set([
  { id: "g", type: "greeting", row: 0, x: 0, w: 100, h: 0, size: 32, align: "left", text: "" },
  { id: "r", type: "recent", row: 1, x: 0, w: 100, h: 0, title: "Continue playing", count: 6, view: "list", scale: 100 },
]);
await edit();
await p.evaluate(() => {
  document.querySelector('#home-segments .hs[data-id="r"] .hs-tools button').click();
});
await p.waitForTimeout(250);
check("a segment's settings open with what it is set to",
  await p.$$eval(".he-opt input, .he-opt select", (els) => els.map(e => e.type === "checkbox" ? e.checked : e.value)),
  ["Continue playing", "6", "list", "100", "0", "100"],
  "its own options, then the width, height and inside size every type has");

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
  { id: "a", type: "recent", row: 0, x: 0, w: 50, h: 0 },
  { id: "b", type: "player", row: 0, x: 50, w: 50, h: 0 },
]);
await p.evaluate(() => {
  // A mark on each node, which only survives if the node itself does.
  document.querySelectorAll("#home-segments .hs").forEach((n, i) => { n.dataset.mark = "m" + i; });
});
// Added the way the page adds one: through the layout and a save.
await p.evaluate(async () => {
  const L = window.__layout;
  if (!L.some(x => x.id === "c")) L.push({ id: "c", type: "projects", row: 1, x: 0, w: 100, h: 0 });
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
await set([{ id: "n", type: "projects", row: 0, x: 0, w: 60, h: 0 }]);
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

// ── the player render, in a segment too narrow for it ──
//
// skinview3d writes the render's size onto the canvas as INLINE styles, so the
// stylesheet cannot set it: an inline height beats a rule, which is why
// capping the width with max-width squashed the width and left the height
// where it was. That is the stretching. Two things stop it -- the canvas does
// not flex, and what is drawn is letterboxed rather than scaled to the box --
// and the segment measures the room and tells the viewer, which is what keeps
// it sharp.
await set([{ id: "a", type: "player", row: 0, x: 0, w: 18, h: 0 }]);
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
