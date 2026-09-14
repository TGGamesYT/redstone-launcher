/**
 * Size scroll containers to the space actually left below them.
 *
 * Every page used to hardcode `height: calc(100vh - N)`, where N was a guess at
 * the height of the title bar plus whatever headings sat above the list. The
 * guesses were wrong by different amounts on different pages, so some lists
 * stopped short of the window bottom and the mod browser ran off past it.
 *
 * Anything carrying `data-fit-height` is measured instead: its height becomes
 * the distance from its own top edge to the bottom of the window, less an
 * optional gap (`data-fit-gap`, default 12px). That is correct whatever sits
 * above it, at any window size, on any page.
 *
 * Re-run on resize, on font load, and whenever the DOM around it changes.
 */
(function () {
  const MIN_HEIGHT = 120;

  function fitOne(el) {
    // An element that isn't displayed has no meaningful top edge; leave it
    // alone so it sizes correctly once it is shown.
    if (!el.isConnected || el.offsetParent === null) return;
    const gap = Number(el.dataset.fitGap || 12);
    const top = el.getBoundingClientRect().top;
    const h = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - top - gap));
    const next = h + 'px';
    // Only write when it changed: a no-op style write still invalidates layout,
    // and this runs from a MutationObserver.
    if (el.style.height !== next) el.style.height = next;
    if (!el.style.overflowY) el.style.overflowY = 'auto';
    el.style.boxSizing = 'border-box';
  }

  function fitAll() {
    document.querySelectorAll('[data-fit-height]').forEach(fitOne);
  }

  // Coalesce bursts (a list re-render fires many mutations) into one pass.
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fitAll(); });
  }

  window.fitHeights = schedule;

  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => { });

  function start() {
    schedule();
    // Content appearing above a list (a heading, a filter row wrapping to two
    // lines) moves its top edge, so re-measure when the page changes shape.
    try {
      new MutationObserver(schedule).observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
      });
    } catch { /* observer unavailable: resize still keeps it honest */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
