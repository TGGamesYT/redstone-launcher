// The launcher's icon, built from its layers.
//
// Three layers, three different answers: the background takes the theme, the
// gem takes the second colour, and the cog is never touched. The checks that
// matter are the ones about what is NOT changed -- the cog going green and
// staying green through every later theme is the bug this replaces.
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";
import icon from "../backend/app-icon.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "frontend", "assets", "icon");
const OUT = path.join(ROOT, "node_modules", ".cache", "icon");
fs.mkdirSync(OUT, { recursive: true });

let bad = 0;
const check = (label, got, want, note) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${note ? "  — " + note : ""}\n       got  ${JSON.stringify(got)}` + (ok ? "" : `\n       want ${JSON.stringify(want)}`));
};

const layers = {
  background: path.join(DIR, icon.PART_FILES.background),
  gem: path.join(DIR, icon.PART_FILES.gem),
  cog: path.join(DIR, icon.PART_FILES.cog),
};
check("the icon ships with its layers", Object.values(layers).map(f => fs.existsSync(f)), [true, true, true]);

const SIZE = 128;
const raw = async (png) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};
// Where each layer actually has pixels, so each can be measured on its own
// ground rather than over the whole square.
const maskOf = async (file) => {
  const { data } = await raw(await sharp(file).resize(SIZE, SIZE).png().toBuffer());
  const m = [];
  for (let i = 0; i < data.length; i += 4) m.push(data[i + 3] > 200);
  return m;
};
const cogMask = await maskOf(layers.cog);
// Only where the cog is completely opaque. At a soft edge it is blended with
// whatever is under it, so those pixels legitimately change with the theme.
const cogSolid = await (async () => {
  const { data } = await raw(await sharp(layers.cog).resize(SIZE, SIZE).png().toBuffer());
  const m = [];
  for (let i = 0; i < data.length; i += 4) m.push(data[i + 3] === 255);
  return m;
})();
const gemMask = await maskOf(layers.gem);
// The gem sits on the background and the cog over both, so "background only"
// means the part of it neither of the others covers.
const bgOnly = (await maskOf(layers.background)).map((on, i) => on && !cogMask[i] && !gemMask[i]);
const gemOnly = gemMask.map((on, i) => on && !cogMask[i]);

const hueOf = (data, mask) => {
  let n = 0, x = 0, y = 0, sat = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!mask[p] || data[i + 3] < 200) continue;
    const [h, s] = icon.rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const r = (h * Math.PI) / 180;
    x += Math.cos(r); y += Math.sin(r); sat += s; n++;
  }
  if (!n) return null;
  return { hue: Math.round(((Math.atan2(y / n, x / n) * 180) / Math.PI + 360) % 360), sat: +(sat / n).toFixed(3), n };
};

const build = async (fills) => raw(await icon.buildIcon(layers, fills, SIZE));

// ── the shipped colours ──
const asShipped = await build({});
check("left alone, the background is the red it was drawn",
  hueOf(asShipped.data, bgOnly).hue < 10 || hueOf(asShipped.data, bgOnly).hue > 350, true);
const cogAsShipped = hueOf(asShipped.data, cogMask);
check("and the cog is grey, which is what it is for", cogAsShipped.sat < 0.1, true,
  `saturation ${cogAsShipped.sat}`);

// ── the launcher's own colours give back the launcher's own icon ──
//
// The recolouring used to re-centre a layer on the FILL colour's lightness:
// every pixel kept its distance from the layer's average and the average
// became the theme colour. The backing is drawn at a lightness of about 0.21
// and the launcher's base colour is 0.375, so painting the backing in the
// launcher's own colour came out nearly twice as light as the artwork -- and
// every other theme was lifted by the same amount, which is why the backing
// and the gem always looked lit up. The fill is read as a DIFFERENCE from
// the colour the layer was drawn for now, so the same colour reproduces the
// artwork and every other theme is shifted by as much as it differs.
const DEFAULT_BASE = "#b30c0c", DEFAULT_SECOND = "#ff4d4d";
const anchors = { background: DEFAULT_BASE, gem: DEFAULT_SECOND };
const meanLight = (data, mask) => {
  let l = 0, n = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!mask[p] || data[i + 3] < 200) continue;
    l += icon.rgbToHsl(data[i], data[i + 1], data[i + 2])[2]; n++;
  }
  return n ? l / n : 0;
};
const drawnBg = meanLight(asShipped.data, bgOnly);
const drawnGem = meanLight(asShipped.data, gemOnly);

const ownUnanchored = await raw(await icon.buildIcon(layers, {
  background: { kind: "color", hex: DEFAULT_BASE },
  gem: { kind: "color", hex: DEFAULT_SECOND },
}, SIZE));
const ownAnchored = await raw(await icon.buildIcon(layers, {
  background: { kind: "color", hex: DEFAULT_BASE },
  gem: { kind: "color", hex: DEFAULT_SECOND },
}, SIZE, anchors));

// The strongest form of it: built in the colours the artwork was drawn for,
// the result IS the artwork. Not close -- the same pixels.
const samePixels = (a, b, mask) => {
  let n = 0, same = 0;
  for (let i = 0, p = 0; i < a.length; i += 4, p++) {
    if (!mask[p] || a[i + 3] < 200) continue;
    n++;
    if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2]) same++;
  }
  return { n, same, pct: n ? same / n : 0 };
};
const bgSame = samePixels(asShipped.data, ownAnchored.data, bgOnly);
const gemSame = samePixels(asShipped.data, ownAnchored.data, gemOnly);
check("built in the launcher's own colours, the backing is the artwork pixel for pixel",
  bgSame.pct > 0.999, true, `${bgSame.same} of ${bgSame.n}`);
check("and so is the gem",
  gemSame.pct > 0.999, true, `${gemSame.same} of ${gemSame.n}`);
const bgWas = samePixels(asShipped.data, ownUnanchored.data, bgOnly);
check("which it was NOT before -- hardly a pixel of it matched",
  bgWas.pct < 0.1, true, `${bgWas.same} of ${bgWas.n}`);

check("built in the launcher's own colours, the backing is as light as it was drawn",
  Math.abs(meanLight(ownAnchored.data, bgOnly) - drawnBg) < 0.01, true,
  `${meanLight(ownAnchored.data, bgOnly).toFixed(3)} against the artwork's ${drawnBg.toFixed(3)}`);
check("and the gem likewise",
  Math.abs(meanLight(ownAnchored.data, gemOnly) - drawnGem) < 0.01, true,
  `${meanLight(ownAnchored.data, gemOnly).toFixed(3)} against the artwork's ${drawnGem.toFixed(3)}`);
check("which it was NOT without it -- the backing came out far lighter",
  meanLight(ownUnanchored.data, bgOnly) > drawnBg + 0.1, true,
  `${meanLight(ownUnanchored.data, bgOnly).toFixed(3)} against ${drawnBg.toFixed(3)}`);

// And the colour within a layer survives, which is what stops the facets of
// the gem running into one another. Every pixel used to be given the fill's
// saturation outright, so a layer whose facets differ in saturation came out
// flat.
const satSpread = (data, mask) => {
  let n = 0, sum = 0, sq = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!mask[p] || data[i + 3] < 200) continue;
    const s2 = icon.rgbToHsl(data[i], data[i + 1], data[i + 2])[1];
    sum += s2; sq += s2 * s2; n++;
  }
  const mean2 = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean2 * mean2));
};
check("the gem's facets keep the colour that tells them apart",
  Math.abs(satSpread(ownAnchored.data, gemOnly) - satSpread(asShipped.data, gemOnly)) < 0.005, true,
  `spread ${satSpread(ownAnchored.data, gemOnly).toFixed(3)} against the artwork's ${satSpread(asShipped.data, gemOnly).toFixed(3)}`);
check("where they used to be given one saturation between them",
  satSpread(ownUnanchored.data, gemOnly) < 0.01, true,
  `spread ${satSpread(ownUnanchored.data, gemOnly).toFixed(3)} -- flat`);

// A lighter theme colour still lightens it -- the anchor is a starting
// point, not a cap.
const lighter = await raw(await icon.buildIcon(layers, {
  background: { kind: "color", hex: "#ff6666" },
  gem: { kind: "color", hex: DEFAULT_SECOND },
}, SIZE, anchors));
check("a lighter theme colour still makes a lighter backing",
  meanLight(lighter.data, bgOnly) > drawnBg + 0.1, true,
  `${meanLight(lighter.data, bgOnly).toFixed(3)} against ${drawnBg.toFixed(3)}`);
const darker = await raw(await icon.buildIcon(layers, {
  background: { kind: "color", hex: "#400404" },
  gem: { kind: "color", hex: DEFAULT_SECOND },
}, SIZE, anchors));
check("and a darker one a darker backing",
  meanLight(darker.data, bgOnly) < drawnBg - 0.05, true,
  `${meanLight(darker.data, bgOnly).toFixed(3)} against ${drawnBg.toFixed(3)}`);

// ── a highlight stays a highlight in another colour ──
//
// HSL's "lightness" is the midpoint of the largest and smallest channel,
// which puts yellow and blue at the same L while yellow is plainly far
// brighter. Carry a layer's shading across in HSL and the NUMBERS travel but
// the shading does not: the gem's highlight is a lighter, slightly orange
// red, and in a blue theme it came out at the same L with its hue most of
// the way round the circle -- still dark, and no longer reading as a
// highlight. Oklab is built so that equal steps look like equal steps, so
// the recolouring is done there.
const okRange = (data, mask) => {
  let min = 1, max = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!mask[p] || data[i + 3] < 200) continue;
    const L = icon.rgbToOklch(data[i], data[i + 1], data[i + 2])[0];
    if (L < min) min = L;
    if (L > max) max = L;
  }
  return max - min;
};
const blueGem = await raw(await icon.buildIcon(layers, {
  background: { kind: "color", hex: "#1446a0" },
  gem: { kind: "color", hex: "#4d9bff" },
}, SIZE, anchors));
const drawnRange = okRange(asShipped.data, gemOnly);
check("a gem turned blue keeps the range of light the artwork had",
  Math.abs(okRange(blueGem.data, gemOnly) - drawnRange) < 0.02, true,
  `${okRange(blueGem.data, gemOnly).toFixed(3)} against the artwork's ${drawnRange.toFixed(3)}`);

// The same shift done in HSL, for comparison: this is what it looked like,
// and the point is that it is measurably flatter rather than that it is a
// matter of taste.
const inHsl = (() => {
  const a = icon.rgbToHsl(...icon.hexToRgb(DEFAULT_SECOND));
  const f = icon.rgbToHsl(...icon.hexToRgb("#4d9bff"));
  const out = Buffer.from(asShipped.data);
  for (let i = 0, p = 0; i < out.length; i += 4, p++) {
    if (!gemOnly[p]) continue;
    const [h, sat, l] = icon.rgbToHsl(out[i], out[i + 1], out[i + 2]);
    const [r, g, b] = icon.hslToRgb(
      (((h + f[0] - a[0]) % 360) + 360) % 360,
      Math.max(0, Math.min(1, sat + f[1] - a[1])),
      Math.max(0, Math.min(1, l + f[2] - a[2])));
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
})();
check("where the same shift done in HSL flattens it",
  okRange(inHsl, gemOnly) < drawnRange - 0.06, true,
  `${okRange(inHsl, gemOnly).toFixed(3)} against the artwork's ${drawnRange.toFixed(3)}`);

// ── every part of it is the colour that was asked for ──
//
// Turning each pixel's hue by the same amount sounds right and is not: the
// hue circle is not evenly divided between the colours anybody can name. The
// gem's body sits at hue 25 and its lit facets at 35 to 40 -- warmer, which
// in red reads as orange, the colour a lit red stone is. Carry that offset
// round to blue and the body lands on 251, which is blue, while the facets
// land on 266 to 271, which is indigo: the lightest parts of a blue gem came
// out a different colour from the rest of it.
const hueRange = (data, mask) => {
  let min = 400, max = -1;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    if (!mask[p] || data[i + 3] < 200) continue;
    const [, C, h] = icon.rgbToOklch(data[i], data[i + 1], data[i + 2]);
    if (C < 0.01) continue;              // grey has no hue to speak of
    if (h < min) min = h;
    if (h > max) max = h;
  }
  return { min, max, spread: max - min };
};
const askedFor = icon.oklchOf("#4d9bff")[2];
const blueHue = hueRange(blueGem.data, gemOnly);
check("every part of a gem turned blue is the blue that was asked for",
  [Math.abs(blueHue.min - askedFor) < 8, Math.abs(blueHue.max - askedFor) < 8], [true, true],
  `hue ${blueHue.min.toFixed(0)}-${blueHue.max.toFixed(0)} against the ${askedFor.toFixed(0)} asked for`);

// What turning each pixel's own hue by the same amount would have given.
const rotated = (() => {
  const a = icon.oklchOf(DEFAULT_SECOND), f = icon.oklchOf("#4d9bff");
  const out = Buffer.from(asShipped.data);
  for (let i = 0, p = 0; i < out.length; i += 4, p++) {
    if (!gemOnly[p]) continue;
    const [L, C, h] = icon.rgbToOklch(out[i], out[i + 1], out[i + 2]);
    const [r, g, b] = icon.oklchToRgb(
      Math.max(0, Math.min(1, L + f[0] - a[0])),
      Math.max(0, C + f[1] - a[1]),
      (((h + f[2] - a[2]) % 360) + 360) % 360);
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
})();
const rotatedHue = hueRange(rotated, gemOnly);
check("where turning each pixel's own hue sent the lit facets into indigo",
  rotatedHue.max - askedFor > 10, true,
  `up to hue ${rotatedHue.max.toFixed(0)}, ${(rotatedHue.max - askedFor).toFixed(0)} past the blue asked for`);

// And it is still a gem rather than a flat shape: the lightness and the
// colourfulness are what tell its facets apart, and both survive.
check("and it is still lit, and still has facets",
  [okRange(blueGem.data, gemOnly) > 0.3,
    satSpread(blueGem.data, gemOnly) > 0.05], [true, true],
  `${okRange(blueGem.data, gemOnly).toFixed(2)} of light across it, saturation spread ${satSpread(blueGem.data, gemOnly).toFixed(3)}`);

// ── a picture goes in as it is ──
//
// A block's texture, or the very picture the launcher is wearing, is not a
// colour: it has its own light and shade already. Carrying the backing's
// shading onto it on top of that tinted and darkened a picture that was
// meant to show as itself.
{
  const tile = await sharp({
    create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 160, b: 60, alpha: 1 } },
  }).png().toBuffer();
  const withTexture = await raw(await icon.buildIcon(layers, {
    background: { kind: "texture", png: tile },
    gem: { kind: "color", hex: DEFAULT_SECOND },
  }, SIZE, anchors));
  let same = 0, n = 0, sr = 0, sg = 0, sb = 0;
  for (let i = 0, p = 0; i < withTexture.data.length; i += 4, p++) {
    if (!bgOnly[p] || withTexture.data[i + 3] < 200) continue;
    n++;
    sr += withTexture.data[i]; sg += withTexture.data[i + 1]; sb += withTexture.data[i + 2];
    if (withTexture.data[i] === 90 && withTexture.data[i + 1] === 160 && withTexture.data[i + 2] === 60) same++;
  }
  // Not every pixel: the cog and the gem have soft edges, and the pixels
  // just outside them carry a little of those edges. Shading the texture
  // would have left nothing exact at all, so most-of-it-exact is the test.
  const mean = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  check("a texture behind the icon is the texture, not the texture shaded",
    [n > 100, same / n > 0.85,
      Math.abs(mean[0] - 90) < 5 && Math.abs(mean[1] - 160) < 5 && Math.abs(mean[2] - 60) < 5],
    [true, true, true],
    `${same} of ${n} exact, mean ${mean.join(",")} against the picture's 90,160,60`);
  // And it is still cut to the shape of the backing rather than filling the
  // square -- the cog and the gem are drawn over it, and the rounded corners
  // are the backing's.
  const cog = hueOf(withTexture.data, cogMask);
  check("and the cog is still the cog over it", cog.sat < 0.1, true, `saturation ${cog.sat}`);
}

// ── a green theme ──
const green = await build({
  background: { kind: "color", hex: "#2ecc40" },
  gem: { kind: "color", hex: "#b5ff7a" },
});
await sharp(green.data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toFile(path.join(OUT, "green.png"));
const greenBg = hueOf(green.data, bgOnly);
check("a green theme turns the background green", Math.abs(greenBg.hue - 126) < 18, true, `hue ${greenBg.hue}`);
check("and the gem the second colour", Math.abs(hueOf(green.data, gemOnly).hue - 95) < 25, true,
  `hue ${hueOf(green.data, gemOnly).hue}`);
// The one that went wrong before: the cog is not the theme's business.
const greenCog = hueOf(green.data, cogMask);
check("and the cog is still grey", greenCog.sat < 0.1, true,
  `saturation ${greenCog.sat} — it went green and stayed green through every later theme`);
check("pixel for pixel, the solid cog is exactly what it was", (() => {
  let same = 0, n = 0;
  for (let i = 0, p = 0; i < green.data.length; i += 4, p++) {
    if (!cogSolid[p]) continue;
    n++;
    if (green.data[i] === asShipped.data[i] && green.data[i + 1] === asShipped.data[i + 1] && green.data[i + 2] === asShipped.data[i + 2]) same++;
  }
  return [n > 1000, same === n];
})(), [true, true]);

// ── going back ──
// The icon is always built from the shipped layers, so a theme after a theme
// gives the same answer as that theme on its own. Recolouring something
// already recoloured is what made the green stick.
const red = await build({ background: { kind: "color", hex: "#b30c0c" }, gem: { kind: "color", hex: "#ff4d4d" } });
const redAgain = await build({ background: { kind: "color", hex: "#b30c0c" }, gem: { kind: "color", hex: "#ff4d4d" } });
check("building it twice gives the same icon", Buffer.compare(red.data, redAgain.data), 0);
check("and a theme after another theme is not a theme on top of a theme",
  hueOf(red.data, bgOnly).hue < 10 || hueOf(red.data, bgOnly).hue > 350, true,
  "going back to red after green has to BE red");

// ── a theme with no colour in it at all ──
const grey = await build({ background: { kind: "color", hex: "#8a8a8a" }, gem: { kind: "color", hex: "#cfcfcf" } });
const greyBg = hueOf(grey.data, bgOnly);
check("a grey theme really does grey the background", greyBg.sat < 0.08, true, `saturation ${greyBg.sat}`);
check("and the shading survives it", (() => {
  let lo = 1, hi = 0;
  for (let i = 0, p = 0; i < grey.data.length; i += 4, p++) {
    if (!bgOnly[p]) continue;
    const l = icon.rgbToHsl(grey.data[i], grey.data[i + 1], grey.data[i + 2])[2];
    lo = Math.min(lo, l); hi = Math.max(hi, l);
  }
  return hi - lo > 0.15;
})(), true, "a flat sticker would have no range at all");

// ── the background showing through ──
const block = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 255 } } }).png().toBuffer();
const through = await build({
  background: { kind: "texture", png: block, pixelated: true },
  gem: { kind: "color", hex: "#ff4d4d" },
});
await sharp(through.data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toFile(path.join(OUT, "block.png"));
const throughBg = hueOf(through.data, bgOnly);
check("the background block goes BEHIND the icon, not into the cog",
  [Math.abs(throughBg.hue - 219) < 20, hueOf(through.data, cogMask).sat < 0.1], [true, true],
  "it used to be painted into the cog, which is the one layer that must never change");

// ── a gradient ──
const grad = await build({
  background: { kind: "gradient", colors: ["#ff0000", "#0000ff"], angle: 180 },
  gem: { kind: "color", hex: "#ffffff" },
});
await sharp(grad.data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toFile(path.join(OUT, "gradient.png"));
const half = (from, to) => {
  const m = bgOnly.map((on, p) => on && Math.floor(p / SIZE) >= from && Math.floor(p / SIZE) < to);
  return hueOf(grad.data, m);
};
check("a gradient runs down the icon, as 180deg does in the launcher",
  [half(0, SIZE / 3).hue < 25 || half(0, SIZE / 3).hue > 335, Math.abs(half(SIZE * 2 / 3, SIZE).hue - 240) < 30],
  [true, true],
  `top ${half(0, SIZE / 3).hue}°, bottom ${half(SIZE * 2 / 3, SIZE).hue}°`);

// ── the odd ones in ──
check("a gradient of one colour is a colour", icon.normaliseFill({ kind: "gradient", colors: ["#fff"] }), { kind: "color", hex: "#fff" });
check("a gradient of none is nothing at all", icon.normaliseFill({ kind: "gradient", colors: [] }), null);
check("and a short hex still reads", icon.hexToRgb("#f00"), [255, 0, 0]);

// ── where the icon lives ──
// The loose copies in frontend/ are gone; anything still pointing at them
// would be a broken image in the app and a build with no icon at all.
const gone = ["frontend/icon.png", "frontend/icon.ico", "frontend/icon.icns", "frontend/old"];
check("the old copies are not there any more", gone.map(f => fs.existsSync(path.join(ROOT, f))), gone.map(() => false));

const walk = (dir, out = []) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === "node_modules" || d.name === ".git" || d.name === "tests") continue;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) walk(full, out);
    else if (/\.(js|cjs|mjs|html|json|yml)$/.test(d.name)) out.push(full);
  }
  return out;
};
const pointing = [];
for (const f of walk(ROOT)) {
  const text = fs.readFileSync(f, "utf8");
  // A path that names frontend/icon.* or opens one relative to a page. The
  // bare word "icon.png" also appears for modpack artwork inside a zip, which
  // is a different thing entirely, so only these two shapes count.
  for (const re of [/frontend[/\\]icon\.(png|ico|icns)/g, /src=["']icon\.png["']/g, /frontend[/\\]old[/\\]/g]) {
    if (re.test(text)) pointing.push(path.relative(ROOT, f));
  }
}
check("and nothing still points at them", [...new Set(pointing)], []);
check("the build is told where the icon is now",
  ["png", "ico", "icns"].map(e => JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).build).includes(`frontend/assets/icon/redstone_logo.${e}`)),
  [true, true, true]);

// ── framing the background picture inside the icon ──────────────────────
//
// The backing is a circle 256 pixels across and a wallpaper is a couple of
// thousand, so the whole of one squeezed into it is the picture seen from
// much too far away: whatever it is OF ends up a few pixels in the middle.
// It goes through the same cropper an instance's icon uses, and what comes
// back is a finished 256-pixel square the icon wears as it is.
//
// The real backgroundAsFill out of the main process, with the two things it
// reaches for stubbed: the settings it reads and the files it opens.
const mainSrc = fs.readFileSync(path.join(ROOT, "backend/main.js"), "utf8");
const cutFill = (() => {
  // Everything the backing is made of: the stack of pictures, the key that
  // says which stack a framing belongs to, and the tiled-block backing.
  const i = mainSrc.indexOf("function backgroundImages(bg) {");
  const j = mainSrc.indexOf("// What each layer is filled with", i);
  return i < 0 || j < 0 ? null : mainSrc.slice(i, j);
})();
check("backgroundAsFill is where it was",
  !!cutFill && /async function backgroundAsFill\(\)/.test(cutFill), true);

const WALL = path.join(OUT, "wallpaper.png");
await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } })
  .png().toFile(WALL);
const CROP = "data:image/png;base64," + (await sharp({
  create: { width: 8, height: 8, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } },
}).png().toBuffer()).toString("base64");

const fillWith = (store) => new Function("settings", "fs", "sharp", "fromDataUrl", `
  ${cutFill}
  return backgroundAsFill();
`)(
  { get: (k, d) => (k in store ? store[k] : d) },
  fs,
  sharp,
  (u) => Buffer.from(String(u).replace(/^data:image\/[\w+.-]+;base64,/, ""), "base64"),
);

// What a returned backing is actually a picture OF: its size, and the
// colour of the middle of it. The bytes cannot be compared any more --
// the backing is drawn, not handed over -- and the colour is the point.
const describe = async (fill) => {
  const m = await sharp(fill.png).metadata();
  const px = await sharp(fill.png).extract({ left: Math.floor(m.width / 2), top: Math.floor(m.height / 2), width: 1, height: 1 })
    .raw().toBuffer();
  return { w: m.width, h: m.height, rgb: [px[0], px[1], px[2]] };
};
const BLUE = [10, 120, 200], RED = [200, 40, 40];

const bgPicture = { mode: "image", image: { file: WALL } };
const whole = await fillWith({ background: bgPicture, appIcon: { kind: "theme" } });
check("with no framing the icon wears the picture itself",
  [whole.kind, (await describe(whole)).rgb], ["texture", BLUE]);

const framed = await fillWith({
  background: bgPicture,
  appIcon: { kind: "theme", backCrop: CROP, backCropOf: WALL },
});
check("and with a framing it wears that instead",
  [framed.kind, (await describe(framed)).rgb], ["texture", RED],
  "the crop is its own picture, not the wallpaper again");

// ── a stack of pictures ──
//
// The backing used to be bg.image and nothing else, which is the top of the
// stack: with two pictures, the icon showed something the window does not.
{
  const UNDER = path.join(OUT, "under.png");
  await sharp({ create: { width: 40, height: 20, channels: 4, background: { r: 20, g: 200, b: 60, alpha: 1 } } })
    .png().toFile(UNDER);
  // A top picture with a hole in the middle of it, over a green one.
  const HOLE = path.join(OUT, "hole.png");
  await sharp({ create: { width: 40, height: 40, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } } })
    .composite([{
      // Opaque, and dest-out: what is removed is where the SOURCE is solid.
      input: await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(),
      left: 10, top: 10, blend: "dest-out",
    }]).png().toFile(HOLE);
  const stack = { mode: "image", images: [{ file: HOLE, fit: "cover" }, { file: UNDER, fit: "cover" }], image: { file: HOLE } };
  const both = await fillWith({ background: stack, appIcon: { kind: "theme" } });
  check("the backing is the whole stack, not the top of it",
    [(await describe(both)).w, (await describe(both)).rgb], [256, [20, 200, 60]],
    "the one underneath shows through where the one over it does not reach, which is what the window shows");

  // And a framing belongs to the stack it was made of.
  const key = `${HOLE}@cover|${UNDER}@cover`;
  check("a framing of this stack is worn",
    (await describe(await fillWith({
      background: stack, appIcon: { kind: "theme", backCrop: CROP, backCropOf: key },
    }))).rgb, RED);
  check("and one made before the second picture was added is not",
    (await describe(await fillWith({
      background: stack, appIcon: { kind: "theme", backCrop: CROP, backCropOf: `${HOLE}@cover` },
    }))).rgb, [20, 200, 60],
    "adding a picture changes what the backing shows, so a framing of what it showed before is a framing of something else");
}

// A framing belongs to the picture it was made from. Choosing another
// background and finding the icon still wearing a crop of the old one is
// worse than finding it wearing none.
const stale = await fillWith({
  background: { mode: "image", image: { file: WALL } },
  appIcon: { kind: "theme", backCrop: CROP, backCropOf: path.join(OUT, "some-other.png") },
});
check("a framing of a picture that is no longer set is dropped",
  (await describe(stale)).rgb, BLUE,
  "the whole picture comes back rather than a crop of a wallpaper nobody has any more");

// And it only applies to a picture: a tiled block or a gradient has nothing
// to frame, so a leftover crop must not be worn by one.
check("a tiled block is not given the picture's framing",
  (await fillWith({
    background: { mode: "block", block: { url: CROP } },
    appIcon: { kind: "theme", backCrop: CROP, backCropOf: WALL },
  })).pixelated, true);
check("and a gradient is still a gradient",
  (await fillWith({
    background: { mode: "gradient", gradient: { colors: ["#111", "#222"], angle: 10 } },
    appIcon: { kind: "theme", backCrop: CROP, backCropOf: WALL },
  })).kind, "gradient");
check("and the app's own panel has nothing to take",
  await fillWith({ background: { mode: "theme" }, appIcon: { kind: "theme", backCrop: CROP } }), null);

// The settings page opens the same cropper an instance's icon gets, rather
// than a second one that could drift from it.
const setSrc = fs.readFileSync(path.join(ROOT, "frontend/settings.html"), "utf8");
check("the settings page uses the icon picker's own cropper",
  /IconPicker\.__crop\(/.test(setSrc), true);
check("and stores what it gives back",
  /icon:setBackCrop/.test(setSrc) && /icon:setBackCrop/.test(mainSrc), true);

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
