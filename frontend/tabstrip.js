// The sliding highlight behind a tab strip.
//
// Every tab row in the launcher used to be a line of separate buttons with
// the selected one filled in: nothing joined them, and changing tab made the
// fill blink out of one button and into another.
//
// The strip itself now carries one highlight (`.tabstrip::before`) and this
// moves it to wherever the selected tab is, which is what makes it slide.
// CSS cannot do that on its own -- it cannot measure another element -- so
// the position goes in as custom properties and the transition does the rest.
//
// Nothing has to register: any `.tabstrip` on the page is picked up, however
// and whenever it was built, and a strip whose tabs are added later is
// measured again when they appear.
(function () {
  const STRIP = 'tabstrip';
  const ACTIVE = 'active';

  function place(strip, { animate = true } = {}) {
    if (!strip || !strip.isConnected) return;
    const on = strip.querySelector(':scope > button.' + ACTIVE);
    if (!on) {
      // Nothing selected: take the highlight away rather than leaving it
      // stranded under whichever tab was chosen last.
      strip.classList.remove('measured');
      return;
    }
    const s = strip.getBoundingClientRect();
    const b = on.getBoundingClientRect();
    // Zero-sized means the strip is not laid out yet -- hidden, or still
    // being built. Measuring that would park the highlight in the corner.
    if (!b.width || !b.height) { strip.classList.remove('measured'); return; }

    // The first placement is instant; moving between tabs animates.
    if (!animate || !strip.classList.contains('measured')) {
      strip.classList.add('placing');
      // Read the layout back so the class really applies before the
      // properties change, or the browser coalesces the two and it slides
      // anyway.
      void strip.offsetWidth;
    }
    strip.style.setProperty('--tab-x', (b.left - s.left) + 'px');
    strip.style.setProperty('--tab-y', (b.top - s.top) + 'px');
    strip.style.setProperty('--tab-w', b.width + 'px');
    strip.style.setProperty('--tab-h', b.height + 'px');
    strip.classList.add('measured');
    if (strip.classList.contains('placing')) {
      void strip.offsetWidth;
      strip.classList.remove('placing');
    }
  }

  const all = () => document.querySelectorAll('.' + STRIP);
  const placeAll = (opts) => { for (const s of all()) place(s, opts); };

  // A click changes which tab is active, but whoever owns the strip does that
  // in its own handler -- which may run after this one. The measurement waits
  // for the frame after, by which time the class has moved.
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.' + STRIP + ' > button') : null;
    if (!btn) return;
    const strip = btn.parentElement;
    requestAnimationFrame(() => requestAnimationFrame(() => place(strip)));
  }, true);

  // Tabs added later, a tab renamed, or `active` moved by script rather than
  // by a click. Debounced to a frame so a strip being built button by button
  // is measured once at the end.
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; placeAll(); });
  };

  const watch = () => {
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target;
        if (r.type === 'attributes') {
          // Only a tab's own class matters, not the strip's -- `measured`
          // and `placing` are set by this file and would loop.
          if (el.parentElement && el.parentElement.classList.contains(STRIP)) return schedule();
          continue;
        }
        if (el.classList && el.classList.contains(STRIP)) return schedule();
        if (el.querySelector && el.querySelector('.' + STRIP)) return schedule();
      }
    }).observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ['class'],
    });
  };

  // The width of a tab depends on the font, which may arrive after the first
  // paint and change every measurement.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => placeAll({ animate: false })).catch(() => { });
  }
  window.addEventListener('resize', () => placeAll({ animate: false }));

  const start = () => { placeAll({ animate: false }); watch(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // For a strip that is shown after being hidden, where nothing observable
  // changed but the measurements are now real.
  window.TabStrip = { refresh: () => placeAll({ animate: false }), place };
})();
