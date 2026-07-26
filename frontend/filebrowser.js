// Reusable file browser (used by the instance Files tab; the server detail has
// its own inline copy). Renders a breadcrumb + folder list + editor that opens
// .dat/.json in a tree (via FileTree) and everything else as text. Auto-saves.
// Can browse inside .zip and read .gz (read-only). Scoped by an fs IPC channel.
(function () {
  const { ipcRenderer } = require('electron');

  function ensureStyle() {
    if (document.getElementById('fb-style')) return;
    const s = document.createElement('style'); s.id = 'fb-style';
    s.textContent = `
      .file-entry { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:var(--border-radius); cursor:pointer; font-size:13px; }
      .file-entry:hover { background: var(--menu-hover-bg); }
      .file-entry .material-icons { font-size:18px; }
      .file-entry .file-act { font-size:16px; opacity:0; cursor:pointer; padding:2px; border-radius:4px; }
      .file-entry:hover .file-act { opacity:0.7; }
      .file-entry .file-act:hover { opacity:1; background:rgba(0,0,0,0.25); }`;
    document.head.appendChild(s);
  }

  window.FileBrowser = {
    // opts: { channel:'client-fs'|'server-fs', idField:'id'|'name', id }
    mount(container, opts) {
      ensureStyle();
      const chan = opts.channel, idField = opts.idField, idVal = opts.id;
      const arg = (extra) => Object.assign({ [idField]: idVal, [(chan === 'client-fs' ? 'id' : 'name')]: idVal }, extra);

      container.innerHTML = `
        <div style="display:flex; flex-direction:column; height:100%; min-height:0;">
          <div class="tab-action-bar" style="display:flex; gap:6px; margin-bottom:8px;">
            <button class="fb-explorer" title="Open in file explorer"><i class="material-icons" style="font-size:16px;vertical-align:middle;">folder_open</i></button>
            <button class="fb-newfile" title="New file"><i class="material-icons" style="font-size:16px;vertical-align:middle;">note_add</i></button>
            <button class="fb-newfolder" title="New folder"><i class="material-icons" style="font-size:16px;vertical-align:middle;">create_new_folder</i></button>
          </div>
          <div class="fb-breadcrumb" style="display:flex; align-items:center; gap:4px; margin-bottom:8px; flex-wrap:wrap; font-size:13px;"></div>
          <div style="flex:1; min-height:0; display:flex; flex-direction:column;">
            <ul class="fb-list" style="list-style:none; margin:0; padding:6px; flex:1; min-height:0; overflow-y:auto; border:1px solid var(--secondary-color); border-radius:var(--border-radius);"></ul>
            <div class="fb-editor" style="display:none; flex-direction:column; flex:1; min-height:0;">
              <div style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">
                <span class="fb-name" style="font-weight:bold; word-break:break-all; flex:1;"></span>
                <button class="fb-toggle" style="padding:4px 10px; display:none;">Raw JSON</button>
              </div>
              <div class="fb-tree" style="flex:1; min-height:0; display:none;"></div>
              <textarea class="fb-area" spellcheck="false" style="flex:1; width:100%; font-family:monospace; resize:none; margin:0; border:1px solid var(--secondary-color); border-radius:var(--border-radius);"></textarea>
              <div class="fb-state" style="font-size:12px; opacity:0.7; margin-top:6px; height:16px;"></div>
            </div>
          </div>
        </div>`;

      const $ = (sel) => container.querySelector(sel);
      const bc = $('.fb-breadcrumb'), list = $('.fb-list'), editor = $('.fb-editor');
      const nameEl = $('.fb-name'), toggleBtn = $('.fb-toggle'), tree = $('.fb-tree'), area = $('.fb-area'), state = $('.fb-state');

      let curDir = '', curFile = null, saveTimer = null;
      let kind = 'text', view = 'tree', data = null, nbtMeta = null, readOnly = false;

      function crumb(label, target) {
        const a = document.createElement('a');
        a.textContent = label; a.style.cssText = 'cursor:pointer;text-decoration:underline;';
        a.onclick = () => loadDir(target);
        return a;
      }
      function renderBreadcrumb(fileName) {
        bc.innerHTML = '';
        bc.appendChild(crumb(opts.rootLabel || 'root', ''));
        let acc = '';
        curDir.split('/').filter(Boolean).forEach(p => { acc = acc ? acc + '/' + p : p; bc.append(' / ', crumb(p, acc)); });
        if (fileName) { const s = document.createElement('span'); s.textContent = ' / ' + fileName; s.style.opacity = '0.85'; bc.append(s); }
      }

      async function loadDir(rel) {
        curDir = rel || ''; curFile = null; clearTimeout(saveTimer);
        list.style.display = ''; editor.style.display = 'none';
        renderBreadcrumb(null);
        const res = await ipcRenderer.invoke(chan + ':list', arg({ path: curDir }));
        const parts = curDir.split('/').filter(Boolean);
        list.innerHTML = '';
        if (curDir) {
          const up = document.createElement('li');
          up.className = 'file-entry';
          up.innerHTML = '<i class="material-icons">arrow_upward</i> ..';
          up.onclick = () => loadDir(parts.slice(0, -1).join('/'));
          list.appendChild(up);
        }
        (res.entries || []).forEach(e => {
          const li = document.createElement('li');
          li.className = 'file-entry';
          const icon = e.isDir ? 'folder' : e.isArchive ? 'folder_zip' : 'description';
          const rowPath = curDir ? curDir + '/' + e.name : e.name;
          li.innerHTML = `<i class="material-icons">${icon}</i> <span style="flex:1;word-break:break-all;">${e.name}</span>`;
          if (!e.isArchive) {
            const cp = document.createElement('i'); cp.className = 'material-icons file-act'; cp.textContent = 'content_copy'; cp.title = 'Duplicate';
            cp.onclick = async (ev) => { ev.stopPropagation(); await ipcRenderer.invoke(chan + ':copy', arg({ path: rowPath })); loadDir(curDir); };
            const dl = document.createElement('i'); dl.className = 'material-icons file-act'; dl.textContent = 'delete'; dl.title = 'Delete';
            dl.onclick = async (ev) => { ev.stopPropagation(); if (!confirm(`Delete "${e.name}"?`)) return; await ipcRenderer.invoke(chan + ':delete', arg({ path: rowPath })); loadDir(curDir); };
            li.append(cp, dl);
          }
          li.onclick = () => (e.isDir || e.isArchive) ? loadDir(rowPath) : openFile(rowPath, e.name);
          list.appendChild(li);
        });
      }

      container.querySelector('.fb-explorer').onclick = () => {
        if (chan === 'client-fs') ipcRenderer.send('open-instance-folder', { profileId: idVal, sub: curDir });
        else ipcRenderer.send('open-folder', { id: idVal, isClient: false, sub: curDir });
      };
      container.querySelector('.fb-newfile').onclick = async () => {
        const nm = prompt('New file name:'); if (!nm) return;
        const r = await ipcRenderer.invoke(chan + ':newfile', arg({ path: curDir, file: nm }));
        if (r && r.error) alert(r.error); else loadDir(curDir);
      };
      container.querySelector('.fb-newfolder').onclick = async () => {
        const nm = prompt('New folder name:'); if (!nm) return;
        const r = await ipcRenderer.invoke(chan + ':mkdir', arg({ path: curDir, folder: nm }));
        if (r && r.error) alert(r.error); else loadDir(curDir);
      };

      function scheduleSave() {
        if (!curFile || readOnly) return;
        state.textContent = 'Saving…';
        clearTimeout(saveTimer);
        const target = curFile;
        saveTimer = setTimeout(async () => {
          let res;
          if (kind === 'nbt') {
            const json = view === 'raw' ? area.value : JSON.stringify(data);
            res = await ipcRenderer.invoke(chan + ':write-nbt', arg({ path: target, json, gzip: nbtMeta.gzip, type: nbtMeta.type }));
          } else if (kind === 'json') {
            const text = view === 'raw' ? area.value : JSON.stringify(data, null, 2);
            res = await ipcRenderer.invoke(chan + ':write', arg({ path: target, text }));
          } else {
            res = await ipcRenderer.invoke(chan + ':write', arg({ path: target, text: area.value }));
          }
          state.textContent = (res && res.error) ? ('Save failed: ' + res.error) : 'Saved ✓';
        }, 500);
      }

      function showTree() { view = 'tree'; tree.style.display = ''; area.style.display = 'none'; toggleBtn.textContent = 'Raw JSON'; window.FileTree.render(tree, data, { mode: kind === 'nbt' ? 'nbt' : 'json', onChange: scheduleSave }); }
      function showRaw() { view = 'raw'; area.value = JSON.stringify(data, null, 2); area.style.display = ''; tree.style.display = 'none'; toggleBtn.textContent = 'Tree'; }
      toggleBtn.onclick = () => {
        if (view === 'tree') showRaw();
        else { try { data = JSON.parse(area.value); showTree(); scheduleSave(); } catch (e) { alert('Invalid JSON: ' + e.message); } }
      };

      async function openFile(rel, name) {
        renderBreadcrumb(name);
        list.style.display = 'none'; editor.style.display = 'flex';
        nameEl.textContent = name; state.textContent = '';
        curFile = rel; data = null; nbtMeta = null; readOnly = false; kind = 'text'; view = 'tree';
        toggleBtn.style.display = 'none'; tree.style.display = 'none'; area.style.display = ''; area.disabled = false;

        if (/\.(dat|dat_old)$/i.test(name)) {
          const n = await ipcRenderer.invoke(chan + ':read-nbt', arg({ path: rel }));
          if (n && !n.error) {
            kind = 'nbt'; nbtMeta = { gzip: n.gzip, type: n.type };
            try { data = JSON.parse(n.json); } catch { data = {}; }
            toggleBtn.style.display = ''; state.textContent = 'NBT (.dat) — tree edits saved back as NBT';
            showTree(); return;
          }
        }

        const res = await ipcRenderer.invoke(chan + ':read', arg({ path: rel }));
        readOnly = !!res.readOnly;
        if (res.binary) { area.value = '(binary file — not editable)'; area.disabled = true; curFile = null; return; }
        if (res.error) { area.value = '(' + res.error + ')'; area.disabled = true; curFile = null; return; }

        if (/\.json$/i.test(name) && !readOnly) {
          try { data = JSON.parse(res.text || 'null'); kind = 'json'; toggleBtn.style.display = ''; showTree(); return; } catch { /* text */ }
        }
        kind = 'text'; area.disabled = readOnly; area.value = res.text || '';
        state.textContent = readOnly ? '(read-only — inside archive / compressed)' : '';
      }

      area.addEventListener('input', scheduleSave);
      loadDir(opts.startDir || '');
    },
  };
})();
