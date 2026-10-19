// Remod — the dialog for editing an installed mod jar or resource pack.
//
// The fields it offers are the ones the archive's own manifest actually holds,
// which the main process works out when it unpacks the file; a shader pack
// with no manifest at all still opens, for its file name and its assets.
// "Edit assets" is the launcher's ordinary file browser pointed at the
// unpacked copy, so everything it can already do — editing a JSON in a tree,
// adding files, deleting them — works on a mod's insides unchanged.
//
// Nothing touches the installed file until Save, which packs the workspace
// back up in the same structure. Closing the dialog throws the workspace away.
(function () {
  const { ipcRenderer } = require('electron');

  function ensureStyle() {
    if (document.getElementById('remod-style')) return;
    const s = document.createElement('style');
    s.id = 'remod-style';
    s.textContent = `
      .modal-content.rm-modal { display:flex; flex-direction:column; overflow:hidden; max-height:85vh; }
      .rm-modal .rm-scroll { flex:1; min-height:0; overflow-y:auto; padding-right:4px; }
      .rm-modal .rm-files { flex:1; min-height:0; display:none; }
      .rm-modal .modal-actions { flex:0 0 auto; margin-top:12px; }
      .rm-row { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
      .rm-row label { font-size:12px; opacity:0.8; }
      .rm-row input, .rm-row textarea { width:100%; box-sizing:border-box; }
      .rm-row textarea { min-height:72px; resize:vertical; font-family:inherit; }
      .rm-head { display:flex; gap:12px; align-items:center; margin-bottom:12px; }
      .rm-head img { width:64px; height:64px; border-radius:var(--border-radius); background:var(--menu-bg);
        image-rendering:pixelated; object-fit:contain; border:1px solid var(--border-dark); }
      .rm-kind { font-size:12px; opacity:0.7; }`;
    document.head.appendChild(s);
  }

  const LABELS = {
    name: 'Name',
    version: 'Version',
    authors: 'Authors',
    description: 'Description',
  };
  // What an archive with no manifest is, said plainly.
  const KINDS = {
    mod: 'mod', pack: 'resource pack', plugin: 'plugin',
    file: 'archive (nothing in it declares a name, so only its files and its file name can be changed)',
  };

  window.Remod = {
    // { type:'instance'|'server', id, tab, filename, onSaved }
    async open(opts) {
      ensureStyle();
      const info = await ipcRenderer.invoke('remod:open', {
        type: opts.type, id: opts.id, tab: opts.tab, filename: opts.filename,
      });
      if (!info || info.error) {
        if (window.uiAlert) await uiAlert((info && info.error) || 'Could not open that file', { title: 'Remod' });
        return false;
      }

      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const supports = info.supports || [];
      const rows = ['name', 'version', 'authors', 'description'].filter(k => supports.includes(k));

      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 6500;
      ov.innerHTML = `
        <div class="modal-content rm-modal" style="max-width:620px; width:92%;">
          <div class="modal-header">
            <h2>Edit ${esc(info.filename)}</h2>
            <button class="modal-close" id="rmX">✕</button>
          </div>
          <div class="rm-scroll">
            <div class="rm-head">
              ${supports.includes('icon') ? `<img id="rmIcon" alt="">` : ''}
              <div style="flex:1; min-width:0;">
                <div class="rm-kind">This is a ${KINDS[info.kind] || info.kind}${info.manifest ? `, declared in <code>${esc(info.manifest)}</code>` : ''}.</div>
                ${supports.includes('icon') ? `
                  <div style="margin-top:8px; display:flex; gap:6px;">
                    <button id="rmPickIcon">Change icon</button>
                  </div>` : ''}
              </div>
            </div>
            <div class="rm-row">
              <label for="rmFile">File name</label>
              <input id="rmFile" type="text" spellcheck="false" value="${esc(String(info.filename).replace(/\.disabled$/i, ''))}">
            </div>
            ${rows.map(k => `
              <div class="rm-row">
                <label for="rm_${k}">${LABELS[k]}</label>
                ${k === 'description'
          ? `<textarea id="rm_${k}" spellcheck="false">${esc(info.fields[k])}</textarea>`
          : `<input id="rm_${k}" type="text" spellcheck="false" value="${esc(info.fields[k])}">`}
              </div>`).join('')}
            ${rows.includes('authors') ? '<div class="rm-kind">Separate authors with commas.</div>' : ''}
          </div>
          <div class="rm-files"></div>
          <div class="modal-actions">
            <button id="rmAssets">Edit assets</button>
            <button id="rmSave">Save</button>
            <button id="rmCancel">Cancel</button>
          </div>
        </div>`;
      document.body.appendChild(ov);

      const $ = (s) => ov.querySelector(s);
      const scroll = $('.rm-scroll'), filesPane = $('.rm-files');
      const iconImg = $('#rmIcon');
      if (iconImg) iconImg.src = info.icon || 'logo.png';

      let iconDirty = false, fieldsAtOpen = {};
      for (const k of rows) fieldsAtOpen[k] = String(info.fields[k] ?? '');

      // ── Edit assets: the ordinary file browser, rooted at the workspace ──
      let showingFiles = false, mounted = false;
      const assetsBtn = $('#rmAssets');
      const setPane = (files) => {
        showingFiles = files;
        scroll.style.display = files ? 'none' : '';
        filesPane.style.display = files ? 'flex' : 'none';
        assetsBtn.textContent = files ? 'Back to details' : 'Edit assets';
        if (files && !mounted) {
          mounted = true;
          window.FileBrowser.mount(filesPane, {
            channel: 'remod-fs', idField: 'id', id: info.ticket,
            rootLabel: String(info.filename).replace(/\.disabled$/i, ''),
            // The browser's own "open in file explorer" wants the workspace.
            openFolder: (sub) => ipcRenderer.invoke('remod:open-folder', { ticket: info.ticket, sub }),
          });
        }
      };
      assetsBtn.onclick = () => setPane(!showingFiles);

      if (iconImg) {
        $('#rmPickIcon').onclick = async () => {
          const pick = await ipcRenderer.invoke('pick-image', { title: 'Choose an icon' });
          if (!pick || pick.canceled) return;
          if (pick.error) { if (window.notify) notify(pick.error, 'error'); return; }
          const r = await ipcRenderer.invoke('remod:set-icon', { ticket: info.ticket, dataUrl: pick.dataUrl });
          if (r && r.error) { if (window.notify) notify(r.error, 'error'); return; }
          iconDirty = true;
          if (r && r.icon) iconImg.src = r.icon;
          if (window.notify) notify('Icon replaced in ' + (r.path || 'the archive'), 'success');
        };
      }

      return await new Promise((resolve) => {
        let done = false;
        const finish = async (saved) => {
          if (done) return;
          done = true;
          if (!saved) await ipcRenderer.invoke('remod:cancel', { ticket: info.ticket });
          ov.remove();
          resolve(saved);
        };
        const close = async () => {
          // Only ask when there is something to lose. Files edited in the
          // browser are saved into the workspace as you type, so leaving
          // without saving drops those too.
          const changedFields = rows.some(k => String($('#rm_' + k).value) !== fieldsAtOpen[k]);
          const renamed = $('#rmFile').value.trim() !== String(info.filename).replace(/\.disabled$/i, '');
          if ((changedFields || renamed || iconDirty || mounted) && window.uiConfirm) {
            const ok = await uiConfirm('Throw away the changes to this file?', { title: 'Discard', ok: 'Discard', danger: true });
            if (!ok) return;
          }
          finish(false);
        };
        $('#rmX').onclick = close;
        $('#rmCancel').onclick = close;
        ov.addEventListener('mousedown', (ev) => { if (ev.target === ov) close(); });

        $('#rmSave').onclick = async () => {
          const btn = $('#rmSave');
          btn.disabled = true;
          const fields = {};
          for (const k of rows) fields[k] = $('#rm_' + k).value;
          const r = await ipcRenderer.invoke('remod:save', {
            ticket: info.ticket, fields, filename: $('#rmFile').value.trim(),
          });
          if (r && r.error) {
            btn.disabled = false;
            if (window.uiAlert) await uiAlert(r.error, { title: 'Could not save' });
            else if (window.notify) notify(r.error, 'error');
            return;
          }
          if (window.notify) notify('Saved ' + (r.filename || info.filename), 'success');
          if (opts.onSaved) { try { await opts.onSaved(r.filename || info.filename); } catch { /* the caller's refresh */ } }
          finish(true);
        };
      });
    },
  };
})();
