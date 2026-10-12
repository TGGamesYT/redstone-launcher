/**
 * Modals that arrive and leave, rather than appearing and vanishing.
 *
 * Some of them already faded in; none of them faded out, and the ones built
 * in JavaScript (the confirm boxes, the new-instance chooser, the modpack
 * installer) did neither. This gives all of them both, in one place, without
 * every modal having to know about it.
 *
 * Two kinds of modal need two different tricks:
 *
 *   - One that is SHOWN AND HIDDEN (display, or an `active` class) is watched.
 *     When it goes hidden the hide is briefly overridden, the leaving
 *     animation plays, and then it lets the page's own state through again.
 *     Nothing about the page has to change.
 *
 *   - One that is BUILT AND REMOVED cannot be watched: by the time the
 *     removal is visible it is already gone. Those call ModalFX.close(el, fn),
 *     which plays the animation and then does the removing.
 *
 *   ModalFX.close(el, done)   play the leaving animation, then done()
 *   ModalFX.IN_MS / OUT_MS    how long each takes
 */
(function () {
  if (window.ModalFX) return;

  const IN_MS = 160;
  const OUT_MS = 140;
  // Everything that is a modal backdrop, whoever built it.
  const SEL = '.modal-overlay, .modal-base, .uim-overlay, .ni-overlay, .mpi-overlay';

  function ensureStyle() {
    if (document.getElementById('rl-modalfx')) return;
    const s = document.createElement('style');
    s.id = 'rl-modalfx';
    s.textContent = `
      @keyframes rlmShow { from { opacity: 0; } to { opacity: 1; } }
      @keyframes rlmHide { from { opacity: 1; } to { opacity: 0; } }
      @keyframes rlmRise { from { opacity: 0; transform: translateY(12px) scale(0.97); }
                           to   { opacity: 1; transform: none; } }
      @keyframes rlmSink { from { opacity: 1; transform: none; }
                           to   { opacity: 0; transform: translateY(8px) scale(0.98); } }

      /* The ones built in JavaScript had no animation of their own. */
      .uim-overlay, .ni-overlay, .mpi-overlay { animation: rlmShow ${IN_MS}ms ease; }
      .uim-card, .ni-card, .mpi-card { animation: rlmRise ${IN_MS + 40}ms cubic-bezier(0.2, 0.8, 0.3, 1); }

      /* Leaving. The override is what keeps it on screen for long enough to
         be seen going, whatever the page did to hide it. */
      .rlm-closing { display: flex !important; animation: rlmHide ${OUT_MS}ms ease forwards !important;
        pointer-events: none !important; }
      .rlm-closing > * { animation: rlmSink ${OUT_MS}ms ease forwards !important; }

      @media (prefers-reduced-motion: reduce) {
        .uim-overlay, .ni-overlay, .mpi-overlay, .uim-card, .ni-card, .mpi-card,
        .rlm-closing, .rlm-closing > * { animation: none !important; }
      }`;
    document.head.appendChild(s);
  }

  const shown = (el) => el.isConnected && getComputedStyle(el).display !== 'none';

  // Play the leaving animation on `el`, then hand back to the caller.
  function close(el, done) {
    ensureStyle();
    if (!el || !el.isConnected || el.dataset.rlmClosing) { if (done) done(); return; }
    el.dataset.rlmClosing = '1';
    el.classList.add('rlm-closing');
    setTimeout(() => {
      el.classList.remove('rlm-closing');
      delete el.dataset.rlmClosing;
      if (done) done();
    }, OUT_MS);
  }

  // The watched kind. `was` remembers whether each overlay was on screen, so a
  // change from shown to hidden can be told from any other attribute change.
  const was = new WeakMap();

  function check(el) {
    if (!(el instanceof Element) || !el.matches(SEL)) return;
    const now = shown(el);
    const before = was.get(el);
    was.set(el, now);
    if (before === undefined) return;             // first sight: nothing to play
    if (before && !now && !el.dataset.rlmClosing) {
      // It has just been hidden. Hold it on screen for the animation, then
      // let whatever the page did take effect.
      el.dataset.rlmClosing = '1';
      el.classList.add('rlm-closing');
      setTimeout(() => {
        el.classList.remove('rlm-closing');
        delete el.dataset.rlmClosing;
        was.set(el, shown(el));
      }, OUT_MS);
    }
  }

  function sweep(root) {
    (root || document).querySelectorAll(SEL).forEach(el => {
      if (!was.has(el)) was.set(el, shown(el));
    });
  }

  function start() {
    ensureStyle();
    sweep();
    const obs = new MutationObserver(records => {
      for (const r of records) {
        if (r.type === 'attributes') { check(r.target); continue; }
        r.addedNodes.forEach(n => {
          if (!(n instanceof Element)) return;
          if (n.matches && n.matches(SEL)) was.set(n, shown(n));
          sweep(n);
        });
      }
    });
    obs.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class', 'style'], subtree: true, childList: true,
    });
  }

  window.ModalFX = { close, IN_MS, OUT_MS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
