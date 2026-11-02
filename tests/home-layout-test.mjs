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
  { type: "greeting", name: "Greeting", options: [] },
  { type: "recent", name: "Instances", options: [] },
  { type: "player", name: "Player", options: [] },
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

// And it stops at its neighbour rather than pushing it.
await dragGrip("b", "nw", Math.round(-30 * colPx));
check("and stops where its neighbour is", (await placed()).find(s => s.id === "b").x, 40);
check("leaving the neighbour alone", (await placed()).find(s => s.id === "a"), { id: "a", row: 0, x: 0, w: 40 });

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

if (errors.length) { console.log("PAGE ERRORS:", errors.join(" | ")); bad += errors.length; }
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
