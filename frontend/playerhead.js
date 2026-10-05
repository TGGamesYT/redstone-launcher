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
 *   PlayerHead.set(img, { name, uuid, size, offline })
 *   await PlayerHead.url({ name, uuid, size, offline })  -> data URL or null
 *
 * `offline: true` skips Mojang entirely: an offline account's name belongs to
 * nobody, and showing the real owner's face for it would be a lie.
 *
 * After `set`, the element carries data-head="skin" or data-head="default", so
 * a caller can tell the two apart.
 */
(function () {
  if (window.PlayerHead) return;
  let ipcRenderer = null;
  try { ({ ipcRenderer } = require('electron')); } catch { /* not in the app */ }

  // A head is wanted many times over for the same player (an account row, the
  // sidebar, a friend). One request each.
  const inFlight = new Map();
  const key = (o) => `${o.offline ? 'off' : 'on'}|${String(o.uuid || '').replace(/-/g, '').toLowerCase()}|${String(o.name || '').toLowerCase()}|${o.size || 32}`;

  async function url(opts) {
    const o = opts || {};
    if (!ipcRenderer) return null;
    const k = key(o);
    if (inFlight.has(k)) return inFlight.get(k);
    const p = ipcRenderer
      .invoke('head:get', { name: o.name, uuid: o.uuid, size: o.size || 32, offline: !!o.offline })
      .then(r => (r && r.url) ? r : { url: null, from: 'none' })
      .catch(() => ({ url: null, from: 'none' }));
    inFlight.set(k, p);
    // Kept, not evicted on settle: these are tiny and the same faces are asked
    // for over and over as lists redraw.
    if (inFlight.size > 400) inFlight.delete(inFlight.keys().next().value);
    return p;
  }

  // Fill an <img>. The element is tagged with a token first so that a second
  // call for a different player, arriving while the first is still in the air,
  // cannot have its answer painted over by the slower one.
  function set(img, opts) {
    if (!img) return;
    const o = opts || {};
    const token = (img.__headToken = (img.__headToken || 0) + 1);
    img.style.imageRendering = 'pixelated';
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

  window.PlayerHead = { set, url };
})();
