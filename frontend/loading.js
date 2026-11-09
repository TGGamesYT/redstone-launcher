/**
 * The launcher's loading animation: four pistons round a square, firing in
 * turn and pushing a block of redstone one space ahead of them.
 *
 * A spinning CSS ring says "something is happening" in the same voice as
 * every other program. This says it in Minecraft's, out of Minecraft's own
 * textures, which are bundled (assets/blocks) so it draws with no connection
 * and before any version has been downloaded.
 *
 * The layout, as the four pistons sit at rest:
 *
 *     . R P .        R  a block of redstone
 *     P . . R        P  a piston facing the block beside it
 *     R . . P        .  nothing
 *     . P R .
 *
 * which has four-fold symmetry: turn it a quarter and it is itself again.
 * The top piston pushes left, the left one down, the bottom one right, the
 * right one up, so the motion goes round anticlockwise. When the top one
 * fires the row reads
 *
 *     R H P .        H  the piston's head, out ahead of it
 *
 * and the next piston starts extending at the moment that one starts coming
 * back, so there is always exactly one block moving.
 *
 *   Loading.mount(el, { size })   draw into el, returns { stop() }
 *   Loading.replace()             swap every CSS spinner on the page for one
 *
 * replace() runs by itself once the page is loaded, and again for spinners
 * added later, so a page gets this by including the script and nothing else.
 */
(function () {
  if (window.Loading) return;

  const CELLS = 4;
  const TEX = 16;                      // a Minecraft texture is 16 x 16
  const SIDE = CELLS * TEX;            // 64 px of texture space
  const CYCLE = 2000;                  // ms for all four to fire
  const QUARTER = CYCLE / 4;
  // How much of the WHOLE cycle a piston spends going out, and coming back.
  // A quarter each, which is half the cycle in all -- so by the time one is
  // halfway through, having just reached the end of its stroke, the next is
  // starting. One is always going out while another is coming back, which is
  // what makes it read as one thing going round rather than four taking
  // turns.
  const OUT = 0.25, BACK = 0.25;
  // A piston does not glide. In the game it is out in a couple of ticks and
  // stops dead, so the travel happens over the first part of its window, fast,
  // and for the rest of the window it simply stands there extended. Moving at
  // one speed across the whole window is what made it look like a slider being
  // dragged rather than something firing.
  const STROKE = 0.55;                 // of the window spent moving
  // Fast away, decelerating into the stop. A real piston arrives instantly;
  // flat out and a hard stop at 16px looks like a dropped frame, so it is
  // eased just enough to read as weight arriving.
  const fire = (u) => {
    const k = Math.min(1, Math.max(0, u) / STROKE);
    return 1 - Math.pow(1 - k, 3);
  };
  const ARM = 4;                       // the head's arm is 4 px across
  const FACE = 4;                      // and its wooden face 4 px deep

  // Only what can be seen from the side. The wooden face and the inner plate
  // are both end-on in this view, so neither is ever drawn (see frame()).
  const SRC = {
    side: 'assets/blocks/piston_side.png',
    redstone: 'assets/blocks/redstone_block.png',
  };

  // Where this script is, so the textures resolve from a page in any folder.
  const BASE = (() => {
    try {
      const me = document.currentScript && document.currentScript.src;
      return me ? me.slice(0, me.lastIndexOf('/') + 1) : '';
    } catch { return ''; }
  })();

  const images = {};
  let loaded = null;
  function loadTextures() {
    if (loaded) return loaded;
    loaded = Promise.all(Object.entries(SRC).map(([k, p]) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { images[k] = im; res(true); };
      im.onerror = () => res(false);
      im.src = BASE + p;
    }))).then(rs => rs.every(Boolean));
    return loaded;
  }

  // The four pistons, as they sit at rest. `body` is the cell the piston is
  // in, `block` the cell its redstone block starts in, `d` the way it pushes.
  const PISTONS = [
    { body: [2, 0], block: [1, 0], d: [-1, 0] },   // top, pushing left
    { body: [0, 1], block: [0, 2], d: [0, 1] },    // left, pushing down
    { body: [1, 3], block: [2, 3], d: [1, 0] },    // bottom, pushing right
    { body: [3, 2], block: [3, 1], d: [0, -1] },   // right, pushing up
  ];

  // Part of a texture, drawn somewhere in the piston's own frame.
  //
  // In that frame the cell is 0..16 both ways and the piston pushes towards
  // -y, so a head that has gone out sits at a NEGATIVE y and the arm behind
  // it spans the gap. Turning the frame is what makes a piston face left
  // rather than up, texture and all.
  function turnTo(cx, px, py, d) {
    const a = d[0] === 0 && d[1] === -1 ? 0
      : d[0] === 1 ? Math.PI / 2
        : d[1] === 1 ? Math.PI
          : -Math.PI / 2;
    cx.translate(px + TEX / 2, py + TEX / 2);
    cx.rotate(a);
    cx.translate(-TEX / 2, -TEX / 2);
  }

  function drawLocal(cx, im, px, py, d, src, dst) {
    cx.save();
    turnTo(cx, px, py, d);
    cx.drawImage(im, src[0], src[1], src[2], src[3], dst[0], dst[1], dst[2], dst[3]);
    cx.restore();
  }

  // One frame. `t` is 0..1 through the whole cycle.
  function frame(cx, t) {
    cx.clearRect(0, 0, SIDE, SIDE);
    cx.imageSmoothingEnabled = false;

    PISTONS.forEach((p, i) => {
      // Its own quarter of the cycle: out, then back, then waiting.
      const local = ((t - i / 4) % 1 + 1) % 1;
      const outEnd = OUT;
      const backEnd = OUT + BACK;
      let e = 0;
      if (local < outEnd) e = fire(local / outEnd);
      else if (local < backEnd) e = 1 - fire((local - outEnd) / (backEnd - outEnd));

      const [bx, by] = p.body, [rx, ry] = p.block, [dx, dy] = p.d;
      const bpx = bx * TEX, bpy = by * TEX;

      // The piston, in three pieces, which is what one is.
      //
      // This is a view from the SIDE, so every surface of it that can be seen
      // is piston_side -- and the two textures that are not, the wooden face
      // and the inner plate, are both end-on and so are not visible at all.
      // Drawing them anyway was what made an extended piston look wrong in
      // three separate ways: the inner plate filled the four pixels the head
      // had left with, so the body still read as a whole block; the arm was
      // cut from a band ACROSS the texture rather than the strip along it, so
      // it was the body's pattern rather than the shaft; and the head wore
      // the wooden face, which is the one surface a piston never shows from
      // the side.
      //
      //   the head   4 px deep, the collar at the top of the texture
      //   the arm    4 px across, the strip the game takes it from
      //   the body   the remaining 12 px, which is what stays behind
      //
      // At rest the reach is nothing, the head sits straight on the body and
      // the three pieces are the whole texture again, so there is no separate
      // case for it.
      const reach = e * TEX;
      // The body: the part of the block that does not travel.
      drawLocal(cx, images.side, bpx, bpy, p.d,
        [0, FACE, TEX, TEX - FACE], [0, FACE, TEX, TEX - FACE]);
      // The arm, from the body's face out to the back of the head.
      //
      // The arm, exactly as the game's own model cuts it.
      //
      // From block/template_piston_head: the arm is
      //
      //   { "from": [6,6,4], "to": [10,10,20],
      //     "east": { "uv": [0,0,16,4], "texture": "#side" } }
      //
      // which says three things, and every wrong answer before this got one
      // of them wrong. It is four across and SIXTEEN long -- a whole block,
      // so nothing ever has to be invented to fill the reach. Its texture is
      // the top four rows of piston_side, the wooden band, which is also
      // where the head's collar is cut from. And the uv runs 0..16 ACROSS
      // the texture against the arm's 16 length, so the texture's X axis
      // runs ALONG the arm and its four rows are the arm's thickness. It is
      // a horizontal strip turned a quarter, not a vertical one.
      //
      // Cutting a vertical strip instead is what made it the body's grey
      // (further down the texture is the stone), and what made the first
      // four rows have to be squashed or repeated to reach any distance.
      // Turned the right way there is nothing to squash or repeat: sixteen
      // pixels of texture for sixteen pixels of arm.
      if (reach > 0) {
        cx.save();
        turnTo(cx, bpx, bpy, p.d);
        // Into the arm's own box, at its top-RIGHT, and turned a quarter --
        // so the texture's X runs down the arm and its Y across it.
        cx.translate((TEX + ARM) / 2, FACE - reach);
        cx.rotate(Math.PI / 2);
        // As much of the arm as is out of the hole, from the end the head is
        // on, at one pixel per pixel.
        cx.drawImage(images.side, 0, 0, reach, FACE, 0, 0, reach, ARM);
        cx.restore();
      }
      // The head: the collar, which is the top four pixels of the texture.
      drawLocal(cx, images.side, bpx, bpy, p.d,
        [0, 0, TEX, FACE], [0, -reach, TEX, FACE]);

      // The block of redstone, shoved along ahead of the head.
      cx.drawImage(images.redstone, rx * TEX + dx * e * TEX, ry * TEX + dy * e * TEX, TEX, TEX);
    });
  }

  function mount(el, opts) {
    opts = opts || {};
    const px = Math.max(32, Math.round(opts.size || 72));
    const cv = document.createElement('canvas');
    cv.width = cv.height = SIDE;
    cv.style.width = cv.style.height = px + 'px';
    cv.style.imageRendering = 'pixelated';
    cv.className = 'rl-loading';
    el.appendChild(cv);
    const cx = cv.getContext('2d');

    let raf = null, stopped = false;
    const start = performance.now();
    const tick = (now) => {
      if (stopped) return;
      // Nothing to draw into: the element went away, or the page is hidden.
      if (!cv.isConnected) return stop();
      frame(cx, ((now - start) % CYCLE) / CYCLE);
      raf = requestAnimationFrame(tick);
    };
    const stop = () => { stopped = true; if (raf) cancelAnimationFrame(raf); raf = null; };

    loadTextures().then(okay => {
      if (stopped || !okay) return;
      raf = requestAnimationFrame(tick);
    });
    return { canvas: cv, stop };
  }

  // Swap the CSS rings for this. The spinner elements are left in place and
  // emptied, so nothing has to know about their size or where they sit.
  function replace(root) {
    const where = root || document;
    const found = where.querySelectorAll('.loading-spinner, .mini-spinner, #pm-loading .spinner');
    found.forEach(el => {
      if (el.dataset.rlLoading) return;
      el.dataset.rlLoading = '1';
      // Its own size is what the page asked for; keep it. Measured from the
      // layout box rather than getBoundingClientRect, which for a spinner
      // mid-rotation reports the box the turned square sweeps out -- up to
      // half as big again, and different every frame.
      // A spinner inside something that is not being shown measures zero --
      // the shell's loading screen is exactly that, hidden until a page
      // change starts -- so the size it is MEANT to be is read from the
      // stylesheet when the layout has nothing to say.
      let size = Math.round(Math.max(el.offsetWidth, el.offsetHeight));
      if (!size) {
        const cs = getComputedStyle(el);
        size = Math.round(Math.max(parseFloat(cs.width) || 0, parseFloat(cs.height) || 0));
      }
      if (!size) size = 48;
      el.style.border = 'none';
      el.style.animation = 'none';
      el.style.borderRadius = '0';
      el.style.width = el.style.height = size + 'px';
      el.innerHTML = '';
      mount(el, { size });
    });
    return found.length;
  }

  // `frame` is handed out so the shape of a piston can be checked at an
  // exact point of the cycle rather than by catching the animation at the
  // right moment (see tests/piston-test.mjs).
  window.Loading = { mount, replace, frame, PISTONS, CYCLE, TEX, CELLS };

  // Spinners that are on the page at load, and any that turn up later.
  const sweep = () => { try { replace(); } catch { /* never break a page over this */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  else sweep();
  try {
    new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* no observer, no live swap */ }
})();
