/**
 * Still renders of a skin, for anywhere a list of skins has to be chosen from.
 *
 *   const url = await SkinStill.render('data:image/png;base64,...', 'slim');
 *
 * A raw 64x64 skin sheet is not something a person can pick a skin out of --
 * it is a scattered atlas of limbs. Every list that offers skins therefore
 * shows a render of the player wearing it. This is that renderer, in one place:
 * ONE offscreen WebGL context no matter how many lists or how many skins, with
 * renders serialised through it, because a context per thumbnail exhausts the
 * browser's supply (there is a hard limit, and the oldest gets killed).
 *
 * skinview3d is half a megabyte, so it is fetched only when the first render is
 * asked for. A page that never shows a skin list never pays for it.
 *
 * `render` answers null rather than throwing when there is no WebGL to be had
 * or the sheet will not load, so a caller can leave its stand-in in place.
 */
(function () {
  if (window.SkinStill) return;

  const WIDTH = 160, HEIGHT = 260;
  let loading = null;
  let still = null;              // { v, canvas }, or false once known impossible
  let queue = Promise.resolve();

  // The bundle may already be on the page (the skin editor and the friends
  // panel both load it up front); only fetch it if it is not.
  function haveViewer() {
    if (typeof skinview3d !== "undefined") return Promise.resolve(true);
    if (loading) return loading;
    loading = new Promise((done) => {
      const s = document.createElement("script");
      s.src = "skinview3d.bundle.js";
      s.onload = () => done(typeof skinview3d !== "undefined");
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
    return loading;
  }

  function viewer() {
    if (still !== null) return still;
    try {
      const canvas = document.createElement("canvas");
      const v = new skinview3d.SkinViewer({ canvas, width: WIDTH, height: HEIGHT, preserveDrawingBuffer: true });
      v.zoom = 0.9;
      v.autoRotate = false;
      v.renderPaused = true;     // nothing animates; each render is asked for
      still = { v, canvas };
    } catch {
      still = false;
    }
    return still;
  }

  /**
   * A PNG data URL of the player wearing `src`, facing forward, or null.
   * `model` is "slim" or "default" ("classic" is accepted as default too).
   */
  function render(src, model) {
    const run = async () => {
      if (!src) return null;
      if (!await haveViewer()) return null;
      const s = viewer();
      if (!s) return null;
      try {
        await s.v.loadSkin(src, { model: model === "slim" ? "slim" : "default" });
        const t = s.v.playerWrapper || s.v.playerObject;
        if (t) t.rotation.y = 0;
        s.v.render();
        return s.canvas.toDataURL();
      } catch {
        return null;
      }
    };
    // One at a time: the single viewer is reloaded for each skin.
    queue = queue.then(run, run);
    return queue;
  }

  /**
   * Fill `box` with a render of `src`, drawing the flat sheet faintly behind it
   * in the meantime so a grid is never a wall of empty squares. Returns a
   * promise for whether a render landed.
   */
  async function into(box, src, model) {
    if (!box) return false;
    const flat = document.createElement("img");
    flat.src = src;
    flat.alt = "";
    flat.style.cssText = "width:60%;image-rendering:pixelated;opacity:0.45;";
    box.replaceChildren(flat);
    const url = await render(src, model);
    if (!url || !box.isConnected) return false;
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    img.style.cssText = "width:100%;height:100%;object-fit:contain;display:block;";
    box.replaceChildren(img);
    return true;
  }

  window.SkinStill = { render, into, WIDTH, HEIGHT };
})();
