// Choosing HOW to make a new instance or server, before choosing what goes in
// it.
//
// "New instance" used to open the full creator straight away — name, version,
// loader, RAM, arguments — which is the right screen for maybe a quarter of the
// instances anyone actually makes. Most start from a modpack, a mod, a pack
// file, or another launcher. Those are offered first, in the same picker style
// as the sync-from-instance chooser in Settings, and the hand-built route is
// one of the four rather than the only one.
//
//   window.NewInstance.choose({
//     target: 'instance' | 'server',
//     onCustom(prefill),     // open the ordinary creator (prefill may be null)
//     onImportFile(),        // upload a .mrpack / CurseForge .zip
//   })
//
// `prefill` is { name, icon, version, loader, loaderVersion, projectId } when
// the user started from a mod, so the creator opens already filled in with that
// mod's name, icon and newest supported version.
(function () {
  if (window.NewInstance) return;
  const { ipcRenderer } = require('electron');

  function ensureStyle() {
    if (document.getElementById('ni-style')) return;
    const s = document.createElement('style');
    s.id = 'ni-style';
    s.textContent = `
      .ni-overlay { position:fixed; inset:38px 0 0 70px; display:flex; align-items:center; justify-content:center;
        border-top-left-radius:var(--border-radius, 8px);
        background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); z-index:5400; }
      .ni-card { background:linear-gradient(135deg, var(--third-color), color-mix(in srgb, var(--third-color) 80%, black));
        border:2px solid var(--border-dark); border-radius:var(--border-radius); padding:18px; width:560px; max-width:94%;
        max-height:86vh; display:flex; flex-direction:column; box-shadow:0 18px 60px rgba(0,0,0,0.7); }
      .ni-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:4px; }
      .ni-head h2 { margin:0; font-size:1.1em; }
      .ni-head button { background:none; border:none; color:var(--text-color); cursor:pointer; font-size:16px; }
      .ni-sub { margin:0 0 12px; font-size:12px; opacity:0.8; line-height:1.5; }
      .ni-list { overflow-y:auto; flex:1; min-height:0; display:flex; flex-direction:column; gap:8px; }
      .ni-row { display:flex; align-items:center; gap:12px; padding:12px 14px; cursor:pointer;
        background:linear-gradient(135deg, color-mix(in srgb, var(--secondary-color) 50%, black) 0%, var(--menu-bg) 100%);
        border:2px solid var(--border-dark); border-radius:var(--border-radius); transition:var(--smooth-transition); }
      .ni-row:hover { border-color:var(--base-color); }
      .ni-row > i { font-size:26px; opacity:0.85; flex:0 0 26px; }
      .ni-row img { width:44px; height:44px; flex:0 0 44px; border-radius:8px; object-fit:cover; background:var(--very-dark); }
      .ni-row .t { font-size:14px; }
      .ni-row .d { font-size:11px; opacity:0.72; margin-top:2px; line-height:1.45; }
      .ni-row .tag { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; opacity:0.7;
        border:1px solid var(--border-dark); border-radius:6px; padding:2px 6px; margin-left:auto; flex:0 0 auto; }
      .ni-search { width:100%; box-sizing:border-box; padding:9px 12px; margin-bottom:10px;
        border:1px solid var(--border-dark); border-radius:var(--border-radius);
        background:var(--very-dark); color:var(--text-color); font-family:var(--text-font); }
      .ni-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
      .ni-actions button { padding:8px 16px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .ni-empty { opacity:0.7; padding:24px 4px; font-size:13px; line-height:1.6; }`;
    document.head.appendChild(s);
  }

  const shell = (title, sub) => {
    ensureStyle();
    const ov = document.createElement('div');
    ov.className = 'ni-overlay';
    const card = document.createElement('div');
    card.className = 'ni-card';
    card.innerHTML = `
      <div class="ni-head"><h2></h2><button class="ni-x">✕</button></div>
      <p class="ni-sub"></p>
      <div class="ni-list"></div>
      <div class="ni-actions"><button class="ni-cancel">Cancel</button></div>`;
    card.querySelector('h2').textContent = title;
    card.querySelector('.ni-sub').textContent = sub;
    ov.appendChild(card);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    card.querySelector('.ni-x').onclick = close;
    card.querySelector('.ni-cancel').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    return { ov, card, list: card.querySelector('.ni-list'), close };
  };

  function row(list, { icon, img, title, desc, tag, onClick }) {
    const el = document.createElement('div');
    el.className = 'ni-row';
    if (img) {
      const i = document.createElement('img');
      i.src = img;
      i.onerror = () => { i.style.visibility = 'hidden'; };
      el.appendChild(i);
    } else if (icon) {
      const i = document.createElement('i');
      i.className = 'material-icons';
      i.textContent = icon;
      el.appendChild(i);
    }
    const body = document.createElement('div');
    body.style.minWidth = '0';
    body.style.flex = '1';
    const t = document.createElement('div'); t.className = 't'; t.textContent = title;
    const d = document.createElement('div'); d.className = 'd'; d.textContent = desc || '';
    body.append(t, d);
    el.appendChild(body);
    if (tag) {
      const g = document.createElement('div');
      g.className = 'tag';
      g.textContent = tag;
      el.appendChild(g);
    }
    el.onclick = onClick;
    list.appendChild(el);
    return el;
  }

  const fmtDownloads = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M downloads';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K downloads';
    return n + ' downloads';
  };

  // ── Search ────────────────────────────────────────────────────────────────
  // Modpacks and mods together, modpacks first because that is overwhelmingly
  // what someone making a new instance is looking for, each set sorted by
  // downloads. Modrinth's facets take a list-of-lists: the inner list is OR,
  // the outer is AND.
  async function searchModrinth(query, type, limit) {
    const url = new URL('https://api.modrinth.com/v2/search');
    url.searchParams.set('query', query || '');
    url.searchParams.set('facets', JSON.stringify([[`project_type:${type}`]]));
    url.searchParams.set('index', 'downloads');
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Modrinth returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.hits || []).map(h => ({ ...h, project_type: type }));
  }

  async function openSearch(opts) {
    const { ov, card, list, close } = shell(
      opts.target === 'server' ? 'Find a modpack or mod for the server' : 'Find a modpack or mod',
      'Modpacks first, then mods, each sorted by downloads. Picking a mod sets an instance up for it.'
    );
    const input = document.createElement('input');
    input.className = 'ni-search';
    input.type = 'text';
    input.placeholder = 'Search modpacks and mods…';
    card.querySelector('.ni-sub').after(input);
    setTimeout(() => input.focus(), 0);

    let seq = 0;
    async function run() {
      const mine = ++seq;
      const q = input.value.trim();
      list.innerHTML = '<div class="ni-empty">Searching…</div>';
      let packs = [], mods = [];
      try {
        [packs, mods] = await Promise.all([
          searchModrinth(q, 'modpack', 20),
          searchModrinth(q, 'mod', 20),
        ]);
      } catch (err) {
        if (mine !== seq) return;
        list.innerHTML = '';
        const e = document.createElement('div');
        e.className = 'ni-empty';
        e.textContent = `Couldn't search: ${err.message}`;
        list.appendChild(e);
        return;
      }
      if (mine !== seq) return;   // a later keystroke won
      list.innerHTML = '';
      const all = packs.concat(mods);
      if (!all.length) {
        const e = document.createElement('div');
        e.className = 'ni-empty';
        e.textContent = q ? `Nothing found for "${q}".` : 'Nothing found.';
        list.appendChild(e);
        return;
      }
      for (const p of all) {
        row(list, {
          img: p.icon_url || undefined,
          icon: p.icon_url ? undefined : (p.project_type === 'modpack' ? 'inventory_2' : 'extension'),
          title: p.title,
          desc: `${fmtDownloads(p.downloads)} · ${p.description || ''}`,
          tag: p.project_type === 'modpack' ? 'modpack' : 'mod',
          onClick: () => pick(p),
        });
      }
    }

    async function pick(project) {
      if (project.project_type === 'modpack') {
        // The modpack picker already knows how to choose a version and whether
        // to build an instance or a server.
        let versions = [];
        try {
          const res = await fetch(`https://api.modrinth.com/v2/project/${project.project_id || project.slug}/version`);
          versions = res.ok ? await res.json() : [];
        } catch { /* reported below */ }
        if (!versions.length) {
          return uiAlert("That modpack has no downloadable versions.", 'Nothing to install');
        }
        close();
        window.ModpackInstall.open({ ...project, id: project.project_id }, versions);
        return;
      }

      // A mod: work out the newest Minecraft version and loader it supports,
      // and hand the creator a filled-in instance to make for it.
      let versions = [];
      try {
        const res = await fetch(`https://api.modrinth.com/v2/project/${project.project_id || project.slug}/version`);
        versions = res.ok ? await res.json() : [];
      } catch { /* handled below */ }
      const newest = versions[0] || null;
      const gameVersion = newest && (newest.game_versions || []).slice(-1)[0];
      const loader = newest && (newest.loaders || [])[0];
      close();
      opts.onCustom && opts.onCustom({
        name: project.title,
        icon: project.icon_url || null,
        version: gameVersion || null,
        loader: loader || 'vanilla',
        projectId: project.project_id || project.slug,
        projectTitle: project.title,
      });
    }

    let timer = null;
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 350); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
    run();   // the top downloads, before anything is typed
    return { ov, close };
  }

  // ── The chooser ───────────────────────────────────────────────────────────
  window.NewInstance = {
    search: openSearch,
    choose(opts) {
      opts = opts || {};
      const server = opts.target === 'server';
      const { list, close } = shell(
        server ? 'New server' : 'New instance',
        server
          ? 'Start from a modpack, or set the server up yourself.'
          : 'Start from a modpack or a mod, a pack file you already have, or another launcher — or set it all up yourself.'
      );

      row(list, {
        icon: 'travel_explore',
        title: 'A modpack or a mod',
        desc: 'Search Modrinth and install a modpack, or set an instance up for a single mod.',
        onClick: () => { close(); openSearch(opts); },
      });
      row(list, {
        icon: 'folder_zip',
        title: 'A modpack file',
        desc: 'A .mrpack or a CurseForge .zip you already have.',
        onClick: () => { close(); opts.onImportFile && opts.onImportFile(); },
      });
      if (!server) {
        row(list, {
          icon: 'move_to_inbox',
          title: 'From another launcher',
          desc: 'Copy an instance out of Prism, MultiMC, CurseForge, the Modrinth App or the vanilla launcher.',
          onClick: () => {
            close();
            // One instance, picked by clicking it — not the bulk importer from
            // Settings. You came here to make ONE instance.
            if (!window.Onboarding) return;
            window.Onboarding.openImport(null, {
              single: true,
              onPick: async (entry) => {
                if (!entry) return;
                if (!entry.version) {
                  return uiAlert('That instance does not say which Minecraft version it is. Type one in and pick it again.',
                    'Version needed');
                }
                const res = await ipcRenderer.invoke('import:instance', { entry });
                if (!res || !res.success) {
                  return uiAlert('Could not import it: ' + ((res && res.error) || 'unknown error'), 'Import failed');
                }
                if (window.notify) window.notify(`Imported ${entry.name}`, 'success');
                window.location.href = 'instances.html?i=' + encodeURIComponent(res.profileId);
              },
            });
          },
        });
      }
      row(list, {
        icon: 'tune',
        title: 'Set it up myself',
        desc: server
          ? 'Pick the version, the loader and the rest by hand.'
          : 'Pick the version, the loader, the icon and the rest by hand.',
        onClick: () => { close(); opts.onCustom && opts.onCustom(null); },
      });
    },
  };
})();
