// ── Player heads ──
// Heads are built by the launcher out of Mojang's own skin rather than fetched
// from an avatar service (playerhead.js says why). Every page with a sidebar
// shows at least one, so it is loaded here for the pages that don't include it
// themselves, and `setPlayerHead` waits for it rather than silently drawing
// nothing if a list renders before the script has arrived.
const whenPlayerHead = (() => {
  if (!window.PlayerHead && !document.querySelector('script[src$="playerhead.js"]')) {
    const t = document.createElement('script');
    t.src = 'playerhead.js';
    document.head.appendChild(t);
  }
  let p = null;
  return () => p || (p = new Promise(res => {
    const t0 = Date.now();
    const tick = () => {
      if (window.PlayerHead) return res(true);
      if (Date.now() - t0 > 5000) return res(false);   // it is not coming
      setTimeout(tick, 30);
    };
    tick();
  }));
})();

function setPlayerHead(img, opts) {
  whenPlayerHead().then(ok => { if (ok && img) window.PlayerHead.set(img, opts); });
}
window.setPlayerHead = setPlayerHead;

function error(text, duration = 3000) {
  console.error(text)
  // Create container if needed
  let container = document.getElementById("error-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "error-container";
    document.body.appendChild(container);
  }

  // Create the popup
  const popup = document.createElement("div");
  popup.className = "error-popup";
  popup.innerHTML = `
    <span>${text}</span>
    <span class="close-btn">&times;</span>
    <div class="error-timer"><div class="error-timer-fill"></div></div>
  `;

  // Timer bar animation
  popup.querySelector(".error-timer-fill").style.animationDuration = duration + "ms";

  container.appendChild(popup);

  // Close on "X"
  popup.querySelector(".close-btn").onclick = () => popup.remove();

  // Auto-remove
  setTimeout(() => {
    popup.remove();
  }, duration);
}

// Theme fallbacks, mirroring the defaults in main.js. A half-written cache or an
// older save must never leave a colour undefined here — that used to throw and
// abort the rest of this file, leaving pages half-rendered.
const THEME_FALLBACK = {
  baseColor: '#b30c0c', secondaryColor: '#ff4d4d', thirdColor: '#d92d2d',
  textColor: '#ffffff', font: 'Pixel', borderRadius: 0, gradientAngle: 180,
  fontSmoothing: 'sharp',
};

function hexToRgb(hex, fallback = '#000000') {
  hex = String(hex ?? fallback).replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(hex)) hex = String(fallback).replace(/^#/, '');
  return [
    parseInt(hex.substring(0, 2), 16),
    parseInt(hex.substring(2, 4), 16),
    parseInt(hex.substring(4, 6), 16)
  ];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function getMiddleColor(hex1, hex2) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  const middle = rgb1.map((c, i) => Math.round((c + rgb2[i]) / 2));
  return rgbToHex(middle[0], middle[1], middle[2]);
}

// ── What is behind the launcher ─────────────────────────────────────────────
//
// Five things it can be: the app's own shaded panel, one flat colour, a
// gradient, a picture, or a block's face tiled across. All five come out of
// one setting and are turned into CSS here, so every page agrees and the
// settings page can preview exactly what it will save.
//
// The custom-bg class is what the stylesheet keys off, and it is on <html>
// alone. Two elements had to be kept in step before, and a page that set only
// one of them left the window white until the next navigation.
const BG_FALLBACK = {
  mode: 'theme', color: '#121212',
  gradient: { colors: ['#ff4d4d', '#b30c0c'], angle: 180 },
  image: { file: null, fit: 'cover' },
  block: { url: null, size: 64, cells: 1 },
};
// A path to something on disk, as a url the page may load.
function fileUrl(p) {
  if (!p) return null;
  const s = String(p).replace(/\\/g, '/');
  return 'file:///' + s.replace(/^\/+/, '').replace(/[?#]/g, encodeURIComponent);
}
function backgroundCss(bg) {
  const b = { ...BG_FALLBACK, ...(bg || {}) };
  // `color` is painted as background-COLOR and `image` as background-image.
  // A flat colour used to be handed over as the image, which is not a valid
  // background-image at all -- so the whole declaration was dropped and the
  // window came up white whatever colour had been picked.
  const none = { image: 'none', color: 'transparent', size: 'auto', repeat: 'no-repeat', render: 'auto', attach: 'fixed' };
  if (b.mode === 'color' && b.color) {
    return { ...none, color: b.color };
  }
  if (b.mode === 'gradient') {
    const g = { ...BG_FALLBACK.gradient, ...(b.gradient || {}) };
    const colors = (g.colors || []).filter(Boolean);
    if (colors.length) {
      return { ...none, image: `linear-gradient(${g.angle ?? 180}deg, ${colors.join(', ')})` };
    }
  }
  if (b.mode === 'image') {
    const im = { ...BG_FALLBACK.image, ...(b.image || {}) };
    const url = im.url || fileUrl(im.file);
    if (url) {
      // Stretched fills the window and distorts; fitted shows all of it with
      // bars; covered fills and crops. Covered is what a wallpaper usually
      // wants, and is the default. Fitted leaves bars, which are the theme's
      // own colour rather than nothing.
      const size = im.fit === 'stretch' ? '100% 100%' : im.fit === 'contain' ? 'contain' : 'cover';
      return { ...none, image: `url("${url}")`, size, color: 'var(--very-dark)' };
    }
  }
  if (b.mode === 'block') {
    const bl = { ...BG_FALLBACK.block, ...(b.block || {}) };
    if (bl.url) {
      const n = Math.max(8, Math.min(512, Number(bl.size) || 64));
      // A tile turned at random is not one texture but a patch of several
      // cells, so one repeat of it is that many tiles across. Sizing it as a
      // single tile would shrink every cell to a quarter.
      const cells = Math.max(1, Math.min(8, Number(bl.cells) || 1));
      const span = n * cells;
      // A 16-pixel texture blown up to 64 has to stay sharp, or a tiled dirt
      // wall turns into a blur. `image-rendering` applies to background
      // images, so the whole tiling is pixel-for-pixel.
      //
      // The theme's own colour goes behind it: a texture with see-through
      // pixels -- glass, leaves, iron bars -- showed the window's white
      // through the holes otherwise.
      return {
        ...none, image: `url("${bl.url}")`, size: `${span}px ${span}px`,
        repeat: 'repeat', render: 'pixelated', color: 'var(--very-dark)',
        // A tiled wall can either stay put behind the page or travel with it
        // as it scrolls; which of those looks right is a matter of taste.
        attach: bl.scroll ? 'scroll' : 'fixed',
      };
    }
  }
  return null;                       // the app's own panel
}

function applyBackground(settings) {
  const css = backgroundCss(settings && settings.background);
  const root = document.documentElement;
  if (!css) {
    root.style.setProperty('--app-background', 'none');
    root.style.setProperty('--app-bg-color', 'transparent');
    root.classList.remove('custom-bg');
    if (document.body) document.body.classList.remove('custom-bg');
    if (window.LauncherOutline) window.LauncherOutline.refresh();
    return;
  }
  root.style.setProperty('--app-background', css.image);
  root.style.setProperty('--app-bg-color', css.color);
  root.style.setProperty('--app-bg-size', css.size);
  root.style.setProperty('--app-bg-repeat', css.repeat);
  root.style.setProperty('--app-bg-render', css.render);
  root.style.setProperty('--app-bg-attach', css.attach);
  root.classList.add('custom-bg');
  if (document.body) document.body.classList.add('custom-bg');
  // Which text needs an outline depends on what is behind it, so a change of
  // background is a reason to work it out again.
  if (window.LauncherOutline) window.LauncherOutline.refresh();
}
// The settings page previews with these, and so does its own head script.
window.LauncherBackground = { css: backgroundCss, apply: applyBackground, FALLBACK: BG_FALLBACK };

// Light text wants a dark outline, dark text a light one. Rec. 709
// luminance, which is what "does this look light" comes down to.
function outlineFor(textColor) {
  const [r, g, b] = hexToRgb(textColor, '#ffffff');
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.5 ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.85)';
}

function applyTheme(settings) {
  settings = { ...THEME_FALLBACK, ...(settings || {}) };
  const textColor = settings.textColor;
  const textFont = settings.font;
  const base = settings.baseColor;
  const secondary = settings.secondaryColor;
  // Derive the third colour from base+secondary unless the user explicitly
  // turned OFF auto-third and picked a manual one. Presets/older saves left a
  // stale red thirdColor behind, which is why sidebar hovers, tooltips, install
  // buttons and pagination stayed red regardless of the theme.
  const mid = (settings.autoThird === false && settings.thirdColor)
    ? settings.thirdColor
    : getMiddleColor(base, secondary);
  document.documentElement.style.setProperty('--base-color', base);
  document.documentElement.style.setProperty('--secondary-color', secondary);
  document.documentElement.style.setProperty('--third-color', mid);
  document.documentElement.style.setProperty('--text-color', textColor);
  // The outline behind text that sits straight on a custom background. Light
  // text needs a dark edge and dark text a light one, which is a question
  // about the text colour's brightness and so cannot be asked in CSS.
  document.documentElement.style.setProperty('--text-outline', outlineFor(textColor));
  document.documentElement.style.setProperty('--text-font', textFont);
  // How glyphs are rasterised: an attribute rather than a variable, since
  // -webkit-font-smoothing takes a keyword and not a custom property.
  document.documentElement.dataset.smoothing = settings.fontSmoothing || 'sharp';
  document.documentElement.style.setProperty('--border-radius', `${settings.borderRadius}px`);
  
  applyBackground(settings);
}

// Theming must never be able to take the page down with it: a corrupt cache or a
// failed IPC should still leave the rest of the sidebar working.
let cachedTheme = {};
try { cachedTheme = JSON.parse(localStorage.getItem('launcherTheme') || '{}') || {}; } catch { cachedTheme = {}; }
try { applyTheme(cachedTheme); } catch (e) { console.warn('cached theme failed to apply', e); }

ipcRenderer.invoke('get-settings').then(settings => {
  try { applyTheme(settings); } catch (e) { console.warn('theme failed to apply', e); }
  // The real settings may differ from the cache the boot script used -- a
  // custom style sheet edited in another window, say.
  try {
    if (window.LauncherCustomCss) {
      window.LauncherCustomCss.apply(settings.devMode ? (settings.customCss || '') : '');
    }
  } catch (e) { console.warn('custom css failed to apply', e); }
  try { localStorage.setItem('launcherTheme', JSON.stringify(settings)); } catch { /* ignore */ }
}).catch(e => console.warn('get-settings failed', e));


players = [];
selectedPlayerId = null;
document.getElementById("min-btn").onclick = () => minApp();
document.getElementById("max-btn").onclick = () => maxApp();
document.getElementById("close-btn").onclick = () => closeApp();

document.getElementById("close-btn").addEventListener("click", () => {
  win.close();
});

function setSelectedPlayer(id) {ipcRenderer.send('set-selected-player', id)}
async function getSelectedPlayer() {return await ipcRenderer.invoke('get-selected-player')}

async function updateLoginIcon() {
  const newSelectedPlayerId = await getSelectedPlayer();
  selectedPlayerId = newSelectedPlayerId;

  const li = document.getElementById('players-login');
  if (!li) return;

  // Always re-render: this runs both before and after the players list loads,
  // and the player head must replace the login icon once players arrive.
  // (id can be a number or string depending on how it was created/edited.)
  const player = players.find(p => String(p.id) === String(selectedPlayerId));

  // Avoid pointless DOM churn if nothing changed.
  if (li.dataset.renderedFor === String(player ? player.id : 'none')) return;
  li.dataset.renderedFor = String(player ? player.id : 'none');

  li.innerHTML = '';

  if (player) {
    const username = player.type === 'microsoft' ? (player.auth?.name ?? 'MS Account') : (player.username ?? 'Offline');

    const img = document.createElement('img');
    // Offline accounts get the default skin, premium accounts their real one.
    // Built here from Mojang's skin rather than fetched from an avatar service
    // — see playerhead.js for why that mattered.
    setPlayerHead(img, {
      uuid: player.auth?.uuid || player.uuid,
      name: username,
      size: 24,
      offline: player.type !== 'microsoft',
      // An offline account with a skin in this launcher shows that skin.
      playerId: player.type !== 'microsoft' ? player.id : null,
    });
    img.style.width = '24px';
    img.style.height = '24px';
    img.style.borderRadius = '4px';
    img.href = "players.html";
    img.id = "playerIconSiderbar"
    li.appendChild(img);

    const span = document.createElement('span');
    span.textContent = username;
    span.id = "playerIconTextSidebar"
    li.appendChild(span);

  } else {
    const a = document.createElement('a');
    a.href = 'players.html';
    const icon = document.createElement('i');
    icon.className = 'material-icons';
    icon.textContent = 'login';
    a.appendChild(icon);
    li.appendChild(a);

    const span = document.createElement('span');
    span.textContent = 'Login';
    li.appendChild(span);
  }
}

function renderInstances(instances) {
  const ul = document.getElementById("instances");
  ul.innerHTML = ""; // clear placeholder items
  num = 0;

  // Add each instance
  instances.forEach(instance => {
    if (num < 3) {
      const li = document.createElement("li");

      // clickable icon + link
      const a = document.createElement("a");
      a.href = `instances.html?i=${encodeURIComponent(instance.id)}`;
      // If we're already on the instances page, switch in-page instead of
      // triggering a full reload.
      a.addEventListener("click", (e) => {
        if (typeof window.openInstanceInPage === "function") {
          e.preventDefault();
          window.openInstanceInPage(instance.id);
        }
      });
      const img = document.createElement("img");
      window.instanceIconInto(img, instance);
      img.alt = instance.name;
      img.style.width = "24px";
      a.appendChild(img);

      const span = document.createElement("span");
      span.textContent = instance.name;

      li.appendChild(a);
      li.appendChild(span);
      ul.appendChild(li);
      num++
    }
  });

  // "Add an instance" option
  const liAdd = document.createElement("li");
  const iAdd = document.createElement("i");
  iAdd.className = "material-icons";
  iAdd.textContent = "add";

  const spanAdd = document.createElement("span");
  spanAdd.textContent = "Add an instance";

  liAdd.appendChild(iAdd);
  liAdd.appendChild(spanAdd);
  liAdd.addEventListener("click", () => {
    if (typeof window.openNewInstanceInPage === "function") {
      window.openNewInstanceInPage();
    } else {
      window.location.href = "instances.html?i=NEWINSTANCE";
    }
  });
  ul.appendChild(liAdd);
}

// Provider logos (Modrinth / CurseForge) as inline SVGs so they take the
// current text colour. Exposed globally for the mod browser toggle too.
window.PROVIDER_SVG = {
  modrinth: '<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%"><path d="M12.252.004a11.78 11.768 0 0 0-8.92 3.73 11 10.999 0 0 0-2.17 3.11 11.37 11.359 0 0 0-1.16 5.169c0 1.42.17 2.5.6 3.77.24.759.77 1.899 1.17 2.529a12.3 12.298 0 0 0 8.85 5.639c.44.05 2.54.07 2.76.02.2-.04.22.1-.26-1.7l-.36-1.37-1.01-.06a8.5 8.489 0 0 1-5.18-1.8 5.34 5.34 0 0 1-1.3-1.26c0-.05.34-.28.74-.5a37.572 37.545 0 0 1 2.88-1.629c.03 0 .5.45 1.06.98l1 .97 2.07-.43 2.06-.43 1.47-1.47c.8-.8 1.48-1.5 1.48-1.52 0-.09-.42-1.63-.46-1.7-.04-.06-.2-.03-1.02.18-.53.13-1.2.3-1.45.4l-.48.15-.53.53-.53.53-.93.1-.93.07-.52-.5a2.7 2.7 0 0 1-.96-1.7l-.13-.6.43-.57c.68-.9.68-.9 1.46-1.1.4-.1.65-.2.83-.33.13-.099.65-.579 1.14-1.069l.9-.9-.7-.7-.7-.7-1.95.54c-1.07.3-1.96.53-1.97.53-.03 0-2.23 2.48-2.63 2.97l-.29.35.28 1.03c.16.56.3 1.16.31 1.34l.03.3-.34.23c-.37.23-2.22 1.3-2.84 1.63-.36.2-.37.2-.44.1-.08-.1-.23-.6-.32-1.03-.18-.86-.17-2.75.02-3.73a8.84 8.839 0 0 1 7.9-6.93c.43-.03.77-.08.78-.1.06-.17.5-2.999.47-3.039-.01-.02-.1-.02-.2-.03Zm3.68.67c-.2 0-.3.1-.37.38-.06.23-.46 2.42-.46 2.52 0 .04.1.11.22.16a8.51 8.499 0 0 1 2.99 2 8.38 8.379 0 0 1 2.16 3.449 6.9 6.9 0 0 1 .4 2.8c0 1.07 0 1.27-.1 1.73a9.37 9.369 0 0 1-1.76 3.769c-.32.4-.98 1.06-1.37 1.38-.38.32-1.54 1.1-1.7 1.14-.1.03-.1.06-.07.26.03.18.64 2.56.7 2.78l.06.06a12.07 12.058 0 0 0 7.27-9.4c.13-.77.13-2.58 0-3.4a11.96 11.948 0 0 0-5.73-8.578c-.7-.42-2.05-1.06-2.25-1.06Z"/></svg>',
  curseforge: '<svg viewBox="0 0 24 24" fill="currentColor" width="100%" height="100%"><path d="M18.326 9.2145S23.2261 8.4418 24 6.1882h-7.5066V4.4H0l2.0318 2.3576V9.173s5.1267-.2665 7.1098 1.2372c2.7146 2.516-3.053 5.917-3.053 5.917L5.0995 19.6c1.5465-1.4726 4.494-3.3775 9.8983-3.2857-2.0565.65-4.1245 1.6651-5.7344 3.2857h10.9248l-1.0288-3.2726s-7.918-4.6688-.8336-7.1127z"/></svg>'
};

// The sidebar's mod-browser entry shows the currently-selected provider's logo
// and updates everywhere the provider is switched.
function applyModProviderIcon() {
  const provider = localStorage.getItem('modProvider') === 'curseforge' ? 'curseforge' : 'modrinth';
  const svg = (window.PROVIDER_SVG && window.PROVIDER_SVG[provider]) || '';
  document.querySelectorAll('.sidebar a.modrinth').forEach(a => {
    const li = a.querySelector(':scope > li');
    if (li) {
      li.innerHTML = `<span class="provider-icon">${svg}</span><span>Mod Browser</span>`;
    } else {
      // The events page's sidebar is an older shape — the link holds the icon
      // and the label sits beside it rather than inside. It was the last place
      // still loading this logo as an image from a website.
      a.innerHTML = `<span class="provider-icon" style="display:inline-block;width:24px;height:24px;">${svg}</span>`;
    }
  });
}
applyModProviderIcon();

// Don't let a text-selection drag that ENDS on a modal backdrop close the modal.
// Modal close handlers fire on click when e.target === overlay; when the drag
// STARTED on an element *inside* that overlay (selecting text in the modal) the
// click's target becomes the common ancestor (the overlay), which would close
// it. We detect that (mouseup target contains the mousedown target) and swallow
// the click. Works for every modal regardless of its classes/ids.
(function preventDragCloseOnModals() {
  let downTarget = null;
  document.addEventListener('mousedown', (e) => { downTarget = e.target; }, true);
  document.addEventListener('click', (e) => {
    if (!downTarget || downTarget === e.target) return;
    if (e.target && e.target.contains && e.target.contains(downTarget)) {
      e.stopPropagation();
    }
    downTarget = null;
  }, true);
})();

// In-page navigation: when a sidebar link points at the page we're ALREADY on,
// don't do a full reload — let the page restructure to its list view in place
// (pages opt in by defining window.showListView). This keeps e.g. clicking
// "Instances" from an instance detail, or "Server Manager" from a server
// detail, from flashing/reloading the whole page.
(function setupSidebarInPageNav() {
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  document.querySelectorAll('.sidebar a[href]').forEach(a => {
    const target = (a.getAttribute('href') || '').split('/').pop().toLowerCase();
    if (!target || target !== here) return;
    // Which page you are on was not shown anywhere: every button in the
    // sidebar looked the same whichever one was open. The link that points at
    // the page we are already on IS the current page, which this loop has
    // just worked out anyway.
    const button = a.querySelector('li') || (a.parentElement && a.parentElement.tagName === 'LI' ? a.parentElement : null);
    if (button) button.classList.add('current');
    a.addEventListener('click', (e) => {
      if (typeof window.showListView === 'function') {
        e.preventDefault();
        window.showListView();
      }
    });
  });
})();

// Global loading-screen handling. Any page that includes a
// `#loading-overlay` element gets the same fade-out once the window finishes
// loading, so every page shows the launcher splash without duplicating logic.
function hideLoadingOverlay() {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  if (_loadHolds.size) return;        // something is still loading; it says so
  overlay.classList.add('fade-out');
  setTimeout(() => { if (!_loadHolds.size) overlay.style.display = 'none'; }, 500);
}

// A page can keep the launcher's own loading screen up while it finishes
// getting what it needs, instead of putting a second spinner of its own in
// the middle of the page. The subtext says what it is waiting for.
//
//   pageLoading.hold('skins', 'Loading your skins & capes…')
//   pageLoading.release('skins')
//   pageLoading.show('Opening Fabulously Optimized…')   // an in-page change
//
// A hold that is never released would leave the launcher behind a curtain,
// so each one lets go by itself after a while.
const _loadHolds = new Map();
const LOAD_HOLD_MAX = 15000;
function _setLoadText(text) {
  const el = document.querySelector('#loading-overlay .loading-subtext');
  if (el && text) el.textContent = text;
}
function _showOverlay(text) {
  const overlay = document.getElementById('loading-overlay');
  if (!overlay) return;
  overlay.classList.remove('fade-out');
  overlay.style.display = '';
  _setLoadText(text);
}
window.pageLoading = {
  hold(key, text) {
    _showOverlay(text);
    clearTimeout(_loadHolds.get(key));
    _loadHolds.set(key, setTimeout(() => window.pageLoading.release(key), LOAD_HOLD_MAX));
  },
  release(key) {
    clearTimeout(_loadHolds.get(key));
    _loadHolds.delete(key);
    if (!_loadHolds.size) hideLoadingOverlay();
  },
  // A change WITHIN a page -- the instance list to an instance, and back --
  // which is a page change as far as anyone looking at it is concerned, and
  // used to happen with no sign that anything had happened at all.
  show(text, ms) {
    const key = 'page:' + Math.random().toString(36).slice(2);
    window.pageLoading.hold(key, text);
    setTimeout(() => window.pageLoading.release(key), Math.max(120, ms || 280));
  },
};

if (document.readyState === 'complete') {
  setTimeout(hideLoadingOverlay, 400);
} else {
  window.addEventListener('load', () => setTimeout(hideLoadingOverlay, 400));
}

// Ask backend for profiles/instances
function updateSideBar() {
  updateLoginIcon()
  ipcRenderer.send("get-profiles");
  ipcRenderer.on("profiles-list", (event, profiles) => {
    renderInstances(profiles);
  });
  // Keep the sidebar instance shortcuts in sync when instances are
  // created/edited/deleted anywhere in the app.
  ipcRenderer.on("profiles-updated", (event, profiles) => {
    renderInstances(profiles);
  });
}

function closeApp() {ipcRenderer.send("close-app")}
function minApp() {ipcRenderer.send("min-app")}
function maxApp() {
  ipcRenderer.send("max-app");
}

function updateMaxIcon(isMaximized) {
  if (isMaximized) {
    document.getElementById("max-btn").innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" fill="#e3e3e3"><path d="M631.19-164.04q5.19 0 8.75-3.46 3.56-3.46 3.56-8.85v-339.84q0-5.39-3.56-8.85t-8.75-3.46H176.35q-5.39 0-8.85 3.46t-3.46 8.85v339.84q0 5.39 3.46 8.85t8.85 3.46h454.84Zm68.27-211.5v-55.96h84.19q5.39 0 8.85-3.46t3.46-8.85v-339.84q0-5.39-3.46-8.85t-8.85-3.46H329q-5.38 0-8.85 3.46-3.46 3.46-3.46 8.85v199.19h-55.96v-199.19q0-28.44 19.82-48.36 19.81-19.91 48.45-19.91h454.65q28.44 0 48.36 19.91 19.91 19.92 19.91 48.36v339.84q0 28.44-19.91 48.35-19.92 19.92-48.36 19.92h-84.19Zm-523.2 267.46q-28.35 0-48.27-19.91-19.91-19.92-19.91-48.36v-339.84q0-28.44 19.91-48.35 19.92-19.92 48.29-19.92h456.37q27.53 0 47.17 19.51t19.64 46.91v341.77q0 28.36-19.92 48.28-19.91 19.91-48.26 19.91H176.26Zm380.32-579.15ZM403.92-346.27Z"/></svg>`;
  } else {
    document.getElementById("max-btn").textContent = "◻";
  }
}

// Listen for maximize/unmaximize events from main
ipcRenderer.on("window-maximized", () => updateMaxIcon(true));
ipcRenderer.on("window-unmaximized", () => updateMaxIcon(false));

// The running-instance pill sits here; it lays itself out.
//
// There used to be a second progress bar in this spot, to the LEFT of the
// pill, fed by the same launch-progress events. It said the same thing the
// pop-down already says under the instance's name, and because it grew and
// shrank with the text it kept changing the pill's width -- which moves the
// pop-down anchored to it about while you are reading it. The pop-down is the
// one place progress is shown now.
(function setupInstanceSlot() {
  const container = document.getElementById('instance-processes');
  if (!container) return;
  container.style.display = 'flex';
  container.style.alignItems = 'center';
  container.style.gap = '10px';
})();

  ipcRenderer.send("get-players");
  ipcRenderer.on("players-list", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });
  ipcRenderer.on("players-updated", (event, newPlayers) => { players = newPlayers; updateLoginIcon(); });


  document.addEventListener("DOMContentLoaded", async () => {
    const updateEl = document.getElementById("update");
    const updateText = document.getElementById("updateText");
  
    if (!updateEl || !updateText) return;
  
    // Ask backend if update exists
    const result = await ipcRenderer.invoke("check-for-updates");

    // No update → keep hidden
    if (!result || !result.updateAvailable) {
      return;
    }

    updateEl.classList.add("show-update");

    // If autoUpdates is on, the main process quietly downloads ("stages") the
    // update in the background and installs it on the NEXT launch — we never
    // interrupt the current session. Reflect that state to the user.
    const pending = await ipcRenderer.invoke("get-pending-update");
    const staged = pending && pending.version === result.version;

    if (staged) {
      updateText.textContent = `Update ${result.version} ready — restart to apply`;
      updateEl.onclick = async () => {
        updateText.textContent = "Installing...";
        const res = await ipcRenderer.invoke("apply-staged-update");
        if (!res.success) {
          updateText.textContent = "Update failed!";
          console.error(res.error);
        }
      };
    } else {
      // Not staged yet (autoUpdates off, or still downloading). Offer a manual
      // "install now" that downloads and installs immediately.
      updateText.textContent = `Update to ${result.version}`;
      updateEl.onclick = async () => {
        updateText.textContent = "Downloading...";
        const res = await ipcRenderer.invoke(
          "download-and-install",
          result.assetURL,
          result.assetName
        );
        if (!res.success) {
          updateText.textContent = "Update failed!";
          console.error(res.error);
          updateEl.style.pointerEvents = "auto";
          return;
        }
        updateText.textContent = "Installing...";
      };
    }
  });
  

updateSideBar()

const currentFile = "frontend/" + window.location.pathname.split(/[/\\]/).pop();

// Track visible .page elements, or the whole HTML if no pages
const pages = document.querySelectorAll('.page');

if (pages.length === 0) {
  // No sub-pages; track the whole HTML as one page
  ipcRenderer.send('track-page', { file: currentFile, pageId: null });
} else {
  // MutationObserver tracks .page visibility
  let historySent = false;

  const observer = new MutationObserver(mutations => {
    mutations.forEach(m => {
      if (m.attributeName === 'style') {
        const el = m.target;
        const display = window.getComputedStyle(el).display;
        if (display !== 'none') {
          ipcRenderer.send('track-page', { file: currentFile, pageId: el.id });
        }
      }
    });
  });

  pages.forEach(p => observer.observe(p, { attributes: true, attributeFilter: ['style'] }));
}

// Listen for main telling us to show a page
ipcRenderer.on('show-page', (event, pageId) => {
  if (!pageId) return; // nothing to do, whole HTML is shown
  pages.forEach(p => p.style.display = p.id === pageId ? 'flex' : 'none');
});

document.getElementById('backBtn').addEventListener('click', () => {
  ipcRenderer.send('go-back');
});

document.getElementById('forwardBtn').addEventListener('click', () => {
  ipcRenderer.send('go-forward');
});

ipcRenderer.on("devtools-log", (event, text) => {
  console.log(text);
});
ipcRenderer.on("alert-message", (event, message) => {
  alert(message);
});

// ── The running / starting instances, top right ────────────────────────────
//
// It used to show only instances whose game process already existed, so the
// minutes a big modpack spends checking assets and downloading libraries
// looked like nothing was happening at all -- and more than one of them got a
// native <select>, which cannot show an icon, cannot show two lines, and
// opens as an OS menu nothing else in the launcher looks like.
//
// Now: anything STARTING counts as running, with what it is doing on it, and
// the list is a panel of the launcher's own. A row opens that instance; its
// button stops it, or cancels the launch when it has not started yet.
function instanceBarStyle() {
    if (document.getElementById("ib-style")) return;
    const s = document.createElement("style");
    s.id = "ib-style";
    s.textContent = `
      .ib-wrap { position:relative; display:flex; flex-direction:column; align-items:stretch; gap:0; }
      /* The whole of what is going on, under the pill: just the bar, because
         what it is doing is already written inside the pop-down. Two pixels,
         so the toolbar's height does not change when it appears. */
      .ib-progress { height:2px; margin:0 8px; border-radius:2px; background:rgba(255,255,255,0.14);
        overflow:hidden; display:none; }
      .ib-progress.on { display:block; }
      .ib-progress > i { display:block; height:100%; width:0; background:var(--base-color);
        transition:width 0.2s ease; }
      /* Indeterminate: something is happening but not how much of it. */
      .ib-progress.guess > i { width:35%; animation:ib-slide 1.1s ease-in-out infinite; }
      @keyframes ib-slide { 0% { margin-left:-35%; } 100% { margin-left:100%; } }
      .ib-pill { display:flex; align-items:center; gap:8px; padding:5px 8px 3px; border:none; cursor:pointer;
        background:none; color:var(--text-color); font:inherit; border-radius:var(--border-radius);
        max-width:260px; transition:background 0.15s ease; user-select:none; }
      .ib-pill:hover { background:rgba(255,255,255,0.08); }
      .ib-pill.flat { cursor:default; opacity:0.8; }
      .ib-pill.flat:hover { background:none; }
      .ib-pill .t { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ib-pill .caret { font-size:16px; opacity:0.7; line-height:1; transition:transform 0.18s ease; }
      .ib-wrap.open .ib-pill .caret { transform:rotate(180deg); }
      /* A dot that says something is happening without taking any room. */
      .ib-dot { width:7px; height:7px; border-radius:50%; flex:0 0 7px; background:#49c96d; }
      .ib-dot.busy { background:#e0a100; animation:ib-pulse 1.1s ease-in-out infinite; }
      @keyframes ib-pulse { 0%,100% { opacity:1; } 50% { opacity:0.35; } }

      /* Fixed, not absolute: #instance-processes is overflow:hidden so a long
         instance name truncates instead of shoving the window controls along,
         and an absolutely-positioned panel was clipped to the height of the
         toolbar by it. Fixed escapes that -- overflow does not clip a fixed
         descendant -- and the toolbar makes no containing block to trap it.
         Its position is set from the pill's rect when it opens.
         The width is FIXED too: it used to size to its content, so the status
         line growing from "Checking assets" to "Downloading files - 5.0 MB of
         20.0 MB" made the whole panel shuffle about while you were reading it. */
      .ib-panel { position:fixed; z-index:7200; width:330px; max-height:60vh; overflow-y:auto;
        padding:6px; background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); box-shadow:0 12px 34px rgba(0,0,0,0.55);
        opacity:0; visibility:hidden; transform:translateY(-6px) scale(0.985);
        transform-origin:top right; pointer-events:none;
        transition:opacity 0.16s ease, transform 0.16s ease, visibility 0s linear 0.16s; }
      .ib-wrap.open .ib-panel { opacity:1; visibility:visible; transform:none; pointer-events:auto;
        transition:opacity 0.16s ease, transform 0.16s ease, visibility 0s; }
      .ib-row { display:flex; align-items:center; gap:10px; padding:7px 8px; border-radius:var(--border-radius);
        cursor:pointer; transition:background 0.15s ease; }
      /* --menu-hover-bg is the sidebar's hover, which is far too strong for a
         row this small; a light wash reads as "this one" without shouting. */
      .ib-row:hover { background:rgba(255,255,255,0.07); }
      .ib-row img { width:28px; height:28px; flex:0 0 28px; border-radius:6px; object-fit:contain;
        background:var(--very-dark); image-rendering:pixelated; }
      .ib-row .n { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ib-row .s { font-size:11px; opacity:0.72; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .ib-row .mid { flex:1; min-width:0; }
      /* A thread of a progress bar under the status line. It lives HERE and
         nowhere else: there used to be a second one beside the pill in the
         toolbar, which both said the same thing twice and changed the pill's
         width as it went, moving the panel anchored to it. */
      .ib-bar { height:2px; margin-top:4px; border-radius:2px; background:rgba(255,255,255,0.14);
        overflow:hidden; display:none; }
      .ib-bar.on { display:block; }
      .ib-bar > i { display:block; height:100%; background:var(--base-color); transition:width 0.2s ease; }
      .ib-act { flex:0 0 auto; border:none; background:rgba(255,0,0,0.55); color:var(--text-color);
        border-radius:var(--border-radius); padding:5px 8px; cursor:pointer; font:inherit; font-size:11px;
        user-select:none; white-space:nowrap; transition:background 0.15s ease; }
      .ib-act:hover { background:rgba(255,0,0,0.8); }`;
    document.head.appendChild(s);
}

async function createInstanceInfoBar(container) {
    instanceBarStyle();
    const wrap = document.createElement("div");
    wrap.className = "ib-wrap";
    // A div, not a button: the toolbar styles every <button> inside it as a
    // 36x36 square window control, at a specificity nothing here can beat
    // without an inline-style arms race.
    const pill = document.createElement("div");
    pill.className = "ib-pill";
    pill.setAttribute("role", "button");
    pill.tabIndex = 0;
    // The pill's parts are made ONCE and only their text changes afterwards.
    // Rebuilding them on every progress frame meant the element under the
    // cursor was replaced between mousedown and click, so the click never
    // landed -- which is why the pop-down would not open while something was
    // downloading, exactly when you most wanted it.
    const dot = document.createElement("span");
    const pillText = document.createElement("span");
    pillText.className = "t";
    const caret = document.createElement("i");
    caret.className = "material-icons caret";
    caret.textContent = "expand_more";
    pill.append(dot, pillText, caret);

    const progress = document.createElement("div");
    progress.className = "ib-progress";
    const progressFill = document.createElement("i");
    progress.appendChild(progressFill);

    const panel = document.createElement("div");
    panel.className = "ib-panel";
    wrap.append(pill, progress, panel);
    container.appendChild(wrap);

    const names = new Map();        // id -> profile name, so a refresh is not a round trip
    const rows = new Map();         // id -> the row's elements, kept across repaints
    let entries = [];
    let open = false;

    const place = () => {
        // The whole widget, so the panel clears the progress bar under the
        // pill rather than opening over it.
        const r = wrap.getBoundingClientRect();
        panel.style.top = (r.bottom + 6) + "px";
        panel.style.right = Math.max(6, window.innerWidth - r.right) + "px";
    };
    const setOpen = (v) => {
        open = !!v && entries.length > 0;
        if (open) place();              // before the class, so it animates from the right spot
        wrap.classList.toggle("open", open);
    };
    window.addEventListener("resize", () => { if (open) place(); });
    pill.onclick = (e) => { e.stopPropagation(); if (entries.length) setOpen(!open); };
    document.addEventListener("mousedown", (e) => { if (open && !wrap.contains(e.target)) setOpen(false); });
    document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") setOpen(false); });

    async function nameOf(id) {
        if (names.has(id)) return names.get(id);
        let n = null;
        try { const p = await ipcRenderer.invoke("get-profile-by-id", id); n = p && p.name; } catch { /* gone */ }
        names.set(id, n || String(id));
        return names.get(id);
    }

    // Bytes read nothing as "3847201/9120033"; files read fine as "1200/4000".
    const human = (n) => {
        if (!Number.isFinite(n)) return "";
        if (n < 1024) return n + " B";
        if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
        return (n / 1048576).toFixed(1) + " MB";
    };
    function statusOf(e) {
        if (!e.starting) return "Running";
        const { label, current, total, bytes } = e;
        if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
            return `${label} — ${bytes ? `${human(current)} of ${human(total)}` : `${current} / ${total}`}`;
        }
        return label || "Getting ready";
    }
    const fractionOf = (e) => (e.starting && Number.isFinite(e.current) && Number.isFinite(e.total) && e.total > 0
        ? Math.max(0, Math.min(1, e.current / e.total)) : null);

    // Read both lists and fold them into one. An instance that is starting AND
    // already has a process is running: the starting entry is dropped the
    // moment the game is up, but the two calls are not atomic.
    async function read() {
        let running = [], starting = [];
        try { running = await ipcRenderer.invoke("get-running-instances") || []; } catch { /* ignore */ }
        try { starting = await ipcRenderer.invoke("get-launching-instances") || []; } catch { /* older build */ }
        const out = running.map(r => ({ id: String(r.id), pid: r.pid, starting: false }));
        const up = new Set(out.map(o => o.id));
        for (const s of starting) {
            if (up.has(String(s.id))) continue;
            out.push({
                id: String(s.id), pid: null, starting: true,
                label: s.label, current: s.current, total: s.total, bytes: s.bytes,
            });
        }
        return out;
    }

    // Make a row, once. Everything after that is setRow().
    function makeRow(id) {
        const row = document.createElement("div");
        row.className = "ib-row";
        const img = document.createElement("img");
        img.alt = "";
        const mid = document.createElement("div");
        mid.className = "mid";
        const n = document.createElement("div");
        n.className = "n";
        const st = document.createElement("div");
        st.className = "s";
        const bar = document.createElement("div");
        bar.className = "ib-bar";
        const fill = document.createElement("i");
        bar.appendChild(fill);
        mid.append(n, st, bar);
        const act = document.createElement("div");   // see the pill above
        act.className = "ib-act";
        act.setAttribute("role", "button");
        act.tabIndex = 0;
        row.append(img, mid, act);
        row.onclick = () => {
            setOpen(false);
            window.location.href = `instances.html?i=${encodeURIComponent(id)}`;
        };
        ipcRenderer.invoke("get-profile-by-id", id).then(p => {
            if (p && window.instanceIconInto) window.instanceIconInto(img, p);
            else img.style.visibility = "hidden";
        }).catch(() => { img.style.visibility = "hidden"; });
        return { row, n, st, bar, fill, act };
    }

    function setRow(r, e, name) {
        if (r.n.textContent !== name) r.n.textContent = name;
        const status = statusOf(e);
        if (r.st.textContent !== status) r.st.textContent = status;
        const frac = fractionOf(e);
        r.bar.classList.toggle("on", frac != null);
        if (frac != null) r.fill.style.width = (frac * 100).toFixed(1) + "%";
        const label = e.starting ? "Cancel" : "Stop";
        if (r.act.textContent !== label) r.act.textContent = label;
        r.act.onclick = async (ev) => {
            ev.stopPropagation();
            if (r.act.dataset.busy) return;
            r.act.dataset.busy = "1";
            r.act.style.opacity = "0.5";
            try {
                if (e.starting) await ipcRenderer.invoke("cancel-launch", { profileId: e.id });
                else await ipcRenderer.invoke("stop-instance-by-pid", e.pid);
            } catch { /* it may have gone by itself */ }
            // The row outlives the action now -- an instance that is cancelled
            // while starting and then launched again is the SAME row -- so the
            // guard has to be let go of, or its button would work once and
            // never again.
            delete r.act.dataset.busy;
            r.act.style.opacity = "";
            await refreshInstances(true);
        };
    }

    async function paint() {
        // ── the pill ──
        const any = entries.length > 0;
        pill.classList.toggle("flat", !any);
        dot.className = any ? ("ib-dot" + (entries.some(e => e.starting) ? " busy" : "")) : "";
        dot.style.display = any ? "" : "none";
        caret.style.display = any ? "" : "none";
        const text = !any ? "No running instances"
            : entries.length === 1 ? await nameOf(entries[0].id)
                : `${entries.length} instances`;
        if (pillText.textContent !== text) pillText.textContent = text;
        pill.title = entries.length === 1 ? statusOf(entries[0]) : "";
        if (!any) setOpen(false);

        // One bar for everything starting at once: the furthest along, since
        // that is the one about to finish. No text -- the pop-down says what
        // each of them is doing.
        const busy = entries.filter(e => e.starting);
        const fracs = busy.map(fractionOf).filter(f => f != null);
        progress.classList.toggle("on", busy.length > 0);
        progress.classList.toggle("guess", busy.length > 0 && !fracs.length);
        if (fracs.length) progressFill.style.width = (Math.max(...fracs) * 100).toFixed(1) + "%";

        // ── the panel ──
        const live = new Set(entries.map(e => e.id));
        for (const [id, r] of rows) {
            if (!live.has(id)) { r.row.remove(); rows.delete(id); }
        }
        let prev = null;
        for (const e of entries) {
            let r = rows.get(e.id);
            if (!r) { r = makeRow(e.id); rows.set(e.id, r); }
            setRow(r, e, await nameOf(e.id));
            // Keep the panel in the order the entries are in, without
            // detaching a row that is already where it should be.
            const want = prev ? prev.nextSibling : panel.firstChild;
            if (r.row !== want) panel.insertBefore(r.row, want);
            prev = r.row;
        }
    }

    const same = (a, b) => a.length === b.length && a.every((x, i) =>
        x.id === b[i].id && x.pid === b[i].pid && x.starting === b[i].starting
        && x.label === b[i].label && x.current === b[i].current && x.total === b[i].total);

    async function refreshInstances(force) {
        const next = await read();
        if (!force && same(next, entries)) return;
        entries = next;
        await paint();
    }

    // Progress frames arrive as they happen, so the status line keeps up
    // between polls instead of being up to three seconds stale.
    ipcRenderer.on("launch-progress", (_e, p) => {
        if (!p) return;
        const id = String(p.profileId);
        const row = entries.find(x => x.id === id && x.starting);
        if (p.done) { refreshInstances(); return; }
        if (!row) { refreshInstances(); return; }   // a launch we had not seen yet
        if (row.label === p.label && row.current === p.current && row.total === p.total) return;
        Object.assign(row, { label: p.label, current: p.current, total: p.total, bytes: !!p.bytes });
        paint();
    });

    // Initial + periodic updates. The poll is the backstop; the event above is
    // what actually keeps it current.
    await refreshInstances(true);
    setInterval(() => refreshInstances(), 3000);
}

async function allowCracked(newValue, password) {
  const res = await ipcRenderer.invoke('update-allow-cracked-testing', { value: !!newValue, password });
  if (res && res.success) {
    console.log('Updated! new value: ' + res.value);
  } else {
    console.log('Failed to update: ' + (res?.error || 'Unknown error'));
  }
}

const title = document.querySelector('div.drag-region'); // only matches <div class="drag-region">

if (title && Math.random() < 0.1) {
  title.style.cursor = 'help';
  title.onclick = () => {
    shell.openExternal("https://youtu.be/XOq97dxiAfE");
  };
}
let settings;
let third;
async () => {
  settings = await ipcRenderer.invoke('get-settings')
  third = getSetting('thirdColor') || getMiddleColor(base, secondary);
};

function getSetting(key) {
  return settings[key] ?? defaultSettings[key];
}

createInstanceInfoBar(document.getElementById("instance-processes"));

// ── Offline handling ──
// When there's no internet, grey out and block the things that need it (the
// Modrinth browser, and anything tagged data-needs-net) so the user gets a clear
// disabled state instead of a page full of "failed to fetch" errors.
function applyOnlineState() {
  const off = !navigator.onLine;
  if (document.body) document.body.classList.toggle('app-offline', off);
  const modrinth = document.querySelector('.sidebar a[href="modrinth.html"]');
  if (modrinth) {
    modrinth.style.pointerEvents = off ? 'none' : '';
    modrinth.style.opacity = off ? '0.45' : '';
    modrinth.title = off ? 'Unavailable while offline' : '';
  }
}
window.addEventListener('online', applyOnlineState);
window.addEventListener('offline', applyOnlineState);
applyOnlineState();

// ── Onboarding ──
// The tour walks the user through the sidebar, so it has to be able to resume
// on whatever page a sidebar click opens — which means every page with a
// sidebar needs onboarding.js. A few pages include it themselves; load it here
// for the rest. (onboarding.js no-ops if it has already run.)
if (!document.querySelector('script[src$="onboarding.js"]')) {
  const ob = document.createElement('script');
  ob.src = 'onboarding.js';
  document.head.appendChild(ob);
}
