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

console.log(bad ? `\n${bad} FAILURES` : "\nall pass");
process.exit(bad ? 1 : 0);
