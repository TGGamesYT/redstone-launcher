// Starting a modpack install. Kicking one off used to be a single await that
// came back minutes later, with nothing on screen in the meantime; now the main
// process takes a ticket, answers straight away, and reports its progress
// against that ticket — so the caller can hand the user straight over to the
// instances page, which follows the rest of the work.
(function () {
  const { ipcRenderer } = require('electron');

  function ensureStyle() {
    if (document.getElementById('mpi-style')) return;
    const s = document.createElement('style');
    s.id = 'mpi-style';
    s.textContent = `
      .mpi-overlay { position:fixed; inset:38px 0 0 70px; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); z-index:5200; }
      .mpi-card { background:linear-gradient(135deg, var(--third-color), color-mix(in srgb, var(--third-color) 80%, black));
        border:2px solid var(--border-dark); border-radius:var(--border-radius); padding:18px; width:540px; max-width:92%;
        max-height:84vh; display:flex; flex-direction:column; box-shadow:0 18px 60px rgba(0,0,0,0.7); }
      .mpi-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
      .mpi-head h2 { margin:0; font-size:1.1em; }
      .mpi-seg { display:flex; gap:8px; margin-bottom:12px; }
      .mpi-seg button { flex:1; padding:9px 10px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .mpi-seg button.active { background:var(--base-color); border-color:var(--text-color); }
      .mpi-seg button:disabled { opacity:0.4; cursor:not-allowed; }
      .mpi-note { font-size:11px; opacity:0.7; margin:-6px 0 12px; }
      .mpi-list { overflow-y:auto; flex:1; min-height:0; border:1px solid var(--border-dark); border-radius:var(--border-radius); }
      .mpi-ver { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 12px; cursor:pointer;
        border-bottom:1px solid color-mix(in srgb, var(--border-dark) 60%, transparent); }
      .mpi-ver:last-child { border-bottom:none; }
      .mpi-ver:hover { background:var(--menu-hover-bg); }
      .mpi-ver.sel { background:var(--base-color); }
      .mpi-ver .n { font-size:13px; }
      .mpi-ver .m { font-size:11px; opacity:0.75; }
      .mpi-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
      .mpi-actions button { padding:8px 16px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .mpi-actions button.primary { background:var(--base-color); }
      .mpi-actions button:disabled { opacity:0.5; cursor:not-allowed; }`;
    document.head.appendChild(s);
  }

  const loaderOf = (v) => (v.loaders || []).join(', ') || 'unknown';
  const mcOf = (v) => (v.game_versions || []).join(', ');
  // A pack whose loader has no server side can't be set up as one.
  const SERVER_LOADERS = ['forge', 'neoforge', 'fabric', 'quilt'];
  const serverCapable = (v) => (v.loaders || []).some(l => SERVER_LOADERS.includes(String(l).toLowerCase()));

  window.ModpackInstall = {
    // The picker: which version, and whether this becomes a client instance or
    // a server. Install used to drop straight into "newest, as an instance",
    // which is why packs meant to be hosted kept turning into instances.
    open(project, versions) {
      ensureStyle();
      const list = (versions || []).slice().sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
      const ov = document.createElement('div');
      ov.className = 'mpi-overlay';
      const card = document.createElement('div');
      card.className = 'mpi-card';
      card.innerHTML = `
        <div class="mpi-head"><h2>Install ${project.title || 'modpack'}</h2><button class="mpi-x" style="background:none;border:none;color:var(--text-color);cursor:pointer;font-size:16px;">✕</button></div>
        <div class="mpi-seg">
          <button data-as="instance" class="active">As an instance</button>
          <button data-as="server">As a server</button>
        </div>
        <div class="mpi-note"></div>
        <div class="mpi-list"></div>
        <div class="mpi-actions"><button class="mpi-cancel">Cancel</button><button class="mpi-go primary" disabled>Install</button></div>`;
      ov.appendChild(card);
      document.body.appendChild(ov);

      const listEl = card.querySelector('.mpi-list');
      const noteEl = card.querySelector('.mpi-note');
      const goBtn = card.querySelector('.mpi-go');
      let mode = 'instance';
      let chosen = null;

      const close = () => ov.remove();
      card.querySelector('.mpi-x').onclick = close;
      card.querySelector('.mpi-cancel').onclick = close;
      ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });

      const paint = () => {
        listEl.innerHTML = '';
        if (!list.length) { listEl.innerHTML = '<div style="padding:14px;opacity:0.7;">No versions found.</div>'; return; }
        let anyUsable = false;
        list.forEach(v => {
          const usable = mode === 'instance' || serverCapable(v);
          if (usable) anyUsable = true;
          const row = document.createElement('div');
          row.className = 'mpi-ver' + (chosen === v ? ' sel' : '');
          if (!usable) { row.style.opacity = '0.4'; row.style.cursor = 'not-allowed'; }
          const left = document.createElement('div');
          left.innerHTML = `<div class="n"></div><div class="m"></div>`;
          left.querySelector('.n').textContent = v.name || v.version_number;
          left.querySelector('.m').textContent = `${v.version_number} · ${mcOf(v)} · ${loaderOf(v)}`;
          row.appendChild(left);
          if (!usable) {
            const t = document.createElement('div');
            t.className = 'm';
            t.textContent = 'no server build';
            row.appendChild(t);
          }
          row.onclick = () => { if (!usable) return; chosen = v; paint(); };
          listEl.appendChild(row);
        });
        goBtn.disabled = !chosen;
        noteEl.textContent = mode === 'server'
          ? (anyUsable ? "Sets the pack up as a server you host. Client-only mods in the pack are skipped."
            : "None of these versions ship a loader that can run as a server.")
          : "Creates a normal instance you can play.";
      };

      card.querySelectorAll('.mpi-seg button').forEach(b => {
        b.onclick = () => {
          mode = b.dataset.as;
          card.querySelectorAll('.mpi-seg button').forEach(x => x.classList.toggle('active', x === b));
          // The chosen version may not be valid for the other mode.
          if (mode === 'server' && chosen && !serverCapable(chosen)) chosen = null;
          paint();
        };
      });
      goBtn.onclick = async () => {
        if (!chosen) return;
        const file = (chosen.files || []).find(f => String(f.url || '').endsWith('.mrpack')) || (chosen.files || [])[0];
        if (!file) return alert('That version has no downloadable pack file.');
        goBtn.disabled = true;
        goBtn.textContent = 'Starting…';
        await window.ModpackInstall.start(file.url, project.title || chosen.name, mode);
      };
      paint();
    },

    // url: the .mrpack download. name: what to call it until the pack's own
    // name comes back out of the archive. as: 'instance' (default) or 'server'.
    async start(url, name, as) {
      const ticket = 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const res = await ipcRenderer.invoke('modpack:install', { url, ticket, name: name || '', as });
      if (!res || !res.success) {
        alert('Could not start the install: ' + ((res && res.error) || 'unknown error'));
        return null;
      }
      const page = as === 'server' ? 'server.html' : 'instances.html';
      window.location.href = page + '?installing=' + encodeURIComponent(ticket);
      return ticket;
    },
  };
})();
