// The launcher's loading animation, which is four pistons pushing a block of
// redstone round a square.
//
// It is drawn from Minecraft's own textures, and it is a view from the SIDE --
// which is the whole of what went wrong with it. A piston seen from the side
// shows piston_side and nothing else: its wooden face and its inner plate are
// both end-on, so neither is ever visible. Drawing them anyway made an
// extended piston wrong in three separate ways at once:
//
//   the inner plate filled the four pixels the head had left with, so the
//   body still read as a whole block rather than the shorter one it is;
//   the arm was cut from a band ACROSS the texture instead of the strip along
//   it, so it was the body's pattern rather than the shaft;
//   and the head wore the wooden face, which is the one surface of a piston
//   that cannot be seen from the side.
//
// So this checks the SHAPE: where there are pixels and where there are not.
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FE = path.join(ROOT, "frontend");

let bad = 0;
const fail = (what, why) => { bad++; console.log(`FAIL ${what}\n       ${why}`); };
const ok = (what, note) => console.log(`ok   ${what}${note ? "  — " + note : ""}`);
const check = (what, got, want, note) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) ok(what, note); else fail(what, `got  ${a}\n       want ${b}`);
};

// A page that draws one frame at an exact point of the cycle, at one pixel
// per texture pixel, so a column of the canvas IS a column of the drawing.
const probe = path.join(FE, "__piston_test.html");
fs.writeFileSync(probe, `<!doctype html><html><body style="margin:0">
<canvas id="c" width="64" height="64"></canvas>
<script src="loading.js"><\/script>
</body></html>`);

// A texture loaded from a file:// page taints the canvas, and a tainted
// canvas cannot be read back -- which is the whole of this test. The flag
// lets one local file read another, which is what the launcher itself does.
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium",
  args: ["--no-sandbox", "--allow-file-access-from-files"],
});
const page = await browser.newPage({ viewport: { width: 200, height: 200 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto("file://" + probe, { waitUntil: "load" });

// The textures have to be in before anything can be drawn.
const ready = await page.evaluate(async () => {
  const cv = document.getElementById("c");
  window.__cx = cv.getContext("2d");
  // mount() loads them; the canvas it makes is thrown away.
  const spare = document.createElement("div");
  document.body.appendChild(spare);
  const m = window.Loading.mount(spare, { size: 64 });
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 50));
    const probeCv = spare.querySelector("canvas");
    if (!probeCv) continue;
    const d = probeCv.getContext("2d").getImageData(0, 0, 64, 64).data;
    if (d.some(v => v !== 0)) { m.stop(); return true; }
  }
  m.stop();
  return false;
});
check("the textures load and something is drawn", ready, true);

/**
 * Where the left-hand piston has pixels, read straight down the page.
 *
 * It is PISTONS[1]: cell (0,1), pushing down. Its quarter of the cycle
 * starts at t = 0.25, so t = 0.45 is part-way through its stroke and t =
 * 0.95 is long after it has come home. Read at x = 2, which is beside the
 * arm rather than on it -- on it, the arm bridges the gap and the column
 * looks the same extended as it does at rest, which is exactly what has to
 * be told apart.
 */
const COL = 2;
const columnAt = (t) => page.evaluate(([at, x]) => {
  const cx = window.__cx;
  const TEX = window.Loading.TEX;
  cx.clearRect(0, 0, 64, 64);
  window.Loading.frame(cx, at);
  // The body's cell and the one it pushes into.
  const d = cx.getImageData(x, TEX, 1, TEX * 2).data;
  const on = [];
  for (let i = 0; i < d.length; i += 4) on.push(d[i + 3] > 20 ? 1 : 0);
  return on.join("");
}, [t, COL]);

// At rest it is a whole block: twelve of body and four of collar, solid.
const atRest = await columnAt(0.95);
check("at rest a piston is a whole block, with nothing missing out of it",
  atRest.slice(0, 16), "1111111111111111", atRest);

// Fired, the body stays where it is and the head has gone a block ahead,
// and between them is a gap -- which is the thing that was being filled in.
const fired = await columnAt(0.45);
const body = fired.slice(0, 12), gap = fired.slice(12, 28), head = fired.slice(28, 32);
check("fired, the body is the twelve pixels that stay behind",
  body, "111111111111", fired);
check("and there is a gap where the head used to be, not more block",
  /^0+$/.test(gap), true, `${gap} -- the inner plate used to fill the first four of these`);
check("and the head is a block ahead, four pixels of it",
  head, "1111", fired);

// Across that gap there is the arm and nothing else: four pixels of the
// sixteen. The plate that used to fill the rest is what made an extended
// piston read as a whole block.
const acrossGap = await page.evaluate(() => {
  const cx = window.__cx;
  const TEX = window.Loading.TEX;
  cx.clearRect(0, 0, 64, 64);
  window.Loading.frame(cx, 0.45);
  const row = cx.getImageData(0, TEX * 2 + 4, TEX, 1).data;
  const on = [];
  for (let i = 0; i < row.length; i += 4) on.push(row[i + 3] > 20 ? 1 : 0);
  return on.join("");
});
check("across the space the head has left, only the arm is there",
  acrossGap, "0000001111000000",
  "four pixels of sixteen, which is the width the game's own piston arm is");

// And the head is the collar -- the top of piston_side -- rather than the
// wooden face, which is a different picture and a different colour.
const colours = await page.evaluate(([x]) => {
  const cx = window.__cx;
  const TEX = window.Loading.TEX;
  cx.clearRect(0, 0, 64, 64);
  window.Loading.frame(cx, 0.45);
  const px = (ax, ay) => { const d = cx.getImageData(ax, ay, 1, 1).data; return [d[0], d[1], d[2]]; };
  return {
    body: px(x, TEX + 6), head: px(x, TEX * 2 + 14), collar: px(x, 2),
    // Down the middle, in the gap: the arm. Near the head and near the body.
    armNearHead: px(TEX / 2, TEX * 2 + 10),
    armNearBody: px(TEX / 2, TEX + 14),
  };
}, [COL]);
const apart = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
check("the head is the collar off the top of the texture, not the body's pattern",
  apart(colours.head, colours.body) > 25, true,
  `head ${colours.head} against body ${colours.body}`);

// And the arm is the band off the top of piston_side, laid ALONG it.
//
// Out of block/template_piston_head, which is the thing to check against:
//
//   { "from": [6,6,4], "to": [10,10,20],
//     "east": { "uv": [0,0,16,4], "texture": "#side" } }
//
// Four across and sixteen long -- a whole block, so nothing ever has to be
// invented to fill the reach -- textured with the top four ROWS of
// piston_side, the wooden band the head's collar is also cut from, with the
// uv running 0..16 across the texture against the arm's 16 length. So the
// texture's X axis runs along the arm and its four rows are the arm's
// thickness: a horizontal strip turned a quarter, not a vertical one.
//
// Which is checkable exactly: read the arm down its length and it must be
// row 0 of the texture, pixel for pixel.
const armAgainstTexture = await page.evaluate(() => {
  const cx = window.__cx;
  const TEX = window.Loading.TEX;
  cx.clearRect(0, 0, 64, 64);
  window.Loading.frame(cx, 0.45);
  // Where the arm's own frame lands on the page, worked through rather than
  // guessed at. The left-hand piston is cell (0,1) pushing down, so its
  // local frame is turned half a turn and local (x,y) lands at (16-x, 32-y).
  // The arm is turned a further quarter inside that, which puts texture row
  // v at local x 9-v -- so row 0 is the leftmost of the arm's four pixels,
  // at x 6 -- and texture column u at local y u-12, which is y 43-u down
  // the page, counting from the end the head is on.
  const down = [];
  for (let u = 0; u < TEX; u++) {
    const d = cx.getImageData(6, 43 - u, 1, 1).data;
    down.push(d[3] < 20 ? null : [d[0], d[1], d[2]]);
  }
  // Row 0 of piston_side itself, straight off the texture.
  const im = new Image();
  return new Promise((done) => {
    im.onload = () => {
      const c2 = document.createElement('canvas');
      c2.width = c2.height = TEX;
      const g = c2.getContext('2d');
      g.drawImage(im, 0, 0);
      const row = [];
      for (let x = 0; x < TEX; x++) {
        const d = g.getImageData(x, 0, 1, 1).data;
        row.push([d[0], d[1], d[2]]);
      }
      done({ down, row });
    };
    im.onerror = () => done({ down, row: null });
    im.src = 'assets/blocks/piston_side.png';
  });
});
check("the arm read down its length IS the top row of piston_side",
  armAgainstTexture.down, armAgainstTexture.row,
  "sixteen pixels of texture for sixteen pixels of arm, turned a quarter — which is what the game's own model says");

// Which is also why it has the bands on it: those are the grey squares in
// that row, and they are what a piston's arm looks like.
const bands = (armAgainstTexture.down || []).filter(c => c && Math.abs(c[0] - c[2]) < 20).length;
check("so it has the metal bands along it rather than being plain",
  bands >= 4 && bands <= 8, true,
  `${bands} of its sixteen pixels are the grey of the bands`);

// The two textures that cannot be seen from the side are not even loaded.
const src = fs.readFileSync(path.join(FE, "loading.js"), "utf8");
check("and the two end-on textures are not asked for at all",
  [/piston_face/.test(src), /piston_inner/.test(src)], [false, false],
  "the wooden face and the inner plate are end-on in this view");

fs.unlinkSync(probe);
if (errors.length) fail("the animation throws nothing", errors.join(" | "));
await browser.close();
console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
