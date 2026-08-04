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
  function ensureStyle() {
    if (document.getElementById('iconpicker-style')) return;
    const s = document.createElement('style'); s.id = 'iconpicker-style';
    s.textContent = `
      .ip-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:8px; max-height:280px; overflow-y:auto; padding:4px; }
      .ip-cell { width:56px; height:56px; border:2px solid var(--border-dark); border-radius:var(--border-radius); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--menu-bg); overflow:hidden; }
      .ip-cell:hover { border-color:var(--accent); }
      .ip-cell img { width:100%; height:100%; object-fit:contain; padding:4px; image-rendering:auto; }
      .ip-section-title { font-size:12px; text-transform:uppercase; opacity:0.7; margin:12px 0 4px; }`;
    document.head.appendChild(s);
  }

  window.IconPicker = {
    // opts: { instanceId?, serverName?, onPick }
    open(opts) {
      ensureStyle();
      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 6000;
      ov.innerHTML = `<div class="modal-content" style="max-width:460px;">
        <div class="modal-header"><h2>Choose an icon</h2><button class="modal-close" id="ipClose">✕</button></div>
        <div class="ip-section-title">Presets</div>
        <div class="ip-grid" id="ipPresets"></div>
        <div id="ipWorldsWrap" style="display:none;"><div class="ip-section-title">Worlds</div><div class="ip-grid" id="ipWorlds"></div></div>
        <div id="ipServersWrap" style="display:none;"><div class="ip-section-title">Servers</div><div class="ip-grid" id="ipServers"></div></div>
        <div class="modal-actions"><button id="ipCustom">Custom image…</button><button id="ipCancel">Cancel</button></div>
        <input type="file" id="ipFile" accept="image/*" style="display:none;" />
      </div>`;
      document.body.appendChild(ov);
      const close = () => ov.remove();
      const pick = (dataUrl) => { close(); opts.onPick && opts.onPick(dataUrl); };
      ov.querySelector('#ipClose').onclick = close;
      ov.querySelector('#ipCancel').onclick = close;
      ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });

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
      }
    },
  };
})();
