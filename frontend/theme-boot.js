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
  let image = 'none', color = 'transparent', size = 'auto', repeat = 'no-repeat', render = 'auto';
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
    } else if (b.mode === 'image' && b.image && (b.image.url || b.image.file)) {
      const u = b.image.url
        || ('file:///' + String(b.image.file).replace(/\\/g, '/').replace(/^\/+/, ''));
      image = `url("${u}")`;
      size = b.image.fit === 'stretch' ? '100% 100%' : b.image.fit === 'contain' ? 'contain' : 'cover';
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
