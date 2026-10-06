/**
 * Keep low-resolution icons sharp when they are drawn bigger than they are.
 *
 * A lot of what this launcher shows is pixel art: a 16x16 or 32x32 pack.png, a
 * mod's little 64x64 logo, a server's 64x64 favicon, any of those set as an
 * instance's icon. Blown up to a 48 or 64 pixel tile with the browser's default
 * smoothing, a texture like that turns into a blur — which is exactly what it
 * is not meant to look like. Player heads already asked for
 * `image-rendering: pixelated` by hand; everything else did not.
 *
 * Rather than tagging every one of the two dozen places an icon is built, this
 * watches the page and decides per image, from the image itself:
 *
 *   - the source has to be SMALL (<= MAX_NATIVE across). A 512px artwork that
 *     happens to be stylised is not what this is for.
 *   - it has to be drawn BIGGER than it is, counting the display's pixel ratio.
 *     Upscaling is where smoothing does the damage. A pixel-art icon being
 *     shrunk is the opposite case: nearest-neighbour downsampling drops whole
 *     rows of pixels and aliases badly, so smoothing is right there and the
 *     image is left alone.
 *
 * Both are re-checked when the element changes size, so an icon that is sharp
 * in the instance grid and smooth in the list does the right thing in each
 * without anyone telling it which view it is in.
 *
 * Opt out of a single image with `data-no-pixelart`. An image that already has
 * an inline `image-rendering` of its own is never touched.
 *
 *   PixelArt.watch(img)   consider this one now and on resize
 *   PixelArt.scan(root)   consider everything under here
 *   PixelArt.refresh()    re-decide every watched image
 */
(function () {
  if (window.PixelArt) return;

  // 128 covers a 16x, 32x or 64x texture and a modest mod logo. Above it,
  // "sharp" stops meaning pixel art and starts meaning aliased.
  const MAX_NATIVE = 128;
  // A little slack, so an icon drawn at almost exactly its own size is not
  // flipped to pixelated by a rounding error in the layout.
  const MIN_UPSCALE = 1.15;

  const watched = new Set();
  const dpr = () => Math.min(3, window.devicePixelRatio || 1);

  let ro = null;
  try {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) decide(e.target);
    });
  } catch { /* no ResizeObserver: a one-shot decision per load, then */ }

  function decide(img) {
    if (!img || img.__pixelSkip) return;
    if (!img.isConnected) { drop(img); return; }
    const nw = img.naturalWidth, nh = img.naturalHeight;
    if (!nw || !nh) return;                       // not loaded (or broken)
    if (nw > MAX_NATIVE || nh > MAX_NATIVE) { clear(img); return; }
    let w = 0;
    try { w = img.getBoundingClientRect().width; } catch { }
    // Zero width means it is hidden or not laid out yet. Leave the last
    // decision alone rather than guessing; the resize observer will call back
    // when it does get a size.
    if (!w) return;
    if ((w * dpr()) / nw >= MIN_UPSCALE) set(img); else clear(img);
  }

  function set(img) {
    if (img.__pixelOn) return;
    img.__pixelOn = true;
    img.style.imageRendering = 'pixelated';
  }
  function clear(img) {
    if (!img.__pixelOn) return;
    img.__pixelOn = false;
    img.style.imageRendering = '';
  }
  function drop(img) {
    watched.delete(img);
    if (ro) { try { ro.unobserve(img); } catch { } }
  }

  function watch(img) {
    if (!img || img.tagName !== 'IMG') return;
    if (img.__pixelSkip) return;
    if (!watched.has(img)) {
      // Anything that already states its own rendering mode — a player head, a
      // skin editor swatch — has thought about this and is left alone forever.
      if (!img.__pixelOn && img.style.imageRendering) { img.__pixelSkip = true; return; }
      if (img.hasAttribute('data-no-pixelart')) { img.__pixelSkip = true; return; }
      watched.add(img);
      if (ro) { try { ro.observe(img); } catch { } }
      // A src that is swapped in place (a list redrawing over itself) is a new
      // image with a new size, so the decision has to be made again.
      img.addEventListener('load', () => decide(img));
    }
    if (img.complete) decide(img);
  }

  function scan(root) {
    const r = root || document;
    try {
      if (r.tagName === 'IMG') { watch(r); return; }
      for (const img of r.querySelectorAll('img')) watch(img);
    } catch { }
  }

  function refresh() {
    for (const img of [...watched]) {
      if (!img.isConnected) drop(img); else decide(img);
    }
  }

  // `load` does not bubble, but it does capture, so one listener on the
  // document catches every image on the page — including ones added later by
  // code that has never heard of this file.
  document.addEventListener('load', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG') watch(t);
  }, true);

  // Images that were already in the cache are `complete` before any listener
  // could fire, so new nodes are picked up as they arrive as well.
  try {
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'attributes') { watch(m.target); continue; }
        for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
    });
  } catch { /* no observer: the load listener still covers most of it */ }

  const start = () => scan(document);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.PixelArt = { watch, scan, refresh, decide };
})();
