// An outline behind every bit of text that sits straight on the background.
//
// With a picture or a tiled block behind the window, text with no panel under
// it is over whatever the user chose, and white text on a light picture is
// unreadable. The fix is an outline in the opposite direction to the text
// colour -- but only for the text that really is on the background: over a
// panel the contrast is already known and an outline just looks heavy.
//
// Which text that is cannot be asked in CSS. "Is there a panel behind me" is a
// question about every ancestor's computed background, and a stylesheet can
// only ask about an element's own classes. The first attempt listed the
// selectors by hand -- headings and anything tagged `.on-background` -- and so
// missed almost everything: labels, values, buttons' captions, the home
// page's segment text, every string nobody remembered to tag.
//
// So it is measured instead. For each element holding text, walk up until
// something is found that actually paints: an opaque-enough background colour,
// or a background image. If that search gets all the way to <html> without
// finding one, the text is over the user's background and gets the outline.
// Nothing has to be tagged, and text added later is picked up by the observer.
(function () {
  const MARK = 'on-background';
  // How opaque a background has to be before it counts as covering what is
  // behind it. A faint tint over a photograph does not make text readable.
  const COVERS = 0.6;

  const root = document.documentElement;

  // An element's own background, not its ancestors': `transparent` and a
  // nearly-clear tint both read as "you can see through me".
  function paints(el) {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = /^rgba?\(([^)]+)\)$/.exec(cs.backgroundColor || '');
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s));
    const alpha = parts.length > 3 ? parts[3] : 1;
    return alpha >= COVERS;
  }

  // Walking the same ancestors over and over is the expensive part, so each
  // element's answer is kept until the next pass.
  let cache = new WeakMap();
  function overBackground(el) {
    const chain = [];
    let node = el;
    while (node && node !== root) {
      if (cache.has(node)) {
        const known = cache.get(node);
        for (const c of chain) cache.set(c, known);
        return known;
      }
      chain.push(node);
      // A panel found anywhere up the chain means this text is on the panel.
      if (node !== el && paints(node)) {
        for (const c of chain) cache.set(c, false);
        return false;
      }
      node = node.parentElement;
    }
    // Reached <html>, which is where the chosen background is painted.
    for (const c of chain) cache.set(c, true);
    return true;
  }

  // Text that belongs to this element rather than to a child of it: the
  // outline goes on whoever actually draws the glyphs, so a wrapper does not
  // hand it down to text that is over a panel further in.
  function ownsText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) return true;
    }
    return false;
  }

  // An element that paints its own background is a panel itself, however
  // small -- a badge, a pill, a button. Its text is on it, not on the page.
  function wants(el) {
    if (!ownsText(el)) return false;
    if (paints(el)) return false;
    return overBackground(el);
  }

  let queued = false;
  function pass() {
    queued = false;
    if (!root.classList.contains('custom-bg')) {
      for (const el of document.querySelectorAll('.' + MARK)) el.classList.remove(MARK);
      return;
    }
    cache = new WeakMap();
    // Everything that can hold text. Not <script>/<style>, whose "text" is code.
    for (const el of document.body.querySelectorAll('*')) {
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TITLE' || tag === 'OPTION') continue;
      const on = wants(el);
      if (on !== el.classList.contains(MARK)) el.classList.toggle(MARK, on);
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(pass);
  }

  // Marking elements is itself a DOM change, so the observer watches for
  // structure and style rather than for class attributes -- otherwise each
  // pass would schedule the next one for ever.
  const observe = () => {
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'childList' && (r.addedNodes.length || r.removedNodes.length)) return schedule();
        if (r.type === 'attributes' && r.attributeName === 'style') return schedule();
        if (r.type === 'characterData') return schedule();
      }
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['style'],
    });
  };

  const start = () => { schedule(); observe(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  // The theme's own code calls this after changing the text colour or the
  // background, since both change who needs an outline and what colour it is.
  window.LauncherOutline = { refresh: schedule };
})();
