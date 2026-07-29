// Shared icon picker modal. Lets the user choose a predefined icon, a custom
// image file, or (for an instance/server) one of its world icons. Resolves the
// chosen icon as a data:image/png URL via onPick.
(function () {
  const { ipcRenderer } = require('electron');

  // Predefined icons rendered from emoji onto a canvas → self-contained PNGs,
  // no asset files needed.
  const PRESET_EMOJI = ['🟩', '🧱', '💎', '⚔️', '🏰', '🌲', '🔥', '⚙️', '🚀', '🐉', '🍎', '⭐', '🌍', '🎮', '🛠️', '👾'];
  function emojiToDataUrl(emoji, size = 128) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.fillRect(0, 0, size, size);
    ctx.font = `${Math.floor(size * 0.72)}px sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(emoji, size / 2, size / 2 + size * 0.06);
    return c.toDataURL('image/png');
  }
  function fileToDataUrl(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
  }
  function ensureStyle() {
    if (document.getElementById('iconpicker-style')) return;
    const s = document.createElement('style'); s.id = 'iconpicker-style';
    s.textContent = `
      .ip-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(56px,1fr)); gap:8px; max-height:280px; overflow-y:auto; padding:4px; }
      .ip-cell { width:56px; height:56px; border:2px solid var(--border-dark); border-radius:var(--border-radius); cursor:pointer; display:flex; align-items:center; justify-content:center; background:var(--menu-bg); overflow:hidden; }
      .ip-cell:hover { border-color:var(--accent); }
      .ip-cell img { width:100%; height:100%; object-fit:cover; }
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
      PRESET_EMOJI.forEach(em => {
        const url = emojiToDataUrl(em);
        const cell = document.createElement('div'); cell.className = 'ip-cell';
        cell.innerHTML = `<img src="${url}" />`;
        cell.onclick = () => pick(url);
        presets.appendChild(cell);
      });

      const fileInput = ov.querySelector('#ipFile');
      ov.querySelector('#ipCustom').onclick = () => fileInput.click();
      fileInput.onchange = async () => { if (fileInput.files[0]) pick(await fileToDataUrl(fileInput.files[0])); };

      // World icons from the instance (if any).
      if (opts.instanceId) {
        ipcRenderer.invoke('get-instance-worlds', { profileId: opts.instanceId }).then(worlds => {
          const withIcons = (worlds || []).filter(w => w.icon);
          if (!withIcons.length) return;
          ov.querySelector('#ipWorldsWrap').style.display = '';
          const wc = ov.querySelector('#ipWorlds');
          withIcons.forEach(w => {
            const url = w.icon.startsWith('data:') ? w.icon : ('data:image/png;base64,' + w.icon);
            const cell = document.createElement('div'); cell.className = 'ip-cell'; cell.title = w.name || '';
            cell.innerHTML = `<img src="${url}" />`;
            cell.onclick = () => pick(url);
            wc.appendChild(cell);
          });
        }).catch(() => {});
      }
    },
  };
})();
