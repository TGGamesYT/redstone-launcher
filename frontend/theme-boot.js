// The theme and the background, painted before anything renders.
//
// This runs from <head>, synchronously, off the settings cached in
// localStorage — so a page opens already in the user's colours instead of
// flashing the stylesheet's defaults and correcting itself once the main
// process answers. sidebar.js re-applies the real settings when they arrive.
//
// There used to be a copy of this in the head of every page. They drifted:
// some checked the wrong setting, some set the class on <html> only and some
// on <body> as well, so a page could open with no background over a
// transparent body — a white window until the next navigation. One file now.
(function () {
  // ── Inside the shell ──────────────────────────────────────────────────────
  //
  // The launcher is one page now: a shell holding the title bar and the
  // sidebar, with whichever page you are on in a frame filling the window
  // underneath them. The bars therefore stop reloading when you navigate.
  //
  // A page keeps its OWN bars in its markup -- it is still a complete page on
  // its own, which is what makes it possible to check that none of them
  // changed -- and simply hides them when it is the one being framed. The
  // shell's bars are drawn in exactly the same place, so nothing about the
  // page's own layout moves: it is still laid out for a title bar of that
  // height and a sidebar of that width, because they are still there, just
  // drawn by the shell.
  //
  // Set here rather than from the shell because this is the first script on
  // every page: a class added any later would show a frame with two title
  // bars in it for a frame or two.
  let framed = false;
  try { framed = window.parent !== window; } catch { framed = true; }
  if (framed) {
    document.documentElement.classList.add('in-shell');

    // And tell the shell which page this is.
    //
    // It cannot work that out by looking: these pages are file:// URLs, and a
    // file:// document is its own opaque origin, so the shell may not read a
    // frame's location at all -- not in a browser and not in Electron either,
    // unless web security is turned off, which is not a trade worth making
    // for a sidebar highlight. A message crosses an origin boundary; a
    // property read does not.
    //
    // Sent more than once because a page sets its own title after its data
    // arrives, and the window's title should follow the way it did when the
    // page WAS the window.
    const announce = () => {
      try {
        window.parent.postMessage({
          rsShell: 'page',
          page: (location.pathname.split('/').pop() || '').toLowerCase(),
          search: location.search || '',
          title: document.title || '',
        }, '*');
      } catch { /* nothing to tell */ }
    };
    announce();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', announce, { once: true });
    }
    window.addEventListener('load', announce);
    let left = 12;
    const again = setInterval(() => { announce(); if (--left <= 0) clearInterval(again); }, 400);

    // And when it is about to go.
    //
    // The shell raises its loading screen itself when IT starts a page change,
    // but a page can also change page on its own -- `location.href = ...`,
    // which several do -- and the shell has no way of seeing that coming. The
    // page leaving is the one thing that can be seen from inside, and it
    // happens before the frame goes blank, which is the gap that showed as a
    // black flash.
    window.addEventListener('beforeunload', () => {
      try { window.parent.postMessage({ rsShell: 'leaving' }, '*'); } catch { /* going anyway */ }
    });
  }

  let cached = {};
  try { cached = JSON.parse(localStorage.getItem('launcherTheme') || '{}') || {}; } catch { return; }
  const root = document.documentElement;
  const set = (k, v) => { if (v != null) root.style.setProperty(k, v); };

  const hex = (h) => {
    let s = String(h || '').replace('#', '');
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16));
  };
  const middle = (a, b) => {
    const x = hex(a), y = hex(b);
    if (!x || !y) return b;
    return '#' + [0, 1, 2].map(i => Math.round((x[i] + y[i]) / 2).toString(16).padStart(2, '0')).join('');
  };

  if (cached.baseColor) {
    set('--base-color', cached.baseColor);
    set('--secondary-color', cached.secondaryColor);
    // The third colour is derived unless it was explicitly set by hand.
    set('--third-color', (cached.autoThird === false && cached.thirdColor)
      ? cached.thirdColor
      : middle(cached.baseColor, cached.secondaryColor));
    set('--text-color', cached.textColor);
    // The outline behind text sitting straight on a custom background: a dark
    // edge under light text, a light one under dark text.
    const tc = hex(cached.textColor) || [255, 255, 255];
    const lum = (0.2126 * tc[0] + 0.7152 * tc[1] + 0.0722 * tc[2]) / 255;
    set('--text-outline', lum > 0.5 ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.85)');
    set('--text-font', cached.font);
    if (cached.borderRadius !== undefined) set('--border-radius', cached.borderRadius + 'px');
  }
  // Before the first paint, so text is never drawn smoothed and then
  // redrawn sharp.
  document.documentElement.dataset.smoothing = cached.fontSmoothing || 'sharp';

  // ── the background ──
  // The same five modes sidebar.js knows about. Kept in step with
  // backgroundCss() there; this copy exists only because nothing else is
  // loaded this early.
  const b = cached.background;
  let image = 'none', color = 'transparent', size = 'auto', repeat = 'no-repeat', render = 'auto', attach = 'fixed';
  let custom = false;
  if (b && b.mode && b.mode !== 'theme') {
    if (b.mode === 'color' && b.color) {
      // A background-COLOR, not an image: a hex handed over as the image is
      // not a valid background-image, which is why this came up white.
      color = b.color;
      custom = true;
    } else if (b.mode === 'gradient' && b.gradient && (b.gradient.colors || []).length) {
      image = `linear-gradient(${b.gradient.angle ?? 180}deg, ${b.gradient.colors.join(', ')})`;
      custom = true;
    } else if (b.mode === 'image'
      && (b.images || [b.image]).some(im => im && (im.url || im.file))) {
      // Several pictures stacked, top one first, with the launcher's own
      // panel under the lot of them -- so a fitted one shows what is below
      // it rather than a slab of colour. One picture and no list is a list
      // of one, so a save from before this reads the same.
      const list = (Array.isArray(b.images) && b.images.some(im => im && (im.url || im.file))
        ? b.images : [b.image]).filter(im => im && (im.url || im.file));
      const url = (im) => im.url
        || ('file:///' + String(im.file).replace(/\\/g, '/').replace(/^\/+/, ''));
      const images = list.map(im => `url("${url(im)}")`);
      const sizes = list.map(im =>
        im.fit === 'stretch' ? '100% 100%' : im.fit === 'contain' ? 'contain' : 'cover');
      images.push('linear-gradient(to bottom, var(--toolbar-bg) 0%, var(--toolbar-bg) 10%,'
        + ' var(--very-dark) 10%, var(--very-dark) 100%)');
      sizes.push('auto');
      image = images.join(', ');
      size = sizes.join(', ');
      repeat = images.map(() => 'no-repeat').join(', ');
      attach = images.map(() => 'fixed').join(', ');
      color = 'var(--very-dark)';
      custom = true;
    } else if (b.mode === 'block' && b.block && b.block.url) {
      const n = Math.max(8, Math.min(512, Number(b.block.size) || 64));
      // A randomly turned tile is a patch of cells, so one repeat is that
      // many tiles across.
      const cells = Math.max(1, Math.min(8, Number(b.block.cells) || 1));
      image = `url("${b.block.url}")`;
      size = `${n * cells}px ${n * cells}px`;
      repeat = 'repeat';
      render = 'pixelated';            // a 16-pixel texture tiled at 64 stays sharp
      color = 'var(--very-dark)';      // behind a texture with see-through pixels
      attach = b.block.scroll ? 'scroll' : 'fixed';
      custom = true;
    }
  } else if (!b && cached.gradientEnabled && (cached.gradientColors || []).length) {
    // A save from before the Background section.
    image = `linear-gradient(${cached.gradientAngle || 180}deg, ${cached.gradientColors.join(', ')})`;
    custom = true;
  }

  if (custom) {
    set('--app-background', image);
    set('--app-bg-color', color);
    set('--app-bg-size', size);
    set('--app-bg-repeat', repeat);
    set('--app-bg-render', render);
    set('--app-bg-attach', attach);
    if (attach === 'scroll') root.classList.add('bg-scrolls');
    root.classList.add('custom-bg');
  }

  // ── a style sheet of the user's own ──
  // Last in the document, so it beats the page's own styles and can move or
  // restyle anything the theme settings do not reach. Only with developer
  // mode on: a page that will not render because of a typo in here is much
  // harder to explain to somebody who does not know the setting exists.
  const style = document.createElement('style');
  style.id = 'launcher-custom-css';
  const apply = (text) => {
    style.textContent = String(text || '');
    // Appended to <body> rather than <head> so it comes after every stylesheet
    // the page loads, whenever this script runs.
    const host = document.body || document.documentElement;
    if (style.parentNode !== host) host.appendChild(style);
  };
  window.LauncherCustomCss = { apply, element: style };
  if (cached.devMode && cached.customCss) {
    if (document.body) apply(cached.customCss);
    else document.addEventListener('DOMContentLoaded', () => apply(cached.customCss), { once: true });
  }
})();
