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

  const SRC = {
    side: 'assets/blocks/piston_side.png',
    inner: 'assets/blocks/piston_inner.png',
    face: 'assets/blocks/piston_face.png',
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

  // A texture drawn into one cell, turned so that "up" in the texture points
  // the way the piston faces. piston_side has its head band along the top, so
  // turning it is what makes a piston face left rather than up.
  function drawTurned(cx, im, px, py, d, sx, sy, sw, sh) {
    const a = d[0] === 0 && d[1] === -1 ? 0
      : d[0] === 1 ? Math.PI / 2
        : d[1] === 1 ? Math.PI
          : -Math.PI / 2;
    cx.save();
    cx.translate(px + TEX / 2, py + TEX / 2);
    cx.rotate(a);
    cx.translate(-TEX / 2, -TEX / 2);
    if (sw === undefined) cx.drawImage(im, 0, 0, TEX, TEX);
    else cx.drawImage(im, sx, sy, sw, sh, sx, sy, sw, sh);
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

      // The piston. At rest it is the whole block with its head on the front;
      // extended, the body is 12 px deep and the inner face shows.
      if (e <= 0.001) {
        drawTurned(cx, images.side, bpx, bpy, p.d);
      } else {
        // The body, minus the 4 px the head has left with.
        drawTurned(cx, images.side, bpx, bpy, p.d, 0, FACE, TEX, TEX - FACE);
        drawTurned(cx, images.inner, bpx, bpy, p.d, 0, 0, TEX, FACE);
        // The arm, running from the body's face out to where the head is.
        const reach = e * TEX;
        const ax = bpx + (dx === 0 ? (TEX - ARM) / 2 : (dx > 0 ? TEX : -reach));
        const ay = bpy + (dy === 0 ? (TEX - ARM) / 2 : (dy > 0 ? TEX : -reach));
        const aw = dx === 0 ? ARM : reach;
        const ah = dy === 0 ? ARM : reach;
        cx.drawImage(images.side, 0, FACE, TEX, ARM, ax, ay, aw, ah);
        // And its wooden face, right at the front.
        const hx = bpx + (dx === 0 ? 0 : (dx > 0 ? TEX + reach - FACE : -reach));
        const hy = bpy + (dy === 0 ? 0 : (dy > 0 ? TEX + reach - FACE : -reach));
        const hw = dx === 0 ? TEX : FACE;
        const hh = dy === 0 ? TEX : FACE;
        cx.drawImage(images.face, 0, 0, TEX, TEX, hx, hy, hw, hh);
      }

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
      const size = Math.round(Math.max(el.offsetWidth, el.offsetHeight)) || 48;
      el.style.border = 'none';
      el.style.animation = 'none';
      el.style.borderRadius = '0';
      el.style.width = el.style.height = size + 'px';
      el.innerHTML = '';
      mount(el, { size });
    });
    return found.length;
  }

  window.Loading = { mount, replace, PISTONS, CYCLE };

  // Spinners that are on the page at load, and any that turn up later.
  const sweep = () => { try { replace(); } catch { /* never break a page over this */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sweep);
  else sweep();
  try {
    new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
  } catch { /* no observer, no live swap */ }
})();
