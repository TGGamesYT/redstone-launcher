// Shared icon picker modal. Lets the user choose a predefined icon, a custom
// image file, or (for an instance/server) one of its world icons. Resolves the
// chosen icon as a data:image/png URL via onPick.
(function () {
  const { ipcRenderer } = require('electron');

  // Predefined icons — Minecraft block renders bundled in assets/icons.
  const PRESET_ICONS = [
    'Block_of_Diamond_JE5_BE3.png', 'Block_of_Emerald_JE4_BE3.png', 'Block_of_Gold_JE6_BE3.png',
    'Block_of_Iron_JE4_BE3.png', 'Block_of_Copper_JE1_BE1.png', 'Block_of_Lapis_Lazuli_JE3_BE3.png',
    'Diamond_Ore_JE5_BE5.png', 'Deepslate_Diamond_Ore_JE2_BE1.png', 'Redstone_Ore_JE4_BE3.png',
    'Deepslate_Redstone_Ore_JE2_BE1.png', 'Cobblestone_JE5_BE3.png', 'Reinforced_Deepslate_JE1_BE1.png',
    'Beacon_JE6_BE2.png', 'Piston_(U)_JE3.png', 'Chest_(S)_JE2.png', 'Copper_Chest_(S)_JE2.png',
    'Xmas_Chest.png', 'Chorus_Flower_JE2_BE2.png', 'Camera_(block).png',
    'Impulse_Command_Block_JE5_BE2.png', 'Chain_Command_Block_JE3_BE2.png',
    'Repeating_Command_Block_JE4_BE2.png', 'Missing_Model_JE2.png', 'Missing_Tile_BE3.png',
  ];
  const presetSrc = (file) => 'assets/icons/' + file;

  // The edition marks, straight from the wiki.
  const EDITION_ICONS = [
    { label: 'Java Edition', url: 'https://minecraft.wiki/images/thumb/Java_Edition_icon_3.png/600px-Java_Edition_icon_3.png?f7112&20230420150005' },
    { label: 'Snapshot', url: 'https://minecraft.wiki/images/thumb/Snapshot_icon.png/600px-Snapshot_icon.png?87457&20230420150007' },
    { label: 'Bedrock Edition', url: 'https://minecraft.wiki/images/thumb/Bedrock_Edition_App_Store_icon_2.png/600px-Bedrock_Edition_App_Store_icon_2.png?ec415&20230919155825' },
    { label: 'Minecraft Preview', url: 'https://minecraft.wiki/images/thumb/Minecraft_Preview_App_Store_icon_2.png/600px-Minecraft_Preview_App_Store_icon_2.png?37044&20230628220644' },
    { label: 'Minecraft Dungeons', url: 'https://minecraft.wiki/images/Dungeons.svg?39ef5' },
    { label: 'Code Connection', url: 'https://minecraft.wiki/images/Code_Connection.png?fb6cd&20230318022334' },
    { label: 'Launcher', url: 'https://minecraft.wiki/images/Launcher_Icon.png?7773a&20210401155244' },
  ];
  function fileToDataUrl(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  // Convert a (possibly relative) image URL to a self-contained data: URL so the
  // chosen icon survives being embedded in serverinfo.json / a desktop shortcut.
  function urlToDataUrl(url) {
    return fetch(url).then(r => r.blob()).then(b => new Promise((res, rej) => {
      const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b);
    }));
  }
  // A screenshot is a 16:9 file of a megabyte or two; an icon is a small square
  // that gets embedded in serverinfo.json and desktop shortcuts. Centre-crop to
  // a square and downscale, so what the picker previews is exactly what the
  // icon ends up being.
  // An absolute path from the main process -> something an <img> can load.
  // Each segment is encoded so spaces and # survive, but a Windows drive letter
  // keeps its colon: file:///C%3A/... doesn't resolve.
  const toFileUrl = (p) => {
    const norm = String(p).replace(/\\/g, '/');
    const enc = norm.split('/')
      .map(seg => /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))
      .join('/');
    return 'file://' + (enc.startsWith('/') ? '' : '/') + enc;
  };

  const ICON_PX = 128;
  function squareIconDataUrl(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => {
        try {
          const side = Math.min(im.naturalWidth, im.naturalHeight);
          const sx = (im.naturalWidth - side) / 2, sy = (im.naturalHeight - side) / 2;
          const cv = document.createElement('canvas');
          cv.width = ICON_PX; cv.height = ICON_PX;
          cv.getContext('2d').drawImage(im, sx, sy, side, side, 0, 0, ICON_PX, ICON_PX);
          res(cv.toDataURL('image/png'));
        } catch (e) { rej(e); }
      };
      im.onerror = rej;
      im.src = src;
    });
  }

  // Is every pixel opaque? A photo or a rendered banner is; a block render with
  // a transparent surround is not, and masking one of those to a circle just
  // eats its corners for no reason. Drives the default of the circle toggle.
  function isFullyOpaque(im) {
    try {
      const n = 64;
      const cv = document.createElement('canvas');
      cv.width = n; cv.height = n;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(im, 0, 0, n, n);
      const d = cx.getImageData(0, 0, n, n).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return false;
      return true;
    } catch { return false; }   // a tainted canvas is not worth guessing about
  }

  // ── Hold right-click on a cell to see it big ──────────────────────────────
  // A 56px cell is too small to tell one grey block render from another, or to
  // see which of forty screenshots this one is. Holding the right button blows
  // the cell up over the middle of the screen for as long as it is held; let go
  // and it is gone. Nothing is picked by it — the left click still does that —
  // so it is safe to go through the whole grid this way.
  //
  // It is wired on the modal, not on each cell, so cells that arrive later (the
  // panorama, the screenshots, a server that was still being pinged) are
  // covered without anyone remembering to opt them in.
  let _peek = null;
  function hidePeek() {
    if (!_peek) return;
    _peek.remove();
    _peek = null;
  }
  function showPeek(src, label) {
    hidePeek();
    _peek = document.createElement('div');
    _peek.style.cssText = 'position:fixed; inset:0; z-index:6300; display:flex;'
      + 'flex-direction:column; align-items:center; justify-content:center; gap:10px;'
      + 'background:rgba(0,0,0,0.55); pointer-events:none;';
    const im = document.createElement('img');
    im.src = src;
    // A short side of 320px: big enough to read a 16px texture, small enough
    // that a 4K screenshot still fits on a laptop screen.
    im.style.cssText = 'max-width:min(70vw,520px); max-height:70vh; min-width:120px;'
      + 'border-radius:8px; box-shadow:0 10px 40px rgba(0,0,0,0.6); background:#0006;';
    // pixelart.js decides whether this wants smoothing, from the size it
    // actually is against the size it is being drawn at.
    _peek.appendChild(im);
    if (label) {
      const cap = document.createElement('div');
      cap.textContent = label;
      cap.style.cssText = 'font-size:13px; color:#fff; text-shadow:0 1px 3px #000; max-width:70vw; text-align:center;';
      _peek.appendChild(cap);
    }
    document.body.appendChild(_peek);
  }
  function wirePeek(root) {
    const cellAt = (e) => (e.target && e.target.closest) ? e.target.closest('.ip-cell') : null;
    // Suppress the context menu over a cell only, so right-clicking the rest of
    // the modal behaves normally.
    root.addEventListener('contextmenu', (e) => { if (cellAt(e)) e.preventDefault(); });
    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 2) return;
      const cell = cellAt(e);
      const img = cell && cell.querySelector('img');
      if (!img || !img.getAttribute('src')) return;
      e.preventDefault();
      showPeek(img.src, cell.title || '');
    });
    // Let go anywhere — including outside the modal, which is where the pointer
    // ends up if the preview is big — and it closes. Losing the window counts.
    for (const ev of ['pointerup', 'pointercancel']) window.addEventListener(ev, hidePeek);
    window.addEventListener('blur', hidePeek);
    root.addEventListener('scroll', hidePeek, true);
  }

  // ── The version panorama, as a panorama ───────────────────────────────────
  // It used to be the six faces laid out flat in a horizontal strip you
  // scrolled sideways, which is not what a panorama looks like: the cube is
  // unfolded, the corners are wrong, and the up and down faces are missing
  // entirely. This puts the camera inside the cube, exactly where the title
  // screen puts it, and lets you drag to look around.
  //
  // three.js is loaded on demand — it is already vendored for the skin editor,
  // and the icon picker has no other use for it.
  let _threePromise = null;
  function loadThree() {
    if (!_threePromise) _threePromise = import('./three.module.js');
    return _threePromise;
  }

  // Minecraft's panorama faces are 0 north, 1 east, 2 south, 3 west, 4 up,
  // 5 down. three's BoxGeometry wants its materials as +X, -X, +Y, -Y, +Z, -Z,
  // and the game faces north along -Z.
  //
  // East and west are the other way round here because the cube is turned
  // inside out by scaling X by -1 (so the faces are not mirrored), and that
  // swaps which side of the box the +X and -X materials land on. Checked by
  // rendering six labelled faces and looking in each direction.
  const FACE_ORDER = [3, 1, 4, 5, 2, 0];
  // The same inside-out cube leaves the up and down faces turned through half a
  // turn, so those two textures are rotated back.
  const FACE_SPIN = { 2: Math.PI, 3: Math.PI };

  function openPanorama(p, onCrop) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay active';
    ov.style.zIndex = 6100;
    ov.innerHTML = `<div class="modal-content" style="max-width:900px; width:94%;">
      <div class="modal-header"><h2>Pick a spot</h2><button class="modal-close" id="ipPanX">✕</button></div>
      <p style="margin:0 0 8px; font-size:12px; opacity:0.75;">Drag to look around · scroll to zoom · the square is what gets cropped.</p>
      <div id="ipPanStage" style="position:relative; border:1px solid var(--border-dark);
        border-radius:var(--border-radius); overflow:hidden; background:var(--menu-bg); cursor:grab;">
        <canvas id="ipPanCv" style="display:block; width:100%; height:360px;"></canvas>
        <div id="ipPanFrame" style="position:absolute; pointer-events:none; border:2px solid #fff;
          box-shadow:0 0 0 9999px rgba(0,0,0,0.45); border-radius:6px;"></div>
      </div>
      <div class="modal-actions">
        <button id="ipPanCancel">Cancel</button>
        <button id="ipPanUse" class="primary">Use this view</button>
      </div>
    </div>`;
    document.body.appendChild(ov);

    const stage = ov.querySelector('#ipPanStage');
    const cv = ov.querySelector('#ipPanCv');
    const frame = ov.querySelector('#ipPanFrame');
    let disposed = false, raf = null, renderer = null;
    const close = () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      try { renderer && renderer.dispose(); } catch { }
      try { renderer && renderer.forceContextLoss(); } catch { }
      ov.remove();
    };
    ov.querySelector('#ipPanX').onclick = close;
    ov.querySelector('#ipPanCancel').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });

    const fail = (why) => {
      const box = ov.querySelector('#ipPanStage');
      if (box) box.innerHTML = '<div style="padding:28px 12px;opacity:0.75;font-size:13px;">'
        + (why || "Couldn't read this version's panorama.") + '</div>';
    };

    // The crop square: the biggest square that fits, centred — so what you
    // frame is what you get.
    const sizeFrame = () => {
      const r = stage.getBoundingClientRect();
      const side = Math.min(r.width, r.height);
      frame.style.width = frame.style.height = side + 'px';
      frame.style.left = ((r.width - side) / 2) + 'px';
      frame.style.top = ((r.height - side) / 2) + 'px';
    };

    loadThree().then(async (THREE) => {
      if (disposed) return;
      const faces = p.faces || [];
      if (faces.length < 6) return fail("This version's panorama is incomplete.");

      const loader = new THREE.TextureLoader();
      const load = (src) => new Promise(res => loader.load(src, res, undefined, () => res(null)));
      const textures = await Promise.all(FACE_ORDER.map(i => load(faces[i])));
      if (disposed) return;
      if (textures.some(t => !t)) return fail("Couldn't read this version's panorama.");

      try {
        renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
      } catch { return fail('This machine cannot render 3D.'); }
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(80, 1, 0.1, 100);
      textures.forEach((t, slot) => {
        t.colorSpace = THREE.SRGBColorSpace;
        // No mipmaps. A face is 512px shown at roughly that size, so there is
        // nothing to gain, and the mip path is what collapsed a face to its
        // average colour when the view landed square on a cube corner.
        t.generateMipmaps = false;
        t.minFilter = THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        if (FACE_SPIN[slot]) { t.center.set(0.5, 0.5); t.rotation = FACE_SPIN[slot]; }
      });
      // A cube seen from the inside. Scaling X by -1 turns it inside out, which
      // keeps the faces the right way round rather than mirrored.
      const geo = new THREE.BoxGeometry(2, 2, 2);
      geo.scale(-1, 1, 1);
      scene.add(new THREE.Mesh(geo, textures.map(map => new THREE.MeshBasicMaterial({ map }))));

      let yaw = 0, pitch = 0, fov = 80;
      const resize = () => {
        const r = stage.getBoundingClientRect();
        if (!r.width || !r.height) return;
        renderer.setSize(r.width, r.height, false);
        camera.aspect = r.width / r.height;
        camera.updateProjectionMatrix();
        sizeFrame();
      };

      const draw = () => {
        camera.fov = fov;
        camera.updateProjectionMatrix();
        camera.rotation.set(0, 0, 0);
        camera.rotateY(yaw);
        camera.rotateX(pitch);
        renderer.render(scene, camera);
      };
      const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = null; draw(); }); };

      // Drag to look, as though the view itself were being pulled: drag right
      // and the scene follows the cursor to the right, which means the camera
      // turns left. Both axes used to be the other way round, so a drag pushed
      // the world away from the pointer.
      //
      // The rate is the real radians-per-pixel at the centre of the view,
      // 2*tan(fov/2)/height, not fov/height. Those differ by about 17% at the
      // default 80 degrees, which is why a grabbed point used to drift behind
      // the cursor. It is the SAME figure for both axes: the aspect ratio only
      // widens the frustum, it does not change the scale of the image plane,
      // so a horizontal pixel and a vertical pixel are worth the same angle.
      //
      // Pitch is clamped short of straight up and down, where there is nothing
      // to see and the view rolls over.
      const PITCH_STOP = Math.PI / 2 - 0.05;
      const radPerPx = (height) => 2 * Math.tan((fov * Math.PI / 180) / 2) / Math.max(1, height);
      let dragging = false, lx = 0, ly = 0;
      stage.addEventListener('pointerdown', (e) => {
        dragging = true; lx = e.clientX; ly = e.clientY;
        stage.style.cursor = 'grabbing';
        stage.setPointerCapture(e.pointerId);
      });
      stage.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const r = stage.getBoundingClientRect();
        const perPx = radPerPx(r.height);
        yaw += (e.clientX - lx) * perPx;
        pitch = Math.max(-PITCH_STOP, Math.min(PITCH_STOP, pitch + (e.clientY - ly) * perPx));
        lx = e.clientX; ly = e.clientY;
        schedule();
      });
      const stop = (e) => {
        if (!dragging) return;
        dragging = false;
        stage.style.cursor = 'grab';
        try { stage.releasePointerCapture(e.pointerId); } catch { }
      };
      stage.addEventListener('pointerup', stop);
      stage.addEventListener('pointercancel', stop);
      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        fov = Math.max(30, Math.min(100, fov + Math.sign(e.deltaY) * 4));
        schedule();
      }, { passive: false });
      window.addEventListener('resize', resize);

      resize();
      draw();

      ov.querySelector('#ipPanUse').onclick = () => {
        // Crop the square that was framed on screen, out of the frame that is
        // on screen — render first so the buffer is guaranteed current.
        draw();
        const r = stage.getBoundingClientRect();
        const dpr = renderer.getPixelRatio();
        const side = Math.round(Math.min(r.width, r.height) * dpr);
        const sx = Math.round((r.width * dpr - side) / 2);
        const sy = Math.round((r.height * dpr - side) / 2);
        const out = document.createElement('canvas');
        out.width = out.height = side;
        out.getContext('2d').drawImage(cv, sx, sy, side, side, 0, 0, side, side);
        let url = null;
        try { url = out.toDataURL('image/png'); } catch { }
        close();
        if (url) onCrop(url);
      };
    }).catch((e) => fail('Could not load the 3D view: ' + (e && e.message)));
  }

  // Crop + optional circle mask. Everything reaching this is already a data:
  // URL, so the canvas is never tainted and toDataURL always works.
  function openCropper(src, onDone) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay active';
    ov.style.zIndex = 6200;
    ov.innerHTML = `<div class="modal-content" style="max-width:460px;">
      <div class="modal-header"><h2>Adjust icon</h2><button class="modal-close" id="ipCropX">✕</button></div>
      <div id="ipCropStage" style="position:relative; width:100%; aspect-ratio:1/1; background:var(--menu-bg);
        border:1px solid var(--border-dark); border-radius:var(--border-radius); overflow:hidden; touch-action:none; cursor:grab;">
        <canvas id="ipCropCv" style="width:100%; height:100%; display:block; pointer-events:none;"></canvas>
      </div>
      <p id="ipCropHint" style="margin:8px 0 0; font-size:11px; opacity:0.7; text-align:center;">
        Drag to choose what's in frame · scroll to zoom
      </p>
      <div class="ip-section-title" style="margin-top:8px;">Zoom</div>
      <input type="range" id="ipCropZoom" min="100" max="400" value="100" style="width:100%;">
      <div class="ip-section-title" style="margin-top:8px;">Corners</div>
      <div class="ip-circle-row">
        <input type="range" id="ipCropRound" min="0" max="50" value="0" style="flex:1;">
        <span id="ipCropRoundLabel" style="font-size:11px;opacity:0.75;min-width:52px;text-align:right;"></span>
      </div>
      <div class="modal-actions"><button id="ipCropOk">Use this</button><button id="ipCropCancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);

    const cv = ov.querySelector('#ipCropCv');
    const stage = ov.querySelector('#ipCropStage');
    const zoomEl = ov.querySelector('#ipCropZoom');
    // How rounded, as a percentage of half the icon's width: 0 is a square,
    // 50 is a circle, and everything between is a rounded square. It used to be
    // a checkbox, which only offered those two ends.
    const roundEl = ov.querySelector('#ipCropRound');
    const roundLabel = ov.querySelector('#ipCropRoundLabel');
    const OUT = 256;
    cv.width = OUT; cv.height = OUT;
    const cx = cv.getContext('2d');
    const im = new Image();
    // 1 is "cover": the square is filled, and for anything that is not already
    // square part of the image is outside it. Below 1 the image shrinks toward
    // "contain", where all of it is in frame with transparent bars either side
    // — which is the only way to get a wide banner in whole. minZoom is exactly
    // the contain-to-cover ratio, so a 16:9 screenshot zooms out to 56% and a
    // square image cannot zoom out at all, because it has nothing outside the
    // frame to go and find.
    let zoom = 1, minZoom = 1, ox = 0, oy = 0, drag = null;
    const fitZoom = () => {
      const w = im.naturalWidth, h = im.naturalHeight;
      if (!w || !h) return 1;
      return Math.min(1, Math.min(w, h) / Math.max(w, h));
    };

    const draw = () => {
      cx.clearRect(0, 0, OUT, OUT);
      cx.save();
      const roundPct = Number(roundEl.value) || 0;
      if (roundPct > 0) {
        const r = (OUT / 2) * (roundPct / 50);
        cx.beginPath();
        if (cx.roundRect) cx.roundRect(0, 0, OUT, OUT, r);
        else {
          // Older canvas: trace it by hand.
          cx.moveTo(r, 0);
          cx.arcTo(OUT, 0, OUT, OUT, r);
          cx.arcTo(OUT, OUT, 0, OUT, r);
          cx.arcTo(0, OUT, 0, 0, r);
          cx.arcTo(0, 0, OUT, 0, r);
          cx.closePath();
        }
        cx.clip();
      }
      // Cover the square, then apply zoom and the dragged offset.
      const base = Math.max(OUT / im.naturalWidth, OUT / im.naturalHeight);
      const s = base * zoom;
      const w = im.naturalWidth * s, h = im.naturalHeight * s;
      // Don't let the image be dragged off the square entirely.
      const maxX = Math.max(0, (w - OUT) / 2), maxY = Math.max(0, (h - OUT) / 2);
      ox = Math.max(-maxX, Math.min(maxX, ox));
      oy = Math.max(-maxY, Math.min(maxY, oy));
      cx.drawImage(im, (OUT - w) / 2 + ox, (OUT - h) / 2 + oy, w, h);
      cx.restore();
      if (roundLabel) {
        roundLabel.textContent = roundPct === 0 ? 'Square'
          : roundPct === 50 ? 'Circle'
            : `${Math.round(roundPct * 2)}%`;
      }
      // A square image at 100% fills the box exactly, so there is nowhere to
      // drag it — say so instead of inviting a drag that does nothing.
      const hint = ov.querySelector('#ipCropHint');
      if (hint) {
        hint.textContent = (maxX > 0.5 || maxY > 0.5)
          ? "Drag to choose what's in frame · scroll to zoom"
          : minZoom < 1
            ? 'Scroll to zoom in, or out to fit the whole image'
            : 'Zoom in to choose what\'s in frame';
      }
    };

    im.onload = () => {
      // An image with no transparency of its own has nothing to lose from
      // rounding, and usually wants it; one that is already a cut-out shape
      // would just have its corners eaten.
      roundEl.value = isFullyOpaque(im) ? '50' : '0';
      minZoom = fitZoom();
      zoomEl.min = String(Math.floor(minZoom * 100));
      draw();
    };
    im.onerror = () => { ov.remove(); onDone(null); };
    im.src = src;

    zoomEl.oninput = () => { zoom = Math.max(minZoom, zoomEl.value / 100); draw(); };
    roundEl.oninput = draw;

    // Zooming with the wheel, which is what anyone tries first on a crop box.
    // Keeps the slider in step so the two never disagree.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const next = Math.max(minZoom, Math.min(4, zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      zoom = next;
      zoomEl.value = String(Math.round(zoom * 100));
      draw();
    }, { passive: false });

    stage.addEventListener('pointerdown', e => {
      // The canvas is pointer-events:none, so every press lands on the stage —
      // a press that started on the canvas used to depend on bubbling, and a
      // native image-drag could take it away first.
      e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, ox, oy };
      try { stage.setPointerCapture(e.pointerId); } catch { /* not captured; move still works */ }
      stage.style.cursor = 'grabbing';
    });
    stage.addEventListener('pointermove', e => {
      if (!drag) return;
      // Stage pixels -> canvas pixels.
      const k = OUT / stage.getBoundingClientRect().width;
      ox = drag.ox + (e.clientX - drag.x) * k;
      oy = drag.oy + (e.clientY - drag.y) * k;
      draw();
    });
    const endDrag = () => { drag = null; stage.style.cursor = 'grab'; };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    const close = (v) => { ov.remove(); onDone(v); };
    ov.querySelector('#ipCropX').onclick = () => close(null);
    ov.querySelector('#ipCropCancel').onclick = () => close(null);
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(null); });
    ov.querySelector('#ipCropOk').onclick = () => {
      try { close(cv.toDataURL('image/png')); } catch { close(null); }
    };
  }
  function ensureStyle() {
    if (document.getElementById('iconpicker-style')) return;
    const s = document.createElement('style'); s.id = 'iconpicker-style';
    s.textContent = `
      .ip-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:8px; max-height:280px; overflow-y:auto; padding:4px; }
      /* Screenshots get cropped square on pick, so preview them cropped too. */
      .ip-cell.ip-shot img { padding:0; object-fit:cover; }
      /* A banner or panorama is wide; give it two columns so it reads as one. */
      .ip-cell.ip-wide { width:auto; grid-column:span 2; }
      .ip-circle-row { display:flex; align-items:center; gap:10px; margin:4px 0 0; font-size:12px; }
      .ip-circle-row input[type=range] { margin:0; }
      .ip-cell { width:56px; height:56px; border:2px solid var(--border-dark); border-radius:var(--border-radius); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--menu-bg); overflow:hidden; }
      .ip-cell:hover { border-color:var(--accent); }
      .ip-cell img { width:100%; height:100%; object-fit:contain; padding:4px; image-rendering:auto; }
      .ip-section-title { font-size:12px; text-transform:uppercase; opacity:0.7; margin:12px 0 4px; }`;
    document.head.appendChild(s);
  }

  window.IconPicker = {
    // opts: { instanceId?, serverName?, version?, onPick }
    open(opts) {
      ensureStyle();
      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 6000;
      ov.innerHTML = `<div class="modal-content" style="max-width:460px;">
        <div class="modal-header"><h2>Choose an icon</h2><button class="modal-close" id="ipClose">✕</button></div>
        <div class="ip-section-title">Presets</div>
        <div class="ip-grid" id="ipPresets"></div>
        <div id="ipVersionWrap" style="display:none;"><div class="ip-section-title">This version</div><div class="ip-grid" id="ipVersion"></div></div>
        <div class="ip-section-title">Editions</div>
        <div class="ip-grid" id="ipEditions"></div>
        <div id="ipShotsWrap" style="display:none;"><div class="ip-section-title">Screenshots</div><div class="ip-grid" id="ipShots"></div></div>
        <div id="ipWorldsWrap" style="display:none;"><div class="ip-section-title">Worlds</div><div class="ip-grid" id="ipWorlds"></div></div>
        <div id="ipServersWrap" style="display:none;"><div class="ip-section-title">Servers</div><div class="ip-grid" id="ipServers"></div></div>
        <div id="ipModsWrap" style="display:none;"><div class="ip-section-title">Mods</div><div class="ip-grid" id="ipMods"></div></div>
        <div id="ipPacksWrap" style="display:none;"><div class="ip-section-title">Resource packs</div><div class="ip-grid" id="ipPacks"></div></div>
        <div class="modal-actions"><button id="ipCustom">Custom image…</button><button id="ipCancel">Cancel</button></div>
        <input type="file" id="ipFile" accept="image/*" style="display:none;" />
      </div>`;
      document.body.appendChild(ov);
      const close = () => { hidePeek(); ov.remove(); };
      wirePeek(ov);
      const pick = (dataUrl) => { close(); opts.onPick && opts.onPick(dataUrl); };
      // EVERYTHING goes through the cropper. It used to be only the wide
      // sources (banner, panorama, screenshots) — so a mod icon, a world icon
      // or a custom image was taken exactly as it came, which for anything that
      // wasn't already square meant it got stretched into the icon slot, with
      // no way to zoom or choose the framing. The cropper opens on the whole
      // image fitted, so "Use this" is one click and gives a proper square.
      const editThenPick = (src) => openCropper(src, (out) => { if (out) pick(out); });
      // Read a remote/preset URL as data first: the cropper draws onto a canvas
      // and reads it back, which a cross-origin or file:// image would taint.
      const editUrlThenPick = async (url) => {
        try { editThenPick(await urlToDataUrl(url)); }
        catch { editThenPick(url); }
      };
      ov.querySelector('#ipClose').onclick = close;
      ov.querySelector('#ipCancel').onclick = close;
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

      // ── Editions: fixed, always available. ───────────────────────────────
      const editions = ov.querySelector('#ipEditions');
      EDITION_ICONS.forEach(({ label, url }) => {
        const cell = document.createElement('div');
        cell.className = 'ip-cell';
        cell.title = label;
        const img = document.createElement('img');
        img.src = url; img.loading = 'lazy';
        img.onerror = () => cell.remove();
        cell.appendChild(img);
        cell.onclick = () => editUrlThenPick(url);
        editions.appendChild(cell);
      });

      // ── This version: the wiki's banner, and the in-game panorama. ────────
      const versionWrap = ov.querySelector('#ipVersionWrap');
      const versionGrid = ov.querySelector('#ipVersion');
      const addVersionCell = (title, src, onClick, wide) => {
        versionWrap.style.display = '';
        const cell = document.createElement('div');
        cell.className = 'ip-cell' + (wide ? ' ip-wide' : '');
        cell.title = title;
        const img = document.createElement('img');
        img.src = src;
        img.style.cssText = 'padding:0;object-fit:cover;';
        cell.appendChild(img);
        cell.onclick = onClick;
        versionGrid.appendChild(cell);
        return cell;
      };

      // A resource pack or a mod in this instance may replace the title
      // screen's panorama, and that is one of the first things anyone would
      // want their instance's icon taken from. Offered alongside the vanilla
      // one, labelled with the pack it came from, enabled packs first.
      if (opts.instanceId) {
        ipcRenderer.invoke('icon:packPanoramas', { profileId: opts.instanceId }).then(r => {
          for (const p of (r && r.panoramas) || []) {
            if (!p || !p.forward) continue;
            const label = `${p.name} panorama` + (p.enabled ? ' (on)' : p.kind === 'mod' ? ' (mod)' : '');
            const cell = addVersionCell(label, p.forward, () => openPanorama(p, editThenPick), true);
            const img = cell && cell.querySelector('img');
            if (img) img.onerror = () => cell.remove();
            // The heading says "This version", which stops being the whole
            // truth as soon as a pack's own panorama is in there.
            const title = versionWrap.querySelector('.ip-section-title');
            if (title) title.textContent = 'This version & its packs';
          }
        }).catch((e) => console.info('[icon picker] pack panorama lookup failed:', e && e.message));
      }

      if (opts.version) {
        const addCell = addVersionCell;
        ipcRenderer.invoke('icon:versionBanner', { version: opts.version }).then(b => {
          // Plenty of versions have no banner at all; that's simply nothing to show.
          if (b && b.dataUrl) {
            const cell = addCell(`${opts.version} banner`, b.dataUrl, () => editThenPick(b.dataUrl), true);
            const img = cell && cell.querySelector('img');
            if (img) img.onerror = () => cell.remove();
          }
        }).catch(() => { });
        ipcRenderer.invoke('icon:versionPanorama', { version: opts.version }).then(p => {
          // No cell at all unless there is an image to put in it. Adding one
          // regardless is what left a grey box with nothing in it, and the
          // reason was only ever in the main process log.
          if (!p || !p.forward) {
            if (p && p.error) console.info('[icon picker] no panorama:', p.error);
            return;
          }
          const cell = addCell(`${opts.version} panorama`, p.forward, () => openPanorama(p, editThenPick), true);
          // Belt and braces: if the data URL somehow won't decode, drop the
          // cell rather than leaving it empty.
          const img = cell && cell.querySelector('img');
          if (img) img.onerror = () => cell.remove();
        }).catch((e) => console.info('[icon picker] panorama lookup failed:', e && e.message));
      }

      const presets = ov.querySelector('#ipPresets');
      PRESET_ICONS.forEach(file => {
        const src = presetSrc(file);
        const cell = document.createElement('div'); cell.className = 'ip-cell';
        cell.title = file.replace(/_JE.*$|_BE.*$|\.png$/g, '').replace(/_/g, ' ');
        cell.innerHTML = `<img src="${src}" />`;
        cell.onclick = () => editUrlThenPick(src);
        presets.appendChild(cell);
      });

      const fileInput = ov.querySelector('#ipFile');
      ov.querySelector('#ipCustom').onclick = () => fileInput.click();
      fileInput.onchange = async () => {
        if (!fileInput.files[0]) return;
        // Straight to the cropper: a photo or a screenshot is almost never
        // square, and picking one used to squash it into the icon slot.
        editThenPick(await fileToDataUrl(fileInput.files[0]));
      };

      // World + server icons from the instance (if any).
      if (opts.instanceId) {
        const toUrl = (icon) => icon.startsWith('data:') ? icon : ('data:image/png;base64,' + icon);
        // The instance's own screenshots, newest first — the handler already
        // sorts them that way.
        ipcRenderer.invoke('get-instance-screenshots', { profileId: opts.instanceId }).then(shots => {
          const list = (shots || []).slice(0, 60);
          if (!list.length) return;
          ov.querySelector('#ipShotsWrap').style.display = '';
          const sc = ov.querySelector('#ipShots');
          list.forEach(s => {
            const cell = document.createElement('div');
            cell.className = 'ip-cell ip-shot'; cell.title = s.name || '';
            const img = document.createElement('img'); img.loading = 'lazy';
            // A thumbnail, NOT the original: these are routinely 4K PNGs of
            // several megabytes each, and putting sixty of them into 56px cells
            // is what made opening this modal crawl.
            ipcRenderer.invoke('icon:thumb', { filePath: s.path, size: 96 })
              .then(d => { if (d) img.src = d; else cell.remove(); })
              .catch(() => cell.remove());
            img.onerror = () => cell.remove();
            cell.appendChild(img);
            cell.onclick = async () => {
              // Read the FULL image through the main process for the cropper: a
              // canvas that has drawn a file:// image is tainted and would throw
              // on toDataURL, but a data: URL doesn't taint anything.
              try {
                const d = await ipcRenderer.invoke('icon:dataUrl', { filePath: s.path });
                if (!d) return;
                editThenPick(d);
              } catch { /* unreadable or too large */ }
            };
            sc.appendChild(cell);
          });
        }).catch(() => {});
        ipcRenderer.invoke('get-instance-worlds', { profileId: opts.instanceId }).then(worlds => {
          const withIcons = (worlds || []).filter(w => w.icon);
          if (!withIcons.length) return;
          ov.querySelector('#ipWorldsWrap').style.display = '';
          const wc = ov.querySelector('#ipWorlds');
          withIcons.forEach(w => {
            const url = toUrl(w.icon);
            const cell = document.createElement('div'); cell.className = 'ip-cell'; cell.title = w.name || '';
            cell.innerHTML = `<img src="${url}" />`;
            cell.onclick = () => editThenPick(url);
            wc.appendChild(cell);
          });
        }).catch(() => {});
        ipcRenderer.invoke('get-instance-servers', { profileId: opts.instanceId }).then(servers => {
          const list = servers || [];
          const sc = ov.querySelector('#ipServers');
          const addServerCell = (s, url) => {
            ov.querySelector('#ipServersWrap').style.display = '';
            const cell = document.createElement('div'); cell.className = 'ip-cell';
            cell.title = (s.name || s.ip || '') + (s.ip ? ` (${s.ip})` : '');
            const img = document.createElement('img');
            img.src = url;
            img.onerror = () => cell.remove();
            cell.appendChild(img);
            cell.onclick = () => editThenPick(url);
            sc.appendChild(cell);
          };
          list.filter(s => s.icon).forEach(s => addServerCell(s, toUrl(s.icon)));
          // A server added and pinged in the launcher has its favicon stored
          // now, but one added before that change — or added and never looked
          // at — has nothing in servers.dat. Ask those servers directly, so the
          // picker is not quietly missing an icon the launcher could see.
          // Capped, because each one is a socket to somewhere on the internet.
          const PING_LIMIT = 12;
          list.filter(s => !s.icon && s.ip).slice(0, PING_LIMIT).forEach(s => {
            ipcRenderer.invoke('get-server-status', { ip: s.ip }).then(st => {
              if (!st || !st.online || !st.icon || !ov.isConnected) return;
              addServerCell(s, st.icon);
              // And remember it, so next time it comes straight out of
              // servers.dat and no ping is needed at all.
              ipcRenderer.invoke('remember-server-icon', {
                profileId: opts.instanceId, ip: s.ip, icon: st.icon,
              }).catch(() => { });
            }).catch(() => { });
          });
        }).catch(() => {});
        // Anything installed in the instance has an icon of its own — a mod's,
        // a resource pack's — so offer those too, not just worlds and servers.
        addContentSection('mods', '#ipModsWrap', '#ipMods');
        addContentSection('resourcepacks', '#ipPacksWrap', '#ipPacks');
      }

      // Servers browse their own mods through a different handler (their content
      // isn't indexed against Modrinth), but the cells work the same way.
      if (opts.serverName) {
        ipcRenderer.invoke('server-mods:info', { name: opts.serverName, dir: 'mods' }).then(info => {
          const items = Object.entries(info || {})
            .filter(([, m]) => m && m.icon)
            .map(([file, m]) => ({ icon: m.icon, iconPath: m.iconPath, name: m.name || file }));
          renderContentCells(items, '#ipModsWrap', '#ipMods');
        }).catch(() => {});
      }

      function addContentSection(tab, wrapSel, gridSel) {
        ipcRenderer.invoke('get-instance-mods', { profileId: opts.instanceId, tab })
          .then(list => renderContentCells((list || []).filter(x => x.icon), wrapSel, gridSel))
          .catch(() => {});
      }

      function renderContentCells(items, wrapSel, gridSel) {
        if (!items.length) return;
        ov.querySelector(wrapSel).style.display = '';
        const g = ov.querySelector(gridSel);
        items.forEach(it => {
          const cell = document.createElement('div'); cell.className = 'ip-cell'; cell.title = it.name || '';
          const img = document.createElement('img');
          // `icon` prefers the Modrinth/CurseForge artwork, which for
          // CurseForge is the project LOGO — frequently a wide banner rather
          // than a square. `iconPath` is the icon out of the jar itself. The
          // click used to take iconPath while the cell previewed icon, so the
          // picker showed one image and handed over another. Preview whichever
          // one is actually going to be used.
          img.src = it.iconPath ? toFileUrl(it.iconPath) : it.icon;
          // A cached icon that has since been cleaned up would leave a blank cell.
          img.onerror = () => { if (it.icon && img.src !== it.icon) img.src = it.icon; else cell.remove(); };
          cell.appendChild(img);
          cell.onclick = async () => {
            // The chosen icon gets embedded (in serverinfo.json, in a shortcut),
            // so it has to travel as data — a file:// path wouldn't survive.
            // Through the cropper, because a mod's logo is often a wide banner
            // rather than a square, and taking it as-is stretched it.
            try {
              if (it.iconPath) {
                const d = await ipcRenderer.invoke('icon:dataUrl', { filePath: it.iconPath });
                if (d) return editThenPick(d);
              }
              editThenPick(await urlToDataUrl(it.icon));
            } catch { editThenPick(it.icon); }
          };
          g.appendChild(cell);
        });
      }
    },
  };
})();
