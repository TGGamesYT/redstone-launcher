// "Update all", with a look at what you are agreeing to first.
//
// The button used to start downloading the moment it was clicked, so the only
// way to find out what had changed was to go through the mods one at a time
// afterwards. It now lists what would be replaced, with each one's version
// going from and to, and opens that version's changelog when the row is
// clicked. The changelog is fetched for the row opened and nothing else.
(function () {
  const { ipcRenderer, shell } = require('electron');

  function ensureStyle() {
    if (document.getElementById('ua-style')) return;
    const s = document.createElement('style');
    s.id = 'ua-style';
    s.textContent = `
      .modal-content.ua-modal { display:flex; flex-direction:column; overflow:hidden; max-height:82vh; }
      .ua-modal .ua-scroll { flex:1; min-height:0; overflow-y:auto; padding-right:4px; }
      .ua-modal .modal-actions { flex:0 0 auto; margin-top:12px; }
      .ua-row { border:1px solid var(--border-dark); border-radius:var(--border-radius); margin-bottom:6px; overflow:hidden; }
      .ua-head { display:flex; align-items:center; gap:10px; padding:8px 10px; cursor:pointer; }
      .ua-head:hover { background:var(--menu-hover-bg); }
      .ua-head img { width:30px; height:30px; flex:0 0 30px; border-radius:6px; object-fit:contain;
        background:var(--menu-bg); image-rendering:pixelated; }
      .ua-name { flex:1; min-width:0; font-size:13px; word-break:break-word; }
      .ua-vers { font-size:12px; opacity:0.8; white-space:nowrap; }
      .ua-vers .ua-to { color:var(--accent); }
      .ua-head .material-icons { font-size:18px; opacity:0.6; transition:transform 0.15s ease; }
      .ua-row.open .ua-head .material-icons { transform:rotate(180deg); }
      .ua-log { display:none; padding:2px 12px 10px; font-size:12px; line-height:1.5;
        border-top:1px solid var(--border-dark); background:var(--very-dark); }
      .ua-row.open .ua-log { display:block; }
      .ua-log h1, .ua-log h2, .ua-log h3 { font-size:13px; margin:10px 0 4px; }
      .ua-log ul, .ua-log ol { margin:4px 0 4px 18px; padding:0; }
      .ua-log p { margin:4px 0; }
      .ua-log img { max-width:100%; }
      .ua-log pre { overflow-x:auto; background:rgba(0,0,0,0.3); padding:6px; border-radius:4px; }`;
    document.head.appendChild(s);
  }

  // marked lives at the bottom of the pages that use it, so it may not have
  // run yet the first time this opens.
  function ensureMarked() {
    if (window.marked) return Promise.resolve(true);
    return new Promise((resolve) => {
      const existing = document.querySelector('script[data-ua-marked]');
      if (existing) { existing.addEventListener('load', () => resolve(!!window.marked)); return; }
      const s = document.createElement('script');
      s.src = 'marked.min.js';
      s.dataset.uaMarked = '1';
      s.onload = () => resolve(!!window.marked);
      s.onerror = () => resolve(false);
      document.body.appendChild(s);
    });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  window.UpdateAll = {
    /**
     * Ask before updating. `items` is [{ name, icon, version, latestVersion,
     * versionId }]; `what` names the kind of thing for the heading ("mods").
     * Resolves true to go ahead, false to leave it.
     */
    confirm(items, what) {
      ensureStyle();
      const list = (items || []).filter(Boolean);
      if (!list.length) return Promise.resolve(false);
      const noun = list.length === 1 ? (what || 'file').replace(/s$/, '') : (what || 'files');

      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 6600;
      ov.innerHTML = `
        <div class="modal-content ua-modal" style="max-width:640px; width:92%;">
          <div class="modal-header">
            <h2>Update ${list.length} ${esc(noun)}</h2>
            <button class="modal-close" id="uaX">✕</button>
          </div>
          <p style="margin:0 0 10px; opacity:0.8; font-size:12px;">
            Click one to read what changed.
          </p>
          <div class="ua-scroll"></div>
          <div class="modal-actions">
            <button id="uaGo">Update all</button>
            <button id="uaNo">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      const scroll = ov.querySelector('.ua-scroll');

      for (const it of list) {
        const row = document.createElement('div');
        row.className = 'ua-row';
        const from = it.version ? esc(it.version) : '';
        const to = it.latestVersion ? esc(it.latestVersion) : 'the newest build';
        row.innerHTML = `
          <div class="ua-head">
            <img alt="">
            <span class="ua-name">${esc(it.name)}</span>
            <span class="ua-vers">${from ? from + ' → ' : ''}<span class="ua-to">${to}</span></span>
            <i class="material-icons">expand_more</i>
          </div>
          <div class="ua-log"></div>`;
        const img = row.querySelector('img');
        if (it.icon) { img.src = it.icon; img.onerror = () => { img.style.visibility = 'hidden'; }; }
        else img.style.visibility = 'hidden';

        const log = row.querySelector('.ua-log');
        let loaded = false;
        row.querySelector('.ua-head').onclick = async () => {
          row.classList.toggle('open');
          if (!row.classList.contains('open') || loaded) return;
          loaded = true;
          if (!it.versionId) { log.textContent = 'No changelog — this update was not matched to a published version.'; return; }
          log.textContent = 'Loading the changelog…';
          const r = await ipcRenderer.invoke('modrinth:changelog', { versionId: it.versionId });
          if (!r || r.error) { log.textContent = (r && r.error) || 'The changelog could not be fetched.'; loaded = false; return; }
          if (!String(r.changelog || '').trim()) { log.textContent = 'This version was published without a changelog.'; return; }
          const ok = await ensureMarked();
          if (ok) {
            log.innerHTML = window.marked.parse(r.changelog);
            // A changelog is full of links to issues and pull requests; they
            // belong in a real browser, not in a launcher window.
            log.querySelectorAll('a').forEach(a => {
              const href = a.getAttribute('href');
              a.onclick = (ev) => { ev.preventDefault(); if (/^https?:/i.test(href || '')) shell.openExternal(href); };
            });
          } else {
            log.textContent = r.changelog;
            log.style.whiteSpace = 'pre-wrap';
          }
        };
        scroll.appendChild(row);
      }

      return new Promise((resolve) => {
        let done = false;
        const finish = (go) => { if (done) return; done = true; ov.remove(); resolve(go); };
        ov.querySelector('#uaX').onclick = () => finish(false);
        ov.querySelector('#uaNo').onclick = () => finish(false);
        ov.querySelector('#uaGo').onclick = () => finish(true);
        ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) finish(false); });
      });
    },
  };
})();
