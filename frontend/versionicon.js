/**
 * The default icon for an instance, from the Minecraft version it runs.
 *
 * A manually created instance used to get the generic launcher icon whatever
 * version it was. Instead it gets the block or item that version is remembered
 * for, drawn as an isometric render — or, where there is no such block, the
 * snapshot mark, the plain release mark, or the old launcher icon. Which of
 * those applies is decided in the main process (backend/version-icons.js);
 * this draws the answer and remembers it.
 *
 *   await VersionIcon.get("1.21.9")        -> a data: URL, or null
 *   await VersionIcon.get(v, instanceId)   -> the same, with that instance's
 *                                             packs and mods in the picture
 *
 * Drawing happens once per version: the main process keeps the PNG, so every
 * instance made on that version afterwards costs a single read.
 */
(function () {
  if (window.VersionIcon) return;
  let ipcRenderer = null;
  try { ({ ipcRenderer } = require('electron')); } catch { /* not in the app */ }

  // The marks for the cases with no block of their own. Bundled rather than
  // hot-linked, so an instance can be made with no connection.
  const FALLBACK = {
    snapshot: 'assets/icons/Snapshot_icon.png',
    release: 'assets/icons/Java_Edition_icon.png',
    legacy: 'assets/icons/Launcher_Icon.png',
  };

  const pending = new Map();

  async function get(version, instanceId = null) {
    const v = String(version || '').trim();
    if (!v || !ipcRenderer) return null;
    const key = `${v}|${instanceId ?? ''}`;
    if (pending.has(key)) return pending.get(key);
    const p = (async () => {
      let r;
      try { r = await ipcRenderer.invoke('icon:versionIcon', { version: v, profileId: instanceId }); }
      catch { return null; }
      if (!r) return null;
      if (r.dataUrl) return r.dataUrl;                     // drawn before
      if (r.kind !== 'model' || !r.draw) return FALLBACK[r.kind] || FALLBACK.release;
      if (!window.BlockRender) return FALLBACK.release;
      const d = r.draw;
      const url = await window.BlockRender.render(d, {
        size: 256, rotX: d.rotX || 0, rotY: d.rotY || 0, uvlock: !!d.uvlock,
      });
      if (!url) return FALLBACK.release;
      ipcRenderer.invoke('icon:storeVersionIcon', { version: v, dataUrl: url }).catch(() => { });
      return url;
    })();
    pending.set(key, p);
    return p;
  }

  /** What an instance on this version should start with, as a stored icon. */
  async function forNewInstance(version, instanceId = null) {
    const url = await get(version, instanceId);
    // A bundled fallback is a path, not data; an instance icon has to be
    // self-contained because it ends up in serverinfo.json and in shortcuts.
    if (!url || url.startsWith('data:')) return url;
    try {
      const blob = await (await fetch(url)).blob();
      return await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
    } catch { return null; }
  }

  window.VersionIcon = { get, forNewInstance, FALLBACK };
})();
