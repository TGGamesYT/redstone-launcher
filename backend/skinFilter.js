/**
 * Content screening for browsed skins.
 *
 * The skin gallery we browse (MineSkin) is an upload mirror with no moderation,
 * and filtering on the NAME is trivially defeated by calling a swastika skin
 * "cool_skin_2". So this looks at the texture itself.
 *
 * What it can do:
 *   - find a swastika drawn anywhere on the 64x64 texture, at any size, colour,
 *     rotation or handedness, by matching against rasterised templates;
 *   - spot a nude body (bare torso AND bare legs in the same skin tone as the
 *     face, with no second layer covering them).
 *
 * What it cannot do: understand a picture. This catches the two things that
 * actually flood an unmoderated Minecraft skin gallery; it is not a general
 * content classifier, and anything it misses is meant to be caught by the
 * viewer hiding it, which is remembered from then on.
 */

// ── Swastika templates ──────────────────────────────────────────────────────
// Rasterised rather than hand-drawn so rotations come for free: four arms from
// the centre at angle + k*90°, each bending 90° at its tip. Handedness is which
// way the bend goes.
function blankGrid(n) { return Array.from({ length: n }, () => new Uint8Array(n)); }

function drawLine(g, x0, y0, x1, y1) {
  const n = g.length;
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2 + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + (x1 - x0) * t);
    const y = Math.round(y0 + (y1 - y0) * t);
    if (x >= 0 && y >= 0 && x < n && y < n) g[y][x] = 1;
  }
}

function rasterSwastika(size, angle, mirror) {
  const g = blankGrid(size);
  const c = (size - 1) / 2;
  const arm = c;                                   // centre out to the edge
  const bend = Math.max(2, Math.round(size * 0.42)); // the bent tip
  for (let k = 0; k < 4; k++) {
    const a = angle + k * Math.PI / 2;
    const tx = c + Math.cos(a) * arm, ty = c + Math.sin(a) * arm;
    drawLine(g, c, c, tx, ty);
    const b = a + (mirror ? -Math.PI / 2 : Math.PI / 2);
    drawLine(g, tx, ty, tx + Math.cos(b) * bend, ty + Math.sin(b) * bend);
  }
  return g;
}

// A template is the "on" pixels plus the "off" pixels of its bounding box. The
// off set is what stops a solid block of colour matching everything.
function compileTemplate(g) {
  const n = g.length;
  const on = [], off = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) (g[y][x] ? on : off).push(y * n + x);
  return { n, on, off };
}

const SWASTIKA_TEMPLATES = (() => {
  const seen = new Set(), out = [];
  const D = Math.PI / 180;
  // Cover 30° too even at the small sizes -- a 5x5 or 7x7 template at 30°
  // degenerates to something similar to the 0° or 45° one, but a couple of
  // rows shift by one pixel, which the on-mask check counts as a miss.
  for (const size of [5, 7, 9, 11, 13]) {
    const angles = size >= 9 ? [0, 30 * D, 45 * D, 60 * D] : [0, 30 * D, 45 * D];
    for (const angle of angles) {
      for (const mirror of [false, true]) {
        const g = rasterSwastika(size, angle, mirror);
        const key = size + ":" + g.map(r => r.join("")).join("");
        if (seen.has(key)) continue;                 // rotations collide at small sizes
        seen.add(key);
        const t = compileTemplate(g);
        if (t.on.length >= 12) out.push(t);          // too sparse to be meaningful
      }
    }
  }
  return out;
})();

// ── Matching ────────────────────────────────────────────────────────────────
const MATCH_ON = 0.90;   // at least this much of the symbol must be drawn
const MATCH_OFF = 0.25;  // at most this much of the surrounding box may be too

// Summed-area table over a 0/1 mask, for O(1) "how many set pixels in this box".
function buildSAT(mask, w, h) {
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += mask[y * w + x];
      sat[(y + 1) * (w + 1) + (x + 1)] = sat[y * (w + 1) + (x + 1)] + row;
    }
  }
  return sat;
}
function satBox(sat, w, x, y, n) {
  const W = w + 1;
  return sat[(y + n) * W + (x + n)] - sat[y * W + (x + n)] - sat[(y + n) * W + x] + sat[y * W + x];
}

/**
 * Look for a swastika in one single-colour mask.
 * The summed-area table rejects almost every position on a count check before
 * any template pixel is touched, which is what keeps this cheap enough to run
 * over every colour in every skin of a page.
 */
function maskHasSwastika(mask, w, h) {
  const sat = buildSAT(mask, w, h);
  const total = satBox(sat, w, 0, 0, Math.min(w, h)) || mask.reduce((a, b) => a + b, 0);
  if (total < 12) return false;
  for (const t of SWASTIKA_TEMPLATES) {
    const n = t.n;
    if (n > w || n > h) continue;
    const need = t.on.length;
    const lo = Math.ceil(need * MATCH_ON);
    const hi = need + Math.floor(t.off.length * MATCH_OFF);
    for (let y = 0; y + n <= h; y++) {
      for (let x = 0; x + n <= w; x++) {
        const count = satBox(sat, w, x, y, n);
        if (count < lo || count > hi) continue;      // cheap reject
        let onHit = 0;
        for (const idx of t.on) {
          const py = y + ((idx / n) | 0), px = x + (idx % n);
          onHit += mask[py * w + px];
        }
        if (onHit < lo) continue;
        let offHit = 0;
        const offMax = Math.floor(t.off.length * MATCH_OFF);
        for (const idx of t.off) {
          const py = y + ((idx / n) | 0), px = x + (idx % n);
          offHit += mask[py * w + px];
          if (offHit > offMax) break;
        }
        if (offHit <= offMax) return true;
      }
    }
  }
  return false;
}

// Quantise to 5 bits per channel so anti-aliased or dithered symbol pixels stay
// one colour, and ignore anything transparent.
const colorKey = (r, g, b) => ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);

function hasHateSymbol(rgba, w, h) {
  const counts = new Map();
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (rgba[p + 3] < 128) continue;
    const k = colorKey(rgba[p], rgba[p + 1], rgba[p + 2]);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [key, n] of counts) {
    // A symbol needs enough pixels to be one, and a colour covering most of the
    // texture is the background, not a drawing.
    if (n < 12 || n > w * h * 0.5) continue;
    const mask = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      if (rgba[p + 3] < 128) continue;
      if (colorKey(rgba[p], rgba[p + 1], rgba[p + 2]) === key) mask[i] = 1;
    }
    if (maskHasSwastika(mask, w, h)) return true;
  }
  return false;
}

// ── Nudity ──────────────────────────────────────────────────────────────────
// Minecraft's UV layout is fixed, so the body parts are always in the same
// place. A nude skin is one whose torso AND legs are the same tone as the face,
// with no second layer drawn over them.
const UV = {
  forehead: [8, 8, 8, 3],     // head front, above the eyes
  torso: [20, 20, 8, 12],     // body front
  jacket: [20, 36, 8, 12],    // body front, 2nd layer
  legR: [4, 20, 4, 7],        // right leg front, thigh
  legL: [20, 52, 4, 7],       // left leg front, thigh
  legROver: [4, 36, 4, 7],    // and their 2nd layers
  legLOver: [4, 52, 4, 7],
};

function px(rgba, w, x, y) { const p = (y * w + x) * 4; return [rgba[p], rgba[p + 1], rgba[p + 2], rgba[p + 3]]; }

function regionStats(rgba, w, rect) {
  const [rx, ry, rw, rh] = rect;
  let n = 0, opaque = 0, r = 0, g = 0, b = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
    const [pr, pg, pb, pa] = px(rgba, w, x, y);
    n++;
    if (pa < 128) continue;
    opaque++; r += pr; g += pg; b += pb;
  }
  return { n, opaque, avg: opaque ? [r / opaque, g / opaque, b / opaque] : null };
}

function fractionNear(rgba, w, rect, tone, tol) {
  const [rx, ry, rw, rh] = rect;
  let hit = 0, n = 0;
  for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) {
    const [pr, pg, pb, pa] = px(rgba, w, x, y);
    if (pa < 128) continue;
    n++;
    const d = Math.abs(pr - tone[0]) + Math.abs(pg - tone[1]) + Math.abs(pb - tone[2]);
    if (d <= tol) hit++;
  }
  return n ? hit / n : 0;
}

function isNude(rgba, w, h) {
  if (w < 64 || h < 32) return false;
  const face = regionStats(rgba, w, UV.forehead);
  if (!face.avg) return false;
  // Clothes drawn on the second layer mean the body underneath doesn't matter.
  const jacket = regionStats(rgba, w, UV.jacket);
  if (jacket.opaque > jacket.n * 0.5) return false;
  if (h >= 64) {
    const lo = regionStats(rgba, w, UV.legROver), lo2 = regionStats(rgba, w, UV.legLOver);
    if (lo.opaque > lo.n * 0.5 || lo2.opaque > lo2.n * 0.5) return false;
  }
  const TOL = 60;
  const torso = fractionNear(rgba, w, UV.torso, face.avg, TOL);
  if (torso < 0.85) return false;
  // Bare chest alone is just shirtless. Bare legs too is the thing worth hiding.
  const legs = h >= 64
    ? Math.max(fractionNear(rgba, w, UV.legR, face.avg, TOL), fractionNear(rgba, w, UV.legL, face.avg, TOL))
    : fractionNear(rgba, w, UV.legR, face.avg, TOL);
  return legs >= 0.85;
}

/**
 * Screen one decoded skin texture.
 * `rgba` is raw RGBA, `w`x`h` (64x64, or 64x32 for very old skins).
 * Returns null when it's fine, or a short reason string when it isn't.
 */
function screenSkinPixels(rgba, w, h) {
  try {
    if (hasHateSymbol(rgba, w, h)) return "hate-symbol";
    if (isNude(rgba, w, h)) return "nudity";
  } catch { /* a texture we can't read is not a texture we can judge */ }
  return null;
}

export { screenSkinPixels, hasHateSymbol, isNude, rasterSwastika, SWASTIKA_TEMPLATES };
export default { screenSkinPixels, hasHateSymbol, isNude };
