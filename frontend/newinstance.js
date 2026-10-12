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
      .ni-head .ni-title { display:flex; align-items:center; gap:6px; }
      .ni-head .ni-back { font-size:22px; line-height:1; padding:0 4px; opacity:0.8; }
      .ni-head .ni-back:hover { opacity:1; }
      .ni-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
      .ni-actions .ni-backBtn { margin-right:auto; }
      .ni-actions button { padding:8px 16px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .ni-empty { opacity:0.7; padding:24px 4px; font-size:13px; line-height:1.6; }

      /* The version / loader cards: the wiki banner behind, the version's own
         rendered icon on top of it, the name under that. */
      .ni-cards { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px;
        overflow-y:auto; flex:1; min-height:0; padding:2px; align-content:start; }
      .ni-tile { position:relative; height:104px; border:2px solid var(--border-dark);
        border-radius:var(--border-radius); overflow:hidden; cursor:pointer;
        background:var(--very-dark); transition:var(--smooth-transition); }
      .ni-tile:hover { border-color:var(--base-color); }
      .ni-tile.sel { border-color:var(--base-color); box-shadow:0 0 0 2px color-mix(in srgb, var(--base-color) 60%, transparent); }
      .ni-tile .bg { position:absolute; inset:0; background-size:cover; background-position:center;
        opacity:0; transition:opacity 0.25s ease; }
      .ni-tile .bg.on { opacity:1; }
      /* Readable names over whatever the banner happens to be. */
      .ni-tile .veil { position:absolute; inset:0; background:linear-gradient(180deg,
        rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.35) 45%, rgba(0,0,0,0.78) 100%); }
      .ni-tile .inner { position:absolute; inset:0; display:flex; flex-direction:column;
        align-items:center; justify-content:center; gap:6px; padding:8px; text-align:center; }
      .ni-tile .inner img { width:40px; height:40px; object-fit:contain;
        filter:drop-shadow(0 2px 4px rgba(0,0,0,0.7)); }
      .ni-tile .n { font-size:13px; font-weight:600; text-shadow:0 1px 3px rgba(0,0,0,0.9); }
      .ni-tile .s { font-size:10px; opacity:0.85; text-shadow:0 1px 3px rgba(0,0,0,0.9); }
      /* The snapshot card is the odd one out and says so. */
      .ni-tile.wide { grid-column:span 2; }
      .ni-plain { display:flex; align-items:center; justify-content:space-between; gap:10px;
        padding:9px 12px; cursor:pointer; border-bottom:1px solid color-mix(in srgb, var(--border-dark) 60%, transparent); }
      .ni-plain:last-child { border-bottom:none; }
      .ni-plain:hover { background:var(--menu-hover-bg, rgba(255,255,255,0.06)); }
      .ni-plain.sel { background:var(--base-color); }
      .ni-plain .m { font-size:11px; opacity:0.75; }
      .ni-plainlist { overflow-y:auto; flex:1; min-height:0; border:1px solid var(--border-dark);
        border-radius:var(--border-radius); }`;
    document.head.appendChild(s);
  }

  /**
   * One screen of the chooser.
   *
   * `onBack` makes this screen a step in a sequence rather than a dead end:
   * Back returns to the screen that opened it, while ✕ and clicking away
   * still mean "I have changed my mind about the whole thing" and close
   * everything. Without it, picking "a modpack or a mod" and then deciding
   * against it dropped you all the way out and you had to start again.
   */
  // Only ever one of these on screen. Each step closes the one before it, but
  // the + button can be clicked again while one is already open -- and used to
  // stack a second, identical chooser on top of the first.
  let openShell = null;

  const shell = (title, sub, opts = {}) => {
    ensureStyle();
    if (openShell && openShell.isConnected) openShell.remove();
    const ov = document.createElement('div');
    ov.className = 'ni-overlay';
    const card = document.createElement('div');
    card.className = 'ni-card';
    card.innerHTML = `
      <div class="ni-head">
        <div class="ni-title"><button class="ni-back" style="display:none" title="Back">‹</button><h2></h2></div>
        <button class="ni-x" title="Close">✕</button>
      </div>
      <p class="ni-sub"></p>
      <div class="ni-list"></div>
      <div class="ni-actions"><button class="ni-backBtn" style="display:none">Back</button><button class="ni-cancel">Cancel</button></div>`;
    card.querySelector('h2').textContent = title;
    card.querySelector('.ni-sub').textContent = sub;
    ov.appendChild(card);
    document.body.appendChild(ov);
    openShell = ov;
    const close = () => { ov.remove(); if (openShell === ov) openShell = null; };
    const back = typeof opts.onBack === 'function'
      ? () => { close(); opts.onBack(); }
      : null;
    card.querySelector('.ni-x').onclick = close;
    ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
    if (back) {
      for (const sel of ['.ni-back', '.ni-backBtn']) {
        const b = card.querySelector(sel);
        b.style.display = '';
        b.onclick = back;
      }
      // Cancel on a step means "not this one", which is the same as Back.
      card.querySelector('.ni-cancel').textContent = 'Cancel';
      card.querySelector('.ni-cancel').onclick = close;
    } else {
      card.querySelector('.ni-cancel').onclick = close;
    }
    return { ov, card, list: card.querySelector('.ni-list'), close, back };
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
  // Both sites, because plenty of packs are only on one of them and a search
  // that quietly covered half of what exists looked like the pack was gone.
  // Each hit is flattened to the same handful of fields so the list and the
  // click do not care where it came from.
  const CF_WORKER = 'https://curseforge.tgdoescode.workers.dev';
  const CF_CLASS = { modpack: 4471, mod: 6 };

  async function searchModrinth(query, type, limit) {
    const url = new URL('https://api.modrinth.com/v2/search');
    url.searchParams.set('query', query || '');
    url.searchParams.set('facets', JSON.stringify([[`project_type:${type}`]]));
    url.searchParams.set('index', 'downloads');
    url.searchParams.set('limit', String(limit));
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Modrinth returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.hits || []).map(h => ({
      source: 'modrinth', type,
      id: h.project_id || h.slug, title: h.title, description: h.description,
      icon: h.icon_url || null, downloads: h.downloads || 0, raw: h,
    }));
  }

  async function searchCurseforge(query, type, limit) {
    const res = await fetch(`${CF_WORKER}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: 432, classId: CF_CLASS[type], searchFilter: query || '',
        sortField: 6, sortOrder: 'desc', pageSize: limit, index: 0,   // 6 = total downloads
      }),
    });
    if (!res.ok) throw new Error(`CurseForge returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.data || []).map(m => ({
      source: 'curseforge', type,
      id: m.id, title: m.name, description: m.summary,
      icon: (m.logo && m.logo.url) || null, downloads: m.downloadCount || 0, raw: m,
    }));
  }

  // One site being down, or blocked, should not take the other with it.
  const searchBoth = (query, type, limit) => Promise.all([
    searchModrinth(query, type, limit).catch(e => ({ error: e })),
    searchCurseforge(query, type, limit).catch(e => ({ error: e })),
  ]).then(([a, b]) => {
    const hits = [].concat(Array.isArray(a) ? a : [], Array.isArray(b) ? b : []);
    if (!Array.isArray(a) && !Array.isArray(b)) throw (a.error || b.error);
    return hits.sort((x, y) => y.downloads - x.downloads);
  });

  // CurseForge numbers its loaders. 0 is "any".
  const CF_LOADERS = { 1: 'forge', 2: 'cauldron', 3: 'liteloader', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };

  async function curseforgeFiles(projectId) {
    const res = await fetch(`${CF_WORKER}/files?projectID=${encodeURIComponent(projectId)}`);
    if (!res.ok) return [];
    const j = await res.json();
    // Dressed as a Modrinth version, which is the shape the rest of the
    // launcher already speaks. The download link is deliberately absent: it
    // has to be asked for per file, and only when one is actually chosen.
    return (Array.isArray(j.data) ? j.data : []).map(f => ({
      source: 'curseforge',
      name: f.displayName || f.fileName,
      version_number: f.fileName,
      date_published: f.fileDate,
      game_versions: (f.gameVersions || []).filter(v => /^\d/.test(v)),
      loaders: (f.gameVersions || []).filter(v => !/^\d/.test(v)).map(v => v.toLowerCase()),
      files: [{ url: null, filename: f.fileName, cf: { projectID: projectId, fileID: f.id, fileName: f.fileName } }],
    }));
  }

  async function openSearch(opts) {
    const { ov, card, list, close } = shell(
      opts.target === 'server' ? 'Find a modpack or mod for the server' : 'Find a modpack or mod',
      'Modrinth and CurseForge. Modpacks first, then mods, each sorted by downloads. '
      + 'Picking a mod sets an instance up for it.',
      { onBack: opts.onBack }
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
          searchBoth(q, 'modpack', 20),
          searchBoth(q, 'mod', 20),
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
          img: p.icon || undefined,
          icon: p.icon ? undefined : (p.type === 'modpack' ? 'inventory_2' : 'extension'),
          title: p.title,
          desc: `${fmtDownloads(p.downloads)} · ${p.description || ''}`,
          // Which site it is from matters: the same pack is often on both,
          // under slightly different names and versions.
          tag: `${p.type} · ${p.source === 'curseforge' ? 'CurseForge' : 'Modrinth'}`,
          onClick: () => pick(p),
        });
      }
    }

    // Every published build of a project, in Modrinth's shape whichever site
    // it is from, newest first.
    async function versionsOf(project) {
      if (project.source === 'curseforge') {
        const files = await curseforgeFiles(project.id);
        return files.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
      }
      try {
        const res = await fetch(`https://api.modrinth.com/v2/project/${project.id}/version`);
        return res.ok ? await res.json() : [];
      } catch { return []; }
    }

    async function pick(project) {
      let versions = [];
      try { versions = await versionsOf(project); } catch { /* reported below */ }

      if (project.type === 'modpack') {
        // The modpack picker already knows how to choose a version and whether
        // to build an instance or a server.
        if (!versions.length) {
          return uiAlert("That modpack has no downloadable versions.", 'Nothing to install');
        }
        close();
        window.ModpackInstall.open({
          title: project.title, id: project.id, icon_url: project.icon, source: project.source,
        }, versions);
        return;
      }

      // A mod: the creator should only offer what this mod actually has builds
      // for, so collect EVERY version and loader it supports, not just the
      // newest — picking anything outside that set makes an instance the mod
      // cannot run in.
      if (!versions.length) {
        close();
        return uiAlert('That mod has no published versions to build an instance around.', 'Nothing to install');
      }
      const supportedVersions = new Set();
      const supportedLoaders = new Set();
      for (const v of versions) {
        (v.game_versions || []).forEach(g => supportedVersions.add(g));
        (v.loaders || []).forEach(l => supportedLoaders.add(String(l).toLowerCase()));
      }
      // Default to the newest build's newest game version and first loader.
      const newest = versions[0];
      const gameVersion = (newest.game_versions || []).slice(-1)[0] || null;
      const loader = (newest.loaders || [])[0] || 'vanilla';
      close();
      opts.onCustom && opts.onCustom({
        name: project.title,
        icon: project.icon || null,
        version: gameVersion,
        loader,
        // Which site the mod comes from decides how it gets installed into the
        // instance once that instance exists.
        source: project.source,
        projectId: project.source === 'modrinth' ? project.id : null,
        curseId: project.source === 'curseforge' ? project.id : null,
        projectTitle: project.title,
        supportedVersions: [...supportedVersions],
        supportedLoaders: [...supportedLoaders],
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
      // Every step below can come back here.
      const reopen = () => window.NewInstance.choose(opts);
      const { list, close } = shell(
        server ? 'New server' : 'New instance',
        server
          ? 'Start from a modpack, or set the server up yourself.'
          : 'Start from a modpack or a mod, a pack file you already have, or another launcher — or set it all up yourself.'
      );

      row(list, {
        icon: 'travel_explore',
        title: 'A modpack or a mod',
        desc: 'Search Modrinth and CurseForge: install a modpack, or set an instance up for a single mod.',
        onClick: () => { close(); openSearch({ ...opts, onBack: reopen }); },
      });
      row(list, {
        icon: 'folder_zip',
        title: 'A modpack file',
        desc: 'A .mrpack or a CurseForge .zip you already have.',
        onClick: () => { close(); opts.onImportFile && opts.onImportFile(reopen); },
      });
      if (!server) {
        row(list, {
          icon: 'move_to_inbox',
          title: 'From another launcher',
          desc: 'Copy an instance out of Prism, MultiMC, CurseForge, the Modrinth App, Lunar Client or the vanilla launcher.',
          onClick: () => {
            close();
            // One instance, picked by clicking it — not the bulk importer from
            // Settings. You came here to make ONE instance.
            if (!window.Onboarding) return;
            window.Onboarding.openImport(null, {
              single: true,
              onBack: reopen,
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
        // Which version, then which loader, then the creator with both filled
        // in. Going straight to the creator meant the first thing anybody saw
        // of a hand-built instance was a form with two dropdowns on it.
        onClick: () => {
          close();
          pickVersion({
            onBack: reopen,
            onPick: (version) => pickLoader({
              version,
              onBack: () => window.NewInstance.choose(opts),
              onPick: (loader) => {
                window.NewInstance.closeAll();
                opts.onCustom && opts.onCustom({ version, loader }, reopen);
              },
            }),
          });
        },
      });
    },
    pickVersion,
    pickLoader,
    closeAll() { if (openShell && openShell.isConnected) openShell.remove(); openShell = null; },
  };

  // ── Picking a version ─────────────────────────────────────────────────────
  // A card per release: the wiki's banner for that version behind it, that
  // version's own rendered icon on top. Both are already cached by the main
  // process, so the second visit costs nothing.
  //
  // Snapshots are not cards. There are thousands of them, almost none has a
  // banner, and nobody browses them — so they live behind a button next to
  // Continue, as a plain list.
  async function pickVersion(opts, preselect) {
    opts = opts || {};
    const { card, list } = shell(
      'Which Minecraft version?',
      'Releases, newest first. Snapshots are behind the button at the bottom.',
      { onBack: opts.onBack }
    );
    list.className = 'ni-cards';

    const actions = card.querySelector('.ni-actions');
    const snapBtn = document.createElement('button');
    snapBtn.textContent = 'Select a snapshot…';
    // Bottom left, beside Continue but outside the cards, so it does not
    // scroll away with them.
    snapBtn.style.marginRight = 'auto';
    const goBtn = document.createElement('button');
    goBtn.textContent = 'Continue';
    goBtn.className = 'primary';
    goBtn.style.background = 'var(--base-color)';
    goBtn.disabled = true;
    actions.prepend(snapBtn);
    actions.appendChild(goBtn);

    // A snapshot chosen from the list comes back here as the selection, so
    // Continue means the same thing whichever way the version was picked.
    let chosen = preselect || null;
    const choose = (version, tile) => {
      chosen = version;
      list.querySelectorAll('.ni-tile.sel').forEach(t => t.classList.remove('sel'));
      if (tile) tile.classList.add('sel');
      goBtn.disabled = !chosen;
      goBtn.textContent = chosen ? `Continue with ${chosen}` : 'Continue';
    };
    if (chosen) choose(chosen, null);
    goBtn.onclick = () => { if (chosen) opts.onPick && opts.onPick(chosen); };

    list.innerHTML = '<div class="ni-empty">Loading versions…</div>';
    let data = { releases: [], snapshots: [], latest: {}, next: null };
    try { data = await ipcRenderer.invoke('icon:pickerVersions') || data; } catch { /* below */ }
    if (!list.isConnected) return;
    if (!data.releases.length) {
      list.innerHTML = '<div class="ni-empty">Could not reach Mojang for the version list.</div>';
      return;
    }
    list.innerHTML = '';

    // The snapshot card. Its icon is the newest version the icon list names —
    // which is usually the release these snapshots are building up to, and is
    // in the list before that release exists — and its banner is the newest
    // snapshot's own.
    const latestSnapshot = (data.latest && data.latest.snapshot) || (data.snapshots[0] && data.snapshots[0].id);
    if (latestSnapshot) {
      const tile = makeTile({
        name: 'Latest snapshot', sub: latestSnapshot, wide: true,
        iconVersion: data.next || latestSnapshot, bannerVersion: latestSnapshot,
      });
      tile.onclick = () => choose(latestSnapshot, tile);
      list.appendChild(tile);
    }

    for (const r of data.releases) {
      const tile = makeTile({ name: r.id, sub: whenShort(r.at), iconVersion: r.id, bannerVersion: r.id });
      tile.onclick = () => choose(r.id, tile);
      list.appendChild(tile);
    }

    // A plain list, because a snapshot has no banner and no icon of its own
    // and a grid of identical grey cards would be worse than a list.
    snapBtn.onclick = () => {
      const picked = chosen;
      pickFromList({
        title: 'Which snapshot?',
        sub: 'Every snapshot, pre-release and release candidate, newest first.',
        items: data.snapshots.map(s => ({ id: s.id, meta: whenShort(s.at) })),
        selected: picked,
        onBack: () => pickVersion(opts, picked),
        onPick: (id) => pickVersion(opts, id),
      });
    };

    // The card for a chosen snapshot: it has none of its own, so the snapshot
    // card stands in for it and carries its name.
    if (chosen && !data.releases.some(r => r.id === chosen)) {
      const first = list.querySelector('.ni-tile');
      if (first) {
        first.classList.add('sel');
        const s = first.querySelector('.s');
        if (s) s.textContent = chosen;
      }
    } else if (chosen) {
      for (const t of list.querySelectorAll('.ni-tile')) {
        const n = t.querySelector('.n');
        if (n && n.textContent === chosen) { t.classList.add('sel'); break; }
      }
    }
  }

  const whenShort = (ms) => {
    if (!ms) return '';
    try { return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short' }); }
    catch { return ''; }
  };

  // One card. The banner and the icon both arrive later and fade in, because
  // either may need the network the first time and neither should hold the
  // screen up.
  function makeTile({ name, sub, iconVersion, bannerVersion, icon, banner, wide }) {
    const tile = document.createElement('div');
    tile.className = 'ni-tile' + (wide ? ' wide' : '');
    const bg = document.createElement('div');
    bg.className = 'bg';
    const veil = document.createElement('div');
    veil.className = 'veil';
    const inner = document.createElement('div');
    inner.className = 'inner';
    const img = document.createElement('img');
    img.alt = '';
    const n = document.createElement('div');
    n.className = 'n';
    n.textContent = name;
    inner.appendChild(img);
    inner.appendChild(n);
    if (sub) {
      const s = document.createElement('div');
      s.className = 's';
      s.textContent = sub;
      inner.appendChild(s);
    }
    tile.append(bg, veil, inner);

    const showBanner = (url) => { if (url) { bg.style.backgroundImage = `url("${url}")`; bg.classList.add('on'); } };
    if (banner) showBanner(banner);
    if (icon) img.src = icon;

    // Only once it is actually on screen: a hundred releases is a hundred
    // banners and a hundred renders, and nobody scrolls to 1.0.
    if (iconVersion || bannerVersion) {
      const io = new IntersectionObserver((es) => {
        if (!es.some(e => e.isIntersecting)) return;
        io.disconnect();
        if (bannerVersion) {
          ipcRenderer.invoke('icon:versionBanner', { version: bannerVersion })
            .then(b => showBanner(b && (b.dataUrl || b.url)))
            .catch(() => { });
        }
        if (iconVersion && window.VersionIcon) {
          window.VersionIcon.get(iconVersion).then(u => { if (u) img.src = u; }).catch(() => { });
        }
      }, { rootMargin: '200px' });
      io.observe(tile);
    }
    return tile;
  }

  // A plain scrolling list with a Use button — the snapshots, and anything
  // else that has nothing to show for itself.
  function pickFromList({ title, sub, items, selected, onBack, onPick }) {
    const { card, list, close } = shell(title, sub, { onBack });
    list.className = 'ni-plainlist';
    const input = document.createElement('input');
    input.className = 'ni-search';
    input.type = 'text';
    input.placeholder = 'Search';
    card.querySelector('.ni-sub').after(input);

    const actions = card.querySelector('.ni-actions');
    const goBtn = document.createElement('button');
    goBtn.textContent = 'Use this';
    goBtn.style.background = 'var(--base-color)';
    goBtn.disabled = true;
    actions.appendChild(goBtn);

    let chosen = selected || null;
    const paint = () => {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = items.filter(i => !q || i.id.toLowerCase().includes(q));
      if (!shown.length) {
        list.innerHTML = '<div class="ni-empty" style="padding:14px;">Nothing matches that.</div>';
        return;
      }
      for (const it of shown.slice(0, 600)) {
        const r = document.createElement('div');
        r.className = 'ni-plain' + (chosen === it.id ? ' sel' : '');
        const a = document.createElement('div');
        a.textContent = it.id;
        const b = document.createElement('div');
        b.className = 'm';
        b.textContent = it.meta || '';
        r.append(a, b);
        r.onclick = () => { chosen = it.id; goBtn.disabled = false; paint(); };
        list.appendChild(r);
      }
    };
    goBtn.disabled = !chosen;
    input.oninput = paint;
    paint();
    goBtn.onclick = () => { if (chosen) { close(); onPick && onPick(chosen); } };
  }

  // ── Picking a loader ──────────────────────────────────────────────────────
  // The same cards, but a loader has a logo rather than a banner. The card's
  // background is that logo's own edge pixels pulled out across it, so each
  // one is in its own colours without a wide image existing for it.
  const LOADERS = [
    { id: 'vanilla', name: 'Vanilla', sub: 'No mods', icon: 'assets/icons/Java_Edition_icon.png' },
    { id: 'fabric', name: 'Fabric', sub: 'Light and quick to update', icon: 'assets/loaders/fabric.png' },
    { id: 'neoforge', name: 'NeoForge', sub: 'Forge, carried on', icon: 'assets/loaders/neoforge.png' },
    { id: 'forge', name: 'Forge', sub: 'The old standard', icon: 'assets/loaders/forge.png' },
    { id: 'quilt', name: 'Quilt', sub: 'A fork of Fabric', icon: 'assets/loaders/quilt.png' },
  ];

  function pickLoader(opts) {
    opts = opts || {};
    const { card, list } = shell(
      'Which mod loader?',
      opts.version ? `For Minecraft ${opts.version}.` : 'Pick what the instance runs its mods with.',
      { onBack: opts.onBack }
    );
    list.className = 'ni-cards';

    const goBtn = document.createElement('button');
    goBtn.textContent = 'Continue';
    goBtn.style.background = 'var(--base-color)';
    goBtn.disabled = true;
    card.querySelector('.ni-actions').appendChild(goBtn);

    let chosen = null;
    goBtn.onclick = () => { if (chosen) opts.onPick && opts.onPick(chosen); };

    for (const l of LOADERS) {
      const tile = makeTile({ name: l.name, sub: l.sub, icon: l.icon });
      tile.onclick = () => {
        chosen = l.id;
        list.querySelectorAll('.ni-tile.sel').forEach(t => t.classList.remove('sel'));
        tile.classList.add('sel');
        goBtn.disabled = false;
        goBtn.textContent = `Continue with ${l.name}`;
      };
      list.appendChild(tile);
      edgeBanner(l.icon).then(url => {
        if (!url) return;
        const bg = tile.querySelector('.bg');
        bg.style.backgroundImage = `url("${url}")`;
        bg.classList.add('on');
      }).catch(() => { });
    }
  }

  // A wide background made out of a square logo: the logo scaled to the card's
  // height in the middle, and its leftmost and rightmost columns of pixels
  // stretched out to either side. Where those columns are transparent — which
  // for a logo on a clear background they usually are — they sit over the
  // logo's own average colour, so the card still comes out in its colours.
  const _edgeBanners = new Map();
  function edgeBanner(src, w = 320, h = 128) {
    if (_edgeBanners.has(src)) return _edgeBanners.get(src);
    const p = new Promise((res) => {
      const im = new Image();
      im.onload = () => {
        try {
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const cx = cv.getContext('2d');

          // The average of everything solid in the logo, as the base.
          const probe = document.createElement('canvas');
          probe.width = probe.height = 32;
          const pcx = probe.getContext('2d');
          pcx.drawImage(im, 0, 0, 32, 32);
          const d = pcx.getImageData(0, 0, 32, 32).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < 128) continue;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
          cx.fillStyle = n ? `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})` : '#333';
          cx.fillRect(0, 0, w, h);

          const side = Math.min(im.naturalWidth, im.naturalHeight) || 1;
          const scale = h / side;
          const dw = im.naturalWidth * scale;
          const x0 = (w - dw) / 2;
          // The edge columns, stretched out to the sides.
          cx.imageSmoothingEnabled = true;
          if (x0 > 0) {
            cx.drawImage(im, 0, 0, 1, im.naturalHeight, 0, 0, x0, h);
            cx.drawImage(im, im.naturalWidth - 1, 0, 1, im.naturalHeight, x0 + dw, 0, w - x0 - dw, h);
          }
          // The logo itself goes in the middle softened and faint: the card
          // already shows it crisply as its icon, and two copies of it on top
          // of each other is a mess.
          cx.save();
          cx.globalAlpha = 0.4;
          try { cx.filter = 'blur(6px)'; } catch { /* older engines */ }
          cx.drawImage(im, x0, 0, dw, h);
          cx.restore();
          res(cv.toDataURL('image/png'));
        } catch { res(null); }
      };
      im.onerror = () => res(null);
      im.src = src;
    });
    _edgeBanners.set(src, p);
    return p;
  }
})();
