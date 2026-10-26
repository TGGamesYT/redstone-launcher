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
    set('--text-font', cached.font);
    if (cached.borderRadius !== undefined) set('--border-radius', cached.borderRadius + 'px');
  }

  // ── the background ──
  // The same five modes sidebar.js knows about. Kept in step with
  // backgroundCss() there; this copy exists only because nothing else is
  // loaded this early.
  const b = cached.background;
  let image = null, size = 'auto', repeat = 'no-repeat', render = 'auto';
  if (b && b.mode && b.mode !== 'theme') {
    if (b.mode === 'color' && b.color) {
      image = b.color;
    } else if (b.mode === 'gradient' && b.gradient && (b.gradient.colors || []).length) {
      image = `linear-gradient(${b.gradient.angle ?? 180}deg, ${b.gradient.colors.join(', ')})`;
    } else if (b.mode === 'image' && b.image && (b.image.url || b.image.file)) {
      const u = b.image.url
        || ('file:///' + String(b.image.file).replace(/\\/g, '/').replace(/^\/+/, ''));
      image = `url("${u}")`;
      size = b.image.fit === 'stretch' ? '100% 100%' : b.image.fit === 'contain' ? 'contain' : 'cover';
    } else if (b.mode === 'block' && b.block && b.block.url) {
      const n = Math.max(8, Math.min(512, Number(b.block.size) || 64));
      image = `url("${b.block.url}")`;
      size = `${n}px ${n}px`;
      repeat = 'repeat';
      render = 'pixelated';            // a 16-pixel texture tiled at 64 stays sharp
    }
  } else if (!b && cached.gradientEnabled && (cached.gradientColors || []).length) {
    // A save from before the Background section.
    image = `linear-gradient(${cached.gradientAngle || 180}deg, ${cached.gradientColors.join(', ')})`;
  }

  if (image) {
    set('--app-background', image);
    set('--app-bg-size', size);
    set('--app-bg-repeat', repeat);
    set('--app-bg-render', render);
    root.classList.add('custom-bg');
  }
})();
