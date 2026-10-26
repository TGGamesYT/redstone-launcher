// A Totem of Undying wearing somebody's skin.
//
// This is the totem tool from tggamesyt.github.io/totem, ported as it stands.
// Every draw is kept in its original order and at its original coordinates,
// because the result is a hand-made arrangement of a skin's pixels and
// changing any one of them changes the totem: the head, a body cut from four
// one-pixel rows of the torso, legs, arms built pixel by pixel down each
// side, and then the overlay layers (hat, jacket, sleeves) drawn over the top
// for a 64x64 skin.
//
// The original draws on a 2D canvas, which composites source-over. There is
// no canvas here, so the same compositing is done on the raw pixels: an
// opaque pixel replaces what is under it and a part-transparent one blends,
// which is what makes a hat with holes in it work.
//
// A 64x32 skin has no overlay layers and no left arm or leg of its own, so
// the right ones are mirrored for it -- the `img.height > 32` branches in the
// original, kept here as `tall`.

// One rectangle of pixels, composited over the destination the way a canvas
// would. Every draw in the original is 1:1 -- no scaling anywhere -- so this
// is all that is needed.
function blit(dst, dstW, dstH, src, srcW, srcH, sx, sy, sw, sh, dx, dy) {
  for (let y = 0; y < sh; y++) {
    const syy = sy + y, dyy = dy + y;
    if (syy < 0 || syy >= srcH || dyy < 0 || dyy >= dstH) continue;
    for (let x = 0; x < sw; x++) {
      const sxx = sx + x, dxx = dx + x;
      if (sxx < 0 || sxx >= srcW || dxx < 0 || dxx >= dstW) continue;
      const si = (syy * srcW + sxx) * 4;
      const di = (dyy * dstW + dxx) * 4;
      const sa = src[si + 3] / 255;
      if (sa <= 0) continue;                       // nothing to draw
      if (sa >= 1) {
        dst[di] = src[si]; dst[di + 1] = src[si + 1];
        dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
        continue;
      }
      // source-over
      const da = dst[di + 3] / 255;
      const out = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) {
        dst[di + c] = Math.round((src[si + c] * sa + dst[di + c] * da * (1 - sa)) / (out || 1));
      }
      dst[di + 3] = Math.round(out * 255);
    }
  }
}

function clearRect(dst, dstW, dstH, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    if (yy < 0 || yy >= dstH) continue;
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || xx >= dstW) continue;
      const i = (yy * dstW + xx) * 4;
      dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0;
    }
  }
}

// `fillStyle = "rgba(255, 0, 0, 0.005)"; fillRect(10, 15, 1, 1)` in the
// original: a red pixel so faint it cannot be seen, which the game needs in
// order not to treat the corner as empty. 0.005 of 255 rounds to 1.
function fillFaint(dst, dstW, dstH, x, y) {
  const px = Uint8Array.from([255, 0, 0, 1]);
  blit(dst, dstW, dstH, px, 1, 1, 0, 0, 1, 1, x, y);
}

/**
 * The 16x16 totem, as raw RGBA, from a skin as raw RGBA.
 *
 * `w`/`h` are the skin's size: 64x64 for a modern skin, 64x32 for an old one.
 */
export function totemPixels(skin, w, h) {
  const out = new Uint8Array(16 * 16 * 4);
  const tall = h > 32;
  const draw = (sx, sy, sw, sh, dx, dy) => blit(out, 16, 16, skin, w, h, sx, sy, sw, sh, dx, dy);

  // The head, with the two top corners knocked off.
  draw(8, 8, 8, 8, 4, 1);
  clearRect(out, 16, 16, 4, 1, 1, 1);
  clearRect(out, 16, 16, 11, 1, 1, 1);

  // The body: four single rows of the torso, spread down the totem.
  draw(20, 21, 8, 1, 4, 9);
  draw(20, 23, 8, 1, 4, 10);
  draw(20, 29, 8, 1, 4, 11);
  draw(20, 31, 8, 1, 4, 12);

  // The legs.
  draw(5, 20, 3, 2, 5, 13);
  draw(6, 31, 2, 1, 6, 15);
  if (tall) {
    draw(20, 52, 3, 2, 8, 13);
    draw(20, 63, 2, 1, 8, 15);
  } else {
    draw(7, 20, 3, 2, 8, 13);
    draw(7, 31, 2, 1, 8, 15);
  }

  // The right arm, a pixel at a time down the side.
  draw(44, 20, 1, 1, 3, 8);
  draw(45, 20, 1, 1, 3, 9);
  draw(46, 20, 1, 1, 3, 10);
  draw(44, 21, 1, 1, 2, 8);
  draw(45, 21, 1, 1, 2, 9);
  draw(46, 21, 1, 1, 2, 10);
  draw(44, 31, 1, 1, 1, 8);
  draw(45, 31, 1, 1, 1, 9);
  fillFaint(out, 16, 16, 10, 15);

  // The left arm: its own on a 64x64 skin, the right one mirrored otherwise.
  if (tall) {
    draw(39, 52, 1, 1, 12, 8);
    draw(38, 52, 1, 1, 12, 9);
    draw(37, 52, 1, 1, 12, 10);
    draw(39, 53, 1, 1, 13, 8);
    draw(38, 53, 1, 1, 13, 9);
    draw(37, 53, 1, 1, 13, 10);
    draw(37, 63, 1, 1, 14, 8);
    draw(38, 63, 1, 1, 14, 9);
  } else {
    draw(44, 20, 1, 1, 12, 8);
    draw(45, 20, 1, 1, 12, 9);
    draw(46, 20, 1, 1, 12, 10);
    draw(44, 21, 1, 1, 13, 8);
    draw(45, 21, 1, 1, 13, 9);
    draw(46, 21, 1, 1, 13, 10);
    draw(46, 31, 1, 1, 14, 8);
    draw(45, 31, 1, 1, 14, 9);
  }

  // The hat, over the face.
  draw(40, 8, 8, 8, 4, 1);

  // And on a 64x64 skin, the rest of the overlay: sleeves, jacket, trousers.
  if (tall) {
    draw(44, 36, 1, 1, 3, 8);
    draw(45, 36, 1, 1, 3, 9);
    draw(46, 36, 1, 1, 3, 10);
    draw(44, 37, 1, 1, 2, 8);
    draw(45, 37, 1, 1, 2, 9);
    draw(46, 37, 1, 1, 2, 10);
    draw(44, 47, 1, 1, 1, 8);
    draw(45, 47, 1, 1, 1, 9);
    draw(55, 52, 1, 1, 12, 8);
    draw(54, 52, 1, 1, 12, 9);
    draw(53, 52, 1, 1, 12, 10);
    draw(55, 53, 1, 1, 13, 8);
    draw(54, 53, 1, 1, 13, 9);
    draw(53, 53, 1, 1, 13, 10);
    draw(53, 63, 1, 1, 14, 8);
    draw(54, 63, 1, 1, 14, 9);
    draw(20, 37, 8, 1, 4, 9);
    draw(20, 39, 8, 1, 4, 10);
    draw(20, 45, 8, 1, 4, 11);
    draw(20, 47, 8, 1, 4, 12);
    draw(5, 36, 3, 2, 5, 13);
    draw(6, 47, 2, 1, 6, 15);
    draw(4, 52, 3, 2, 8, 13);
    draw(4, 63, 2, 1, 8, 15);
  }

  return out;
}

// What the pack says about itself. The same as the original tool writes, so a
// pack made here and one downloaded from the site are the same pack.
export const TOTEM_PACK_MCMETA = {
  pack: {
    pack_format: 1,
    supported_formats: { min_inclusive: 1, max_inclusive: 100 },
    description: "§7Custom Java §cTotem of Undying§7 Pack!",
  },
};
export const TOTEM_TEXTURE_PATH = "assets/minecraft/textures/item/totem_of_undying.png";

export default { totemPixels, TOTEM_PACK_MCMETA, TOTEM_TEXTURE_PATH };
