// Converting a skin between the wide (Steve) and slim (Alex) models.
//
// The two are not the same picture with a different label on it: a slim arm
// is three pixels across where a wide one is four, so the arm's faces sit at
// different places in the texture and the front and back faces are a column
// narrower. Changing which model a skin "is" without moving those pixels
// leaves the arms unwrapped from the wrong parts of the image -- the back of
// the arm showing a slice of the front, and a column of the texture that the
// game never reads.
//
// WHICH column an arm loses was not guessed. Mojang ship the same nine
// characters in both models, drawn by their own artists, so the answer is in
// the client jar: comparing wide/<name>.png with slim/<name>.png across all
// nine says, with six votes to one and no dissent that forms a run of three,
// that the right arm's front face keeps columns 1,2,3 and the left arm's
// keeps 0,1,2. The arm narrows on the side facing the body, and the back
// faces mirror the front ones. Which is what the geometry says it should be.
//
// Everything outside the four arm boxes is untouched.

// A box of w x h x d at (u,v) unwraps as:
//   top (u+d, v, w, d)         bottom (u+d+w, v, w, d)
//   right (u, v+d, d, h)       front  (u+d, v+d, w, h)
//   left (u+d+w, v+d, d, h)    back   (u+2d+w, v+d, w, h)
// An arm is w x 12 x 4, so d = 4 and h = 12.
function armFaces(u, v, w) {
  return {
    top: [u + 4, v, w, 4],
    bottom: [u + 4 + w, v, w, 4],
    right: [u, v + 4, 4, 12],
    front: [u + 4, v + 4, w, 12],
    left: [u + 4 + w, v + 4, 4, 12],
    back: [u + 8 + w, v + 4, w, 12],
  };
}

// The four arm boxes of a 64x64 skin.
const ARMS = [
  { u: 40, v: 16, right: true },   // right arm, base
  { u: 40, v: 32, right: true },   // right arm, sleeve
  { u: 32, v: 48, right: false },  // left arm, base
  { u: 48, v: 48, right: false },  // left arm, sleeve
];

// Which end of a narrowing face is dropped: true to leave out its FIRST
// column, false for its last.
//
// Measured, not reasoned about. Each face's two possible answers were scored
// against Mojang's own slim art across all nine characters, and this is what
// won:
//
//   face     drop first   drop last
//   R top        73.1%       59.3%
//   R front      92.0%       63.0%
//   R back       62.3%       85.5%
//   R bottom     74.1%       72.2%
//   L top        42.6%       96.3%
//   L front      54.9%       97.8%
//   L back       80.9%       67.0%
//   L bottom     74.1%       69.4%
//
// The front and back faces are a clean mirror -- each arm narrows on the side
// facing the body -- and the top follows its own arm's front. The BOTTOM does
// not mirror: both arms drop its first column. The margin there is only a few
// points, because an arm's underside is nearly flat skin tone and the artists
// had little to choose between, but it is the same way round on both arms in
// every character that shows a difference at all.
const DROPS_FIRST = {
  right: { top: true, front: true, bottom: true, back: false },
  left: { top: false, front: false, bottom: true, back: true },
};

const idx = (w, x, y) => (y * w + x) * 4;

function blitColumn(src, dst, w, sx, sy, dx, dy, h) {
  for (let i = 0; i < h; i++) {
    const a = idx(w, sx, sy + i), b = idx(w, dx, dy + i);
    dst[b] = src[a]; dst[b + 1] = src[a + 1]; dst[b + 2] = src[a + 2]; dst[b + 3] = src[a + 3];
  }
}
function clearRect(buf, w, x, y, rw, rh) {
  for (let j = 0; j < rh; j++) {
    for (let i = 0; i < rw; i++) {
      const o = idx(w, x + i, y + j);
      buf[o] = 0; buf[o + 1] = 0; buf[o + 2] = 0; buf[o + 3] = 0;
    }
  }
}

/**
 * Convert raw RGBA between the two models, in place on a copy.
 *
 * `data` is a 64x64 (or 64x32) RGBA buffer; `to` is "slim" or "classic".
 * A 64x32 skin has no second layer and no separate left arm -- the game
 * mirrors the right one -- and the slim model did not exist when that format
 * did, so it is returned untouched and the caller should leave it wide.
 *
 * Returns a NEW buffer, or null when there is nothing to do.
 */
export function convertSkinPixels(data, width, height, to) {
  if (width !== 64 || height < 64) return null;      // 64x32: not a slim skin
  const slim = to === "slim";
  const out = Buffer.from(data);

  for (const arm of ARMS) {
    const wide = armFaces(arm.u, arm.v, 4);
    const narrow = armFaces(arm.u, arm.v, 3);
    const drops = DROPS_FIRST[arm.right ? "right" : "left"];
    const from = slim ? wide : narrow;
    const to_ = slim ? narrow : wide;

    // Every source column is read out FIRST. The faces move past each other —
    // the left face slides over the column the front face still needs, and the
    // back face lands where the left one was — so copying them one at a time
    // overwrites a column before it has been read.
    const held = {};
    for (const face of ["top", "bottom", "right", "front", "left", "back"]) {
      const [sx, sy, fw, fh] = from[face];
      const cols = [];
      for (let i = 0; i < fw; i++) {
        const c = Buffer.alloc(fh * 4);
        for (let y = 0; y < fh; y++) {
          const o = idx(width, sx + i, sy + y);
          c[y * 4] = data[o]; c[y * 4 + 1] = data[o + 1];
          c[y * 4 + 2] = data[o + 2]; c[y * 4 + 3] = data[o + 3];
        }
        cols.push(c);
      }
      held[face] = cols;
    }
    const put = (col, dx, dy, fh) => {
      for (let y = 0; y < fh; y++) {
        const o = idx(width, dx, dy + y);
        out[o] = col[y * 4]; out[o + 1] = col[y * 4 + 1];
        out[o + 2] = col[y * 4 + 2]; out[o + 3] = col[y * 4 + 3];
      }
    };

    // What the narrower model stops using has to go, or the pixel test that
    // decides whether a skin IS slim — which reads exactly there — would
    // still say wide.
    if (slim) {
      clearRect(out, width, arm.u + 10, arm.v, 2, 4);        // past top + bottom
      clearRect(out, width, arm.u + 14, arm.v + 4, 2, 12);   // past the back face
    }

    // The side faces are four deep in both models; they only move.
    for (const face of ["right", "left"]) {
      const [, , fw, fh] = from[face];
      const [dx, dy] = to_[face];
      for (let i = 0; i < fw; i++) put(held[face][i], dx + i, dy, fh);
    }

    // The four faces that change width.
    for (const face of ["top", "bottom", "front", "back"]) {
      const [, , sw, fh] = from[face];
      const [dx, dy, dw] = to_[face];
      if (slim) {
        // Four columns to three: leave out the one nearest the body.
        const skip = drops[face] ? 0 : sw - 1;
        let k = 0;
        for (let i = 0; i < sw; i++) {
          if (i === skip) continue;
          put(held[face][i], dx + (k++), dy, fh);
        }
      } else {
        // Three columns to four: the one that was dropped comes back as a
        // copy of the edge it was taken from, so narrowing it again gives
        // back exactly the skin that went in.
        for (let i = 0; i < dw; i++) {
          const si = drops[face] ? Math.max(0, i - 1) : Math.min(sw - 1, i);
          put(held[face][si], dx + i, dy, fh);
        }
      }
    }
  }
  return out;
}

/**
 * Is this a slim (3px-armed) texture, by its pixels? A wide skin fills the
 * last column of each arm's back face; a slim one has nothing there.
 * Deliberately the same test the rest of the launcher uses.
 */
export function slimFromPixels(data, w, h) {
  if (w < 64 || h < 64) return false;
  let transparent = 0, total = 0;
  for (let y = 20; y < 32; y++) { total++; if (data[idx(w, 55, y) + 3] < 8) transparent++; }
  return total > 0 && transparent / total > 0.75;
}

export default { convertSkinPixels, slimFromPixels };
