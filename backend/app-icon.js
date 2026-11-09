// The launcher's icon, built from its pieces.
//
// The icon ships as four files: the whole logo, and then the three layers it
// is made of -- the rounded background, the gem, and the cog. Keeping them
// apart is what makes theming it possible at all, because each layer wants a
// different answer:
//
//   background   the theme's base colour, or a gradient, or the very picture
//                or block the launcher's background is made of
//   gem          the theme's second colour
//   cog          nothing. It is grey on purpose and stays grey.
//
// What came before worked on the finished logo and tried to tell the layers
// apart by colour: anything red enough was "the theme's", anything grey was
// "the cog". That is a guess, and it was wrong in both directions -- a grey
// theme turned the red parts grey and then they were indistinguishable from
// the cog, and the block option painted the block INTO the cog instead of
// behind the whole icon, which is how a cog ended up green and stayed green
// through every theme after.
//
// Recolouring keeps each pixel's own shading. A layer is lit and shaded, and
// the point is to change its colour, not to paint over it flat: every pixel
// keeps how much lighter or darker it is than its layer's average, and only
// the colour underneath that changes. That works for a grey, a white or a
// black theme as well as a red one, where rotating a hue towards a colour
// that has no hue did nothing at all.
import sharp from "sharp";

export const PART_FILES = {
  whole: "redstone_logo.png",
  background: "redstone_logo_background.png",
  gem: "redstone_logo_gem.png",
  cog: "redstone_logo_cog.png",
};

// ── colour ──
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map(v => Math.round(v * 255));
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function hexToRgb(hex) {
  const s = String(hex || "").replace("#", "").trim();
  const full = s.length === 3 ? s.split("").map(c => c + c).join("") : s;
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n) || full.length < 6) return [0, 0, 0];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── what a layer is filled with ──
//
//   { kind: "color",    hex }
//   { kind: "gradient", colors: [hex, ...], angle }   angle as CSS writes it
//   { kind: "texture",  png, pixelated }              a block or a picture
//
// A gradient of one colour is a flat colour, and a gradient of none is not a
// gradient at all -- both are worth saying rather than dividing by zero.
export function normaliseFill(fill) {
  if (!fill) return null;
  if (fill.kind === "gradient") {
    const colors = (fill.colors || []).filter(Boolean);
    if (!colors.length) return null;
    if (colors.length === 1) return { kind: "color", hex: colors[0] };
    return { kind: "gradient", colors, angle: Number.isFinite(fill.angle) ? fill.angle : 180 };
  }
  if (fill.kind === "texture") return fill.png ? fill : null;
  if (fill.kind === "color") return fill.hex ? fill : null;
  return null;
}

// Where a point falls along a CSS linear gradient's axis, from 0 to 1.
// CSS measures the angle clockwise from "up", so 180deg runs down the page --
// which is the default, and the one every gradient in the launcher uses.
function gradientT(x, y, w, h, angle) {
  const rad = (angle * Math.PI) / 180;
  const dx = Math.sin(rad), dy = -Math.cos(rad);
  // The axis is long enough to cover the whole box at any angle.
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const t = ((x - w / 2) * dx + (y - h / 2) * dy) / (len || 1) + 0.5;
  return clamp01(t);
}

function gradientAt(t, stops) {
  const span = 1 / (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(t / span));
  const f = (t - i * span) / span;
  const a = stops[i], b = stops[i + 1];
  return [0, 1, 2].map(k => Math.round(a[k] + (b[k] - a[k]) * f));
}

// The fill, as a flat RGB buffer the size of the icon.
async function fillPixels(fill, size) {
  const px = Buffer.alloc(size * size * 3);
  if (fill.kind === "color") {
    const [r, g, b] = hexToRgb(fill.hex);
    for (let i = 0; i < px.length; i += 3) { px[i] = r; px[i + 1] = g; px[i + 2] = b; }
    return px;
  }
  if (fill.kind === "gradient") {
    const stops = fill.colors.map(hexToRgb);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = gradientAt(gradientT(x, y, size, size, fill.angle), stops);
        const i = (y * size + x) * 3;
        px[i] = r; px[i + 1] = g; px[i + 2] = b;
      }
    }
    return px;
  }
  // A texture. A block is sixteen pixels across and the icon is hundreds, so
  // it is scaled without smoothing -- a blurred block reads as a smudge.
  const tex = await sharp(fill.png)
    .resize(size, size, { fit: "cover", kernel: fill.pixelated === false ? "lanczos3" : "nearest" })
    .removeAlpha().raw().toBuffer();
  return tex;
}

// Recolour one layer to `fill`, keeping its own light and shade.
//
// Each pixel keeps how far its lightness sits from its layer's average, and
// that offset is carried onto the fill's colour. Nothing is judged by hue, so
// this does the right thing whatever colour the layer happens to be and
// whatever colour it is being turned into.
export async function shadeLayer(layerPng, fill, size, opts = {}) {
  const want = normaliseFill(fill);
  const base = sharp(layerPng).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  const { data } = await base.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (!want) return data;                       // untouched: this is the cog

  // The layer's own average lightness, over the pixels that are actually
  // there. Taking it over the whole square would drag it towards zero with
  // every transparent pixel and wash the layer out.
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    sum += rgbToHsl(data[i], data[i + 1], data[i + 2])[2];
    n++;
  }
  const mean = n ? sum / n : 0.5;

  // How light the colour is that this layer was DRAWN for.
  //
  // Without it, the layer is re-centred on the fill colour's own lightness:
  // every pixel keeps its distance from the layer's average, and the average
  // becomes whatever the theme colour happens to be. The launcher's own
  // backing is drawn at a lightness of about 0.21 and its base colour is
  // 0.375, so painting the backing in the launcher's OWN colour came out
  // nearly twice as light as the artwork -- and every other theme was
  // brightened by the same amount, which is why the backing and the gem
  // always looked lit up.
  //
  // With it, the fill's lightness is read as a DIFFERENCE from the colour
  // the layer was drawn for: the same colour reproduces the artwork exactly,
  // a lighter one lightens it by as much as it is lighter, and a darker one
  // darkens it. Nothing is judged by hue, so this is still right for a
  // layer of any colour being turned into any other.
  const anchor = Number.isFinite(opts.anchor) ? opts.anchor : null;

  const px = await fillPixels(want, size);
  const out = Buffer.from(data);
  for (let i = 0, p = 0; i < out.length; i += 4, p += 3) {
    if (out[i + 3] < 8) continue;
    const l = rgbToHsl(out[i], out[i + 1], out[i + 2])[2];
    const [fh, fs, fl] = rgbToHsl(px[p], px[p + 1], px[p + 2]);
    const want_l = anchor == null ? fl + (l - mean) : l + (fl - anchor);
    const [r, g, b] = hslToRgb(fh, fs, clamp01(want_l));
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
}

/** How light a colour is, for use as an anchor. */
export function lightnessOf(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b)[2];
}

// Lay one RGBA buffer over another, in place.
function over(under, above) {
  for (let i = 0; i < under.length; i += 4) {
    const a = above[i + 3] / 255;
    if (a <= 0) continue;
    if (a >= 1) { under[i] = above[i]; under[i + 1] = above[i + 1]; under[i + 2] = above[i + 2]; under[i + 3] = 255; continue; }
    const b = under[i + 3] / 255;
    const outA = a + b * (1 - a);
    for (let k = 0; k < 3; k++) {
      under[i + k] = Math.round((above[i + k] * a + under[i + k] * b * (1 - a)) / (outA || 1));
    }
    under[i + 3] = Math.round(outA * 255);
  }
}

// The whole icon: background, then gem, then the cog on top of both.
//
// `layers` holds the three PNGs; `fills` says what the first two are made of.
// A layer with no fill is drawn as it is, which is what the cog always wants
// and what every layer wants when the icon is left plain.
export async function buildIcon(layers, fills = {}, size = 256, anchors = {}) {
  const background = await shadeLayer(layers.background, fills.background, size, { anchor: anchors.background });
  const gem = await shadeLayer(layers.gem, fills.gem, size, { anchor: anchors.gem });
  const cog = await shadeLayer(layers.cog, null, size);
  over(background, gem);
  over(background, cog);
  return sharp(background, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

export default { PART_FILES, buildIcon, shadeLayer, normaliseFill, hexToRgb, rgbToHsl, hslToRgb, lightnessOf };
