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

  // The six faces stitched back into the strip they came from, so an icon can
  // be cropped out of any part of the scene rather than only the forward view.
  // Panorama faces are a cube: 0 front, 1 right, 2 back, 3 left (4/5 are up and
  // down, which don't belong in a horizontal strip).
  function openPanorama(p, onCrop) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay active';
    ov.style.zIndex = 6100;
    ov.innerHTML = `<div class="modal-content" style="max-width:900px; width:94%;">
      <div class="modal-header"><h2>Pick a spot</h2><button class="modal-close" id="ipPanX">✕</button></div>
      <p style="margin:0 0 8px; font-size:12px; opacity:0.75;">Scroll sideways to look around, then click to crop an icon from there.</p>
      <div id="ipPanScroll" style="overflow-x:auto; overflow-y:hidden; border:1px solid var(--border-dark); border-radius:var(--border-radius);">
        <canvas id="ipPanCv" style="display:block; height:220px; cursor:crosshair;"></canvas>
      </div>
      <div class="modal-actions"><button id="ipPanCancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);
    const cv = ov.querySelector('#ipPanCv');
    const cx = cv.getContext('2d');
    const order = [0, 1, 2, 3];
    Promise.all(order.map(i => new Promise(res => {
      const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = p.faces[i];
    }))).then(imgs => {
      const good = imgs.filter(Boolean);
      if (!good.length) { ov.remove(); return; }
      const fh = good[0].naturalHeight, fw = good[0].naturalWidth;
      cv.width = fw * good.length; cv.height = fh;
      cv.style.width = (cv.width * (220 / fh)) + 'px';
      good.forEach((im, i) => cx.drawImage(im, i * fw, 0, fw, fh));
      cv.onclick = (e) => {
        // Cut a square the height of the strip, centred where they clicked.
        const r = cv.getBoundingClientRect();
        const x = (e.clientX - r.left) * (cv.width / r.width);
        const side = cv.height;
        const sx = Math.max(0, Math.min(cv.width - side, x - side / 2));
        const out = document.createElement('canvas');
        out.width = side; out.height = side;
        out.getContext('2d').drawImage(cv, sx, 0, side, side, 0, 0, side, side);
        let url = null;
        try { url = out.toDataURL('image/png'); } catch { }
        ov.remove();
        if (url) onCrop(url);
      };
    });
    const close = () => ov.remove();
    ov.querySelector('#ipPanX').onclick = close;
    ov.querySelector('#ipPanCancel').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
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
        <canvas id="ipCropCv" style="width:100%; height:100%; display:block;"></canvas>
      </div>
      <div class="ip-section-title" style="margin-top:10px;">Zoom</div>
      <input type="range" id="ipCropZoom" min="100" max="400" value="100" style="width:100%;">
      <label class="ip-circle-row"><input type="checkbox" id="ipCropCircle"> Round off the corners</label>
      <div class="modal-actions"><button id="ipCropOk">Use this</button><button id="ipCropCancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);

    const cv = ov.querySelector('#ipCropCv');
    const stage = ov.querySelector('#ipCropStage');
    const zoomEl = ov.querySelector('#ipCropZoom');
    const circleEl = ov.querySelector('#ipCropCircle');
    const OUT = 256;
    cv.width = OUT; cv.height = OUT;
    const cx = cv.getContext('2d');
    const im = new Image();
    let zoom = 1, ox = 0, oy = 0, drag = null;

    const draw = () => {
      cx.clearRect(0, 0, OUT, OUT);
      cx.save();
      if (circleEl.checked) {
        cx.beginPath();
        cx.arc(OUT / 2, OUT / 2, OUT / 2, 0, Math.PI * 2);
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
    };

    im.onload = () => {
      circleEl.checked = isFullyOpaque(im);   // opaque squares default to round
      draw();
    };
    im.onerror = () => { ov.remove(); onDone(null); };
    im.src = src;

    zoomEl.oninput = () => { zoom = zoomEl.value / 100; draw(); };
    circleEl.onchange = draw;
    stage.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, ox, oy };
      stage.setPointerCapture(e.pointerId);
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
      .ip-circle-row { display:flex; align-items:center; gap:8px; margin:10px 0 0; font-size:12px; }
      .ip-circle-row input { width:18px; height:18px; margin:0; }
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
      const close = () => ov.remove();
      const pick = (dataUrl) => { close(); opts.onPick && opts.onPick(dataUrl); };
      // Anything that isn't already a small square goes through the cropper, so
      // a wide banner or a panorama becomes a deliberate icon rather than a
      // centre-crop nobody chose.
      const editThenPick = (src) => openCropper(src, (out) => { if (out) pick(out); });
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
        cell.onclick = async () => { try { pick(await urlToDataUrl(url)); } catch { pick(url); } };
        editions.appendChild(cell);
      });

      // ── This version: the wiki's banner, and the in-game panorama. ────────
      if (opts.version) {
        const wrap = ov.querySelector('#ipVersionWrap');
        const grid = ov.querySelector('#ipVersion');
        const addCell = (title, src, onClick, wide) => {
          wrap.style.display = '';
          const cell = document.createElement('div');
          cell.className = 'ip-cell' + (wide ? ' ip-wide' : '');
          cell.title = title;
          const img = document.createElement('img');
          img.src = src;
          img.style.cssText = 'padding:0;object-fit:cover;';
          cell.appendChild(img);
          cell.onclick = onClick;
          grid.appendChild(cell);
        };
        ipcRenderer.invoke('icon:versionBanner', { version: opts.version }).then(b => {
          // Plenty of versions have no banner at all; that's simply nothing to show.
          if (b && b.dataUrl) addCell(`${opts.version} banner`, b.dataUrl, () => editThenPick(b.dataUrl), true);
        }).catch(() => { });
        ipcRenderer.invoke('icon:versionPanorama', { version: opts.version }).then(p => {
          if (!p || !p.forward) return;
          addCell(`${opts.version} panorama`, p.forward, () => openPanorama(p, editThenPick), true);
        }).catch(() => { });
      }

      const presets = ov.querySelector('#ipPresets');
      PRESET_ICONS.forEach(file => {
        const src = presetSrc(file);
        const cell = document.createElement('div'); cell.className = 'ip-cell';
        cell.title = file.replace(/_JE.*$|_BE.*$|\.png$/g, '').replace(/_/g, ' ');
        cell.innerHTML = `<img src="${src}" />`;
        cell.onclick = async () => { try { pick(await urlToDataUrl(src)); } catch { pick(src); } };
        presets.appendChild(cell);
      });

      const fileInput = ov.querySelector('#ipFile');
      ov.querySelector('#ipCustom').onclick = () => fileInput.click();
      fileInput.onchange = async () => { if (fileInput.files[0]) pick(await fileToDataUrl(fileInput.files[0])); };

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
            cell.onclick = () => pick(url);
            wc.appendChild(cell);
          });
        }).catch(() => {});
        ipcRenderer.invoke('get-instance-servers', { profileId: opts.instanceId }).then(servers => {
          const withIcons = (servers || []).filter(s => s.icon);
          if (!withIcons.length) return;
          ov.querySelector('#ipServersWrap').style.display = '';
          const sc = ov.querySelector('#ipServers');
          withIcons.forEach(s => {
            const url = toUrl(s.icon);
            const cell = document.createElement('div'); cell.className = 'ip-cell'; cell.title = (s.name || s.ip || '') + (s.ip ? ` (${s.ip})` : '');
            cell.innerHTML = `<img src="${url}" />`;
            cell.onclick = () => pick(url);
            sc.appendChild(cell);
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
          const img = document.createElement('img'); img.src = it.icon;
          // A cached icon that has since been cleaned up would leave a blank cell.
          img.onerror = () => cell.remove();
          cell.appendChild(img);
          cell.onclick = async () => {
            // The chosen icon gets embedded (in serverinfo.json, in a shortcut),
            // so it has to travel as data — a file:// path wouldn't survive.
            try {
              if (it.iconPath) {
                const d = await ipcRenderer.invoke('icon:dataUrl', { filePath: it.iconPath });
                if (d) return pick(d);
              }
              pick(await urlToDataUrl(it.icon));
            } catch { pick(it.icon); }
          };
          g.appendChild(cell);
        });
      }
    },
  };
})();
