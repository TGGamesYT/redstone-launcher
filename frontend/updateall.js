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
      /* The height is settled BEFORE anything opens and does not change
         after: opening a changelog used to make the whole dialog taller, so
         everything -- including the row you had just clicked, and the buttons
         -- moved out from under the cursor. It is set from the number of
         rows, so one mod does not get a dialog full of nothing. */
      .modal-content.ua-modal { display:flex; flex-direction:column; overflow:hidden; }
      .ua-modal .ua-scroll { flex:1; min-height:0; overflow-y:auto; padding-right:4px; }
      .ua-modal .modal-actions { flex:0 0 auto; margin-top:12px; }
      .ua-row { border:1px solid var(--border-dark); border-radius:var(--border-radius); margin-bottom:6px; overflow:hidden; }
      .ua-head { display:flex; align-items:center; gap:10px; padding:8px 10px; cursor:pointer;
        transition:background 0.15s ease; }
      .ua-head:hover { background:rgba(255,255,255,0.07); }
      .ua-head img { width:30px; height:30px; flex:0 0 30px; border-radius:6px; object-fit:contain;
        background:var(--menu-bg); image-rendering:pixelated; }
      .ua-name { flex:1; min-width:0; font-size:13px; word-break:break-word; }
      .ua-vers { font-size:12px; opacity:0.8; white-space:nowrap; }
      /* NOT --accent: on this dialog's own background that is red on red. A
         lift in weight and brightness says "this is the new one" on any
         theme, because it is not a colour at all. */
      .ua-vers .ua-to { color:var(--text-color); opacity:1; font-weight:600; }
      .ua-vers .ua-from { opacity:0.6; }
      .ua-head .ua-caret { font-size:18px; opacity:0.6; transition:transform 0.18s ease; }
      .ua-row.open .ua-head .ua-caret { transform:rotate(180deg); }
      /* Animated by its own height: a grid row from 0fr to 1fr collapses and
         expands smoothly without anybody having to measure the content. */
      .ua-logwrap { display:grid; grid-template-rows:0fr; transition:grid-template-rows 0.22s ease; }
      .ua-row.open .ua-logwrap { grid-template-rows:1fr; }
      .ua-log { overflow:hidden; font-size:12px; line-height:1.5; }
      .ua-log > .ua-login { padding:8px 12px 10px; border-top:1px solid var(--border-dark);
        background:var(--very-dark); }
      /* Left out of "update all". The row stays readable -- it is a choice,
         not an error. */
      .ua-row.off { opacity:0.5; }
      .ua-pick { flex:0 0 auto; width:18px; height:18px; margin:0; cursor:pointer; accent-color:var(--base-color); }
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
     *
     * Resolves with the items to actually update, which is everything still
     * ticked -- so a caller updates what comes back rather than what it sent
     * -- or an empty array if the dialog was dismissed.
     */
    confirm(items, what) {
      ensureStyle();
      const list = (items || []).filter(Boolean);
      if (!list.length) return Promise.resolve([]);
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
      // Room for the rows plus one changelog, capped at most of the window.
      // Worked out once, here, rather than following the content.
      const box = ov.querySelector('.ua-modal');
      box.style.height = `min(72vh, ${Math.max(300, list.length * 52 + 300)}px)`;
      document.body.appendChild(ov);
      const scroll = ov.querySelector('.ua-scroll');

      // Which ones are actually going to be updated. Everything is in to
      // begin with; a mod can be left out without leaving the dialog.
      const chosen = new Set(list.map((_, i) => i));

      list.forEach((it, i) => {
        const row = document.createElement('div');
        row.className = 'ua-row';
        const from = it.version ? esc(it.version) : '';
        const to = it.latestVersion ? esc(it.latestVersion) : 'the newest build';
        row.innerHTML = `
          <div class="ua-head">
            <input type="checkbox" class="ua-pick" checked title="Update this one">
            <img alt="">
            <span class="ua-name">${esc(it.name)}</span>
            <span class="ua-vers">${from ? '<span class="ua-from">' + from + '</span> → ' : ''}<span class="ua-to">${to}</span></span>
            <i class="material-icons ua-caret">expand_more</i>
          </div>
          <div class="ua-logwrap"><div class="ua-log"><div class="ua-login"></div></div></div>`;
        const img = row.querySelector('img');
        if (it.icon) { img.src = it.icon; img.onerror = () => { img.style.visibility = 'hidden'; }; }
        else img.style.visibility = 'hidden';

        const pick = row.querySelector('.ua-pick');
        pick.onclick = (ev) => ev.stopPropagation();   // ticking it is not opening it
        pick.onchange = () => {
          if (pick.checked) chosen.add(i); else chosen.delete(i);
          row.classList.toggle('off', !pick.checked);
          syncGo();
        };

        const log = row.querySelector('.ua-login');
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
      });

      // The button says how many it would do, and goes dead at none.
      const goBtn = ov.querySelector('#uaGo');
      function syncGo() {
        const n = chosen.size;
        goBtn.textContent = n === list.length ? 'Update all' : `Update ${n}`;
        goBtn.disabled = n === 0;
        goBtn.style.opacity = n === 0 ? '0.5' : '';
      }
      syncGo();

      return new Promise((resolve) => {
        let done = false;
        // Resolves with the items to update -- not a yes/no -- because some
        // of them may have been unticked.
        const finish = (go) => {
          if (done) return;
          done = true;
          ov.remove();
          resolve(go ? list.filter((_, i) => chosen.has(i)) : []);
        };
        ov.querySelector('#uaX').onclick = () => finish(false);
        ov.querySelector('#uaNo').onclick = () => finish(false);
        goBtn.onclick = () => { if (chosen.size) finish(true); };
        ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) finish(false); });
      });
    },
  };
})();
