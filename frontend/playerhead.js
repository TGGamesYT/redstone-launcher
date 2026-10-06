/**
 * Player heads, drawn by the launcher instead of fetched from an avatar service.
 *
 * Every head used to be an <img> pointed straight at minotar.net or
 * mc-heads.net. Those are rate limited, and when they throttle they answer 200
 * with a default Steve rather than an error — so under load the accounts list,
 * the sidebar and the friends panel filled up with the wrong faces and nothing
 * said so. The main process now builds each head out of the skin Mojang is
 * actually serving (the face at (8,8) with the hat layer at (40,8) over it) and
 * caches it by texture hash, so the second look costs nothing and a failure
 * gives a default head that is KNOWN to be a default.
 *
 *   PlayerHead.set(img, { name, uuid, size, offline, playerId })
 *   await PlayerHead.url({ ... })  -> { url, from } or { url: null }
 *
 * What comes back is the head TEXTURE — 8x8 for an ordinary skin sheet, more
 * for an HD one — not a render at some pixel size. It is drawn with
 * image-rendering: pixelated, so any size looks like the block of pixels it is,
 * and one cache entry serves every size. `size` is only a default for an
 * element the stylesheet does not size itself.
 *
 * `offline: true` skips Mojang entirely: an offline account's name belongs to
 * nobody, and showing the real owner's face for it would be a lie. It does NOT
 * mean no skin — pass `playerId` (this launcher's own account id) and an
 * offline account that has a skin here gets that skin's face, because that is
 * what it looks like in game. Without one it gets the default picked for its
 * uuid, out of the same nine the skins page offers.
 *
 * After `set`, the element carries data-head="skin", "offline-skin" or
 * "default", so a caller can tell a real face from a stand-in.
 */
(function () {
  if (window.PlayerHead) return;
  let ipcRenderer = null;
  try { ({ ipcRenderer } = require('electron')); } catch { /* not in the app */ }

  // A head is wanted many times over for the same player (an account row, the
  // sidebar, a friend). One request each.
  // The size is NOT part of the key. What comes back is the head texture at
  // its own resolution — 8x8 for an ordinary skin — and CSS draws it at
  // whatever size the element is. A head asked for at 24px and the same head
  // asked for at 38px are therefore one request and one cache entry, where
  // they used to be two of each (and two files on disk).
  let inFlight = new Map();
  const key = (o) => [
    o.offline ? 'off' : 'on',
    o.playerId == null ? '' : String(o.playerId),
    String(o.uuid || '').replace(/-/g, '').toLowerCase(),
    String(o.name || '').toLowerCase(),
  ].join('|');

  async function url(opts) {
    const o = opts || {};
    if (!ipcRenderer) return { url: null, from: 'none' };
    const k = key(o);
    if (inFlight.has(k)) return inFlight.get(k);
    const p = ipcRenderer
      .invoke('head:get', {
        name: o.name, uuid: o.uuid,
        offline: !!o.offline, playerId: o.playerId,
      })
      .then(r => (r && r.url) ? r : { url: null, from: 'none' })
      .catch(() => ({ url: null, from: 'none' }));
    inFlight.set(k, p);
    // Kept, not evicted on settle: these are tiny and the same faces are asked
    // for over and over as lists redraw.
    if (inFlight.size > 400) inFlight.delete(inFlight.keys().next().value);
    return p;
  }

  // Every element a head has been put into, so they can all be redrawn when a
  // face changes. Disconnected ones are dropped as they are found.
  const live = new Set();

  // Fill an <img>. The element is tagged with a token first so that a second
  // call for a different player, arriving while the first is still in the air,
  // cannot have its answer painted over by the slower one.
  function set(img, opts) {
    if (!img) return;
    const o = img.__headOpts = opts || {};
    live.add(img);
    const token = (img.__headToken = (img.__headToken || 0) + 1);
    img.style.imageRendering = 'pixelated';
    // What arrives is the 8x8 head texture, so an <img> with nothing else
    // sizing it would now draw at eight pixels across. `size` becomes the
    // width/height ATTRIBUTES rather than inline styles on purpose: a
    // presentational attribute loses to any CSS rule, so a head the stylesheet
    // already sizes keeps that size, and one that relied on the old render
    // being 32px wide still gets 32px.
    const px = Number(o.size);
    if (px > 0 && !img.hasAttribute('width')) { img.width = px; img.height = px; }
    url(o).then(r => {
      if (img.__headToken !== token || !img.isConnected) return;
      if (r && r.url) {
        img.src = r.url;
        img.dataset.head = r.from;
      } else {
        img.removeAttribute('src');
        img.dataset.head = 'none';
      }
    });
  }

  // An offline account's skin changed, so its face did. Drop what is cached and
  // redraw everything on the page — the main process caches by the skin's own
  // content, so anything that did not change costs nothing to ask for again.
  function refresh() {
    inFlight = new Map();
    for (const img of [...live]) {
      if (!img.isConnected) { live.delete(img); continue; }
      if (img.__headOpts) set(img, img.__headOpts);
    }
  }

  if (ipcRenderer) {
    try { ipcRenderer.on('heads-changed', () => refresh()); } catch { /* no event, no refresh */ }
  }

  window.PlayerHead = { set, url, refresh };
})();
