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

// ── a space where "lighter" means lighter ────────────────────────────────
//
// HSL is a convenience, not a model of sight. Its "lightness" is the midpoint
// of the largest and smallest channel, which puts yellow and blue at the same
// L while yellow is plainly far brighter -- so carrying a layer's shading
// across to another colour in HSL carries the NUMBERS and not the shading. A
// gem whose highlight is a lighter, slightly orange red becomes, in blue, a
// pixel with the same L and a hue 200-odd degrees round: still dark, and no
// longer reading as a highlight at all. That is the "it just looks like a
// desaturated dark blue" of it.
//
// Oklab is a space built so that equal steps look like equal steps, and its
// polar form (lightness, chroma, hue) is the one that says what a recolouring
// means: keep how much lighter this pixel is, keep how much more colourful it
// is, and turn the hue. Done there, a highlight stays a highlight whatever
// colour the gem is turned into.
//
// https://bottosson.github.io/posts/oklab/
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const linearToSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** 0-255 RGB to Oklab's lightness, chroma and hue (hue in degrees). */
export function rgbToOklch(r, g, b) {
  const lr = srgbToLinear(r / 255), lg = srgbToLinear(g / 255), lb = srgbToLinear(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.hypot(A, B);
  const h = C < 1e-7 ? 0 : (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;
  return [L, C, h];
}

/** The raw conversion back, which may land outside what a screen can show. */
function oklchToRgbRaw(L, C, h) {
  const rad = (h * Math.PI) / 180;
  const A = C * Math.cos(rad), B = C * Math.sin(rad);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.2914855480 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  ];
}

/**
 * Oklab back to 0-255 RGB, kept inside what a screen can actually show.
 *
 * A colour asked for in this space can be more colourful than sRGB reaches --
 * a bright theme colour carried onto an already-vivid pixel, say. Clipping
 * the three channels where they land would change the hue as well as the
 * chroma (the channel that overflows is pulled back and the others are not),
 * so the chroma is lowered instead, which is the part that cannot be shown,
 * until it fits. The lightness and the hue are what the eye is reading, and
 * both survive.
 */
export function oklchToRgb(L, C, h) {
  const fits = (rgb) => rgb.every((c) => c >= -0.0001 && c <= 1.0001);
  let rgb = oklchToRgbRaw(L, C, h);
  if (!fits(rgb)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (fits(oklchToRgbRaw(L, mid, h))) lo = mid; else hi = mid;
    }
    rgb = oklchToRgbRaw(L, lo, h);
  }
  return rgb.map((c) => Math.max(0, Math.min(255, Math.round(c * 255))));
}

/** A hex colour in Oklab's polar form. */
export function oklchOf(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToOklch(r, g, b);
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
// What a fill looks like, pixel by pixel, as RGBA.
//
// RGBA rather than RGB because of what a transparent fill used to do. A
// picture is read with `removeAlpha`, which does not flatten the picture
// onto anything -- it simply drops the alpha channel and leaves whatever RGB
// was underneath it, and in almost every PNG the colour under a transparent
// pixel is 0,0,0. So a picture with a hole in it, or a block texture with
// one, came out of the icon as BLACK: not see-through, not the colour behind
// it, black. And it was opaque black, so there was nothing to fix further
// down either.
//
// A colour and a gradient are opaque by their nature and say so; a picture
// brings its own alpha, which the layer then has to respect.
async function fillPixels(fill, size) {
  const px = Buffer.alloc(size * size * 4);
  if (fill.kind === "color") {
    const [r, g, b] = hexToRgb(fill.hex);
    for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; }
    return px;
  }
  if (fill.kind === "gradient") {
    const stops = fill.colors.map(hexToRgb);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const [r, g, b] = gradientAt(gradientT(x, y, size, size, fill.angle), stops);
        const i = (y * size + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
      }
    }
    return px;
  }
  // A texture. A block is sixteen pixels across and the icon is hundreds, so
  // it is scaled without smoothing -- a blurred block reads as a smudge.
  return sharp(fill.png)
    .resize(size, size, { fit: "cover", kernel: fill.pixelated === false ? "lanczos3" : "nearest" })
    .ensureAlpha().raw().toBuffer();
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

  // The colour this layer was DRAWN for.
  //
  // Without it, a layer is re-centred on the fill colour: every pixel keeps
  // its distance from the layer's average LIGHTNESS, and then takes the
  // fill's hue and the fill's saturation outright. Two things go wrong with
  // that, and both of them show.
  //
  // The lightness: the backing is drawn at about 0.21 and the launcher's
  // base colour is 0.375, so painting the backing in the launcher's OWN
  // colour came out nearly twice as light as the artwork, and every other
  // theme was lifted by the same amount.
  //
  // The saturation, which is the subtler half: the backing is drawn fully
  // saturated and the base colour is 0.874, so every pixel of it lost a
  // tenth of its colour -- and at a fixed lightness, less saturation is
  // nearer to grey and reads as LIGHTER, on top of being flatter. The gem is
  // worse: its facets differ from each other in saturation as much as in
  // lightness, and giving them all one saturation is what makes them run
  // together instead of reading as facets.
  //
  // With an anchor, the fill is read as a DIFFERENCE from the colour the
  // layer was drawn for, and that difference is applied to each pixel's own
  // hue, saturation and lightness. The same colour therefore gives the
  // artwork back pixel for pixel; another colour moves all of it by as much
  // as that colour differs, so every difference WITHIN the layer survives.
  // Measured in Oklab, not HSL, so that "as much lighter as it was" means as
  // much lighter TO THE EYE. HSL puts yellow and blue at the same lightness,
  // so a highlight that is a lighter, warmer red came out of a blue theme
  // with the same L, a hue most of the way round the circle, and nothing
  // left that read as a highlight -- still dark, just bluer.
  const anchor = opts.anchor ? oklchOf(opts.anchor) : null;

  const px = await fillPixels(want, size);
  const out = Buffer.from(data);

  // A picture goes in as it is.
  //
  // Recolouring carries the layer's own light and shade onto the fill, which
  // is what a layer being made a COLOUR wants. A block's texture, or the very
  // picture the launcher is wearing behind it, is not a colour: it has its
  // own light and shade already, and laying the backing's on top of it tints
  // and darkens a picture that was meant to show as itself. So a texture is
  // only cut to the shape of the layer.
  if (want.kind === "texture") {
    for (let i = 0; i < out.length; i += 4) {
      if (out[i + 3] < 8) continue;
      out[i] = px[i]; out[i + 1] = px[i + 1]; out[i + 2] = px[i + 2];
      // Where the picture is see-through, so is the icon. The layer's shape
      // still decides the outline -- the two alphas multiply -- so a hole in
      // the picture shows through the icon and the picture is still cut to
      // the backing's shape.
      out[i + 3] = Math.round(out[i + 3] * (px[i + 3] / 255));
    }
    return out;
  }

  for (let i = 0, p = 0; i < out.length; i += 4, p += 4) {
    if (out[i + 3] < 8) continue;
    let r, g, b;
    if (anchor) {
      const [fL, fC, fh] = rgbToOklch(px[p], px[p + 1], px[p + 2]);
      const dL = fL - anchor[0], dC = fC - anchor[1], dh = fh - anchor[2];
      // Asked for the very colour the layer was drawn for: there is nothing
      // to change, so nothing is changed. Said outright rather than left to
      // come out in the arithmetic, because "the launcher's own colours give
      // the artwork back" should be exact and not nearly.
      if (Math.abs(dL) < 1e-6 && Math.abs(dC) < 1e-6 && Math.abs(dh) < 1e-6) continue;
      // The hue is the fill's, flat. The lightness and the chroma keep each
      // pixel's own distance from the colour the layer was drawn for.
      //
      // Turning every pixel's hue by the same amount sounds right and is
      // not, because the hue circle is not evenly divided between colours
      // anybody can name. The gem's body sits at hue 25 and its lit facets
      // at 35 to 40 -- ten to fifteen degrees warmer, which in red reads as
      // orange, the colour a lit red stone is. Carry that same offset round
      // to blue and the body lands on 251, which is blue, while the facets
      // land on 266 to 271, which is indigo: the lightest parts of a blue
      // gem came out a different colour from the rest of it.
      //
      // A highlight does not need a hue of its own to read as one. It is
      // lighter and it is less colourful, and both of those travel to any
      // colour without turning into something else -- so they are what is
      // carried, and the hue is simply the one that was asked for.
      const [L, C] = rgbToOklch(out[i], out[i + 1], out[i + 2]);
      [r, g, b] = oklchToRgb(
        Math.max(0, Math.min(1, L + dL)),
        Math.max(0, C + dC),
        fh,
      );
    } else {
      const l = rgbToHsl(out[i], out[i + 1], out[i + 2])[2];
      const [fh, fs, fl] = rgbToHsl(px[p], px[p + 1], px[p + 2]);
      [r, g, b] = hslToRgb(fh, fs, clamp01(fl + (l - mean)));
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
}

/** How light a colour is. */
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
// A layer that was left out is left out.
//
// Turning the gem and the cog off is done by not passing their files at
// all -- the backing on its own is the whole icon. But both were handed to
// sharp regardless, and sharp given `undefined` throws "Invalid input", so
// the icon was never built: the call failed, the old file stayed where it
// was, and turning the mark off looked like a switch that did nothing. It
// was reported twice, once for a picture and once for a colour, because the
// mark never came off either.
export async function buildIcon(layers, fills = {}, size = 256, anchors = {}) {
  if (!layers || !layers.background) throw new Error("An icon needs its backing");
  const background = await shadeLayer(layers.background, fills.background, size, { anchor: anchors.background });
  if (layers.gem) over(background, await shadeLayer(layers.gem, fills.gem, size, { anchor: anchors.gem }));
  if (layers.cog) over(background, await shadeLayer(layers.cog, null, size));
  return sharp(background, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

export default { PART_FILES, buildIcon, shadeLayer, normaliseFill, hexToRgb, rgbToHsl, hslToRgb, lightnessOf, rgbToOklch, oklchToRgb, oklchOf };
