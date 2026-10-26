// The home page, made of segments.
//
// The page used to be a fixed greeting, a "Continue Playing" list and two
// hard-coded Modrinth rows. Now it draws whatever the layout says, and the
// layout is edited from the page itself — so what is on the home page is the
// user's business rather than the markup's.
//
// A segment is a type and its own settings. The main process holds both the
// layout and the list of types (HOME_TYPES), and the editor's controls are
// built from that list: a new kind of segment is described once in the main
// process and drawn once here, and the editor picks it up without being told
// about it.
(function () {
  const { ipcRenderer, shell } = require('electron');

  let LAYOUT = [];
  let TYPES = [];
  let COLUMNS = 12;
  let editing = false;
  let profilesCache = [];
  // Every timer and 3D viewer a drawn segment owns, so redrawing the page
  // does not leave a clock ticking into a removed element or a render holding
  // a frame loop on a canvas that has gone.
  let cleanups = [];

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const typeSpec = (type) => TYPES.find(t => t.type === type) || { options: [] };

  function ensureStyle() {
    if (document.getElementById('home-style')) return;
    const s = document.createElement('style');
    s.id = 'home-style';
    s.textContent = `
      /* ── the grid ──
         The page was a single column: segments could only be moved up and
         down, nothing could sit beside anything else, and nothing could be
         made bigger or smaller. It is twelve columns now; each segment says
         how many it spans and, optionally, how tall it is.

         A min-width of 0 on the segments is what stops them being cropped off
         the right at small window sizes -- a grid item's default minimum is
         the width of its contents, so a row of cards refused to narrow and
         simply overflowed instead. */
      #home-segments { display:grid; grid-template-columns:repeat(var(--home-cols, 12), minmax(0, 1fr));
        gap:22px; align-content:start; padding:14px 2px 40px; }
      .hs { position:relative; min-width:0; grid-column:span var(--w, 12); display:flex; flex-direction:column; }
      .hs[data-h] { overflow:hidden; }
      .hs > h2, .hs > h3 { margin:0 0 10px; }
      .hs-body { min-height:0; flex:1; overflow:auto; }
      .hs-empty { opacity:0.6; font-size:13px; }
      .hs-error { opacity:0.7; font-size:12px; }

      /* Narrow windows: the spans collapse rather than the contents being cut
         off. Anything narrow becomes half-width, then everything goes full. */
      @media (max-width: 1150px) { .hs { grid-column:span max(var(--w, 12), 6); } }
      @media (max-width: 820px)  { .hs { grid-column:span 12; } }

      /* A row of project cards, which scrolls sideways rather than wrapping
         into a block that pushes everything else off the page. */
      .hs-row { display:flex; gap:12px; overflow-x:auto; padding-bottom:6px; }
      .hs-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:12px; }
      .hs-grid .hs-card, .hs-grid .hs-tile { flex:none; }
      .hs-card { flex:0 0 170px; background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); padding:10px; cursor:pointer; display:flex; flex-direction:column;
        min-width:0; }
      .hs-card:hover { border-color:var(--base-color); }
      /* Every icon the same size, whatever shape the file is. cover cropped
         non-square art to different-looking sizes; a fixed square box with
         the picture fitted inside it means they all match. */
      .hs-card .ic { width:100%; aspect-ratio:1; border-radius:6px; background:var(--very-dark);
        display:flex; align-items:center; justify-content:center; overflow:hidden; flex:0 0 auto; }
      .hs-card .ic img { width:100%; height:100%; object-fit:contain; image-rendering:auto; display:block; }
      .hs-card .t { font-weight:bold; font-size:13px; margin-top:8px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hs-card .d { font-size:11px; opacity:0.7; margin-top:2px;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .hs-card .go { margin-top:8px; display:flex; gap:6px; }
      .hs-card .go button { flex:1; padding:5px 6px; font-size:11px; }
      .hs-big { font-variant-numeric:tabular-nums; line-height:1.1; font-weight:bold; }
      .hs-sub { font-size:12px; opacity:0.7; margin-top:4px; }
      .hs-media { width:100%; border-radius:var(--border-radius); background:var(--very-dark); display:block; }
      .hs-list { display:flex; flex-direction:column; gap:6px; }
      .hs-item { display:flex; align-items:center; gap:10px; background:var(--menu-bg);
        border:1px solid var(--border-dark); border-radius:var(--border-radius); padding:8px 10px; min-width:0; }
      .hs-item img { width:32px; height:32px; border-radius:4px; image-rendering:pixelated;
        background:var(--very-dark); object-fit:contain; flex:0 0 auto; }
      .hs-item .t { font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hs-item .s { font-size:11px; opacity:0.7; flex:0 0 auto; }
      .hs-item .go { flex:0 0 auto; display:flex; gap:4px; }
      .hs-item .go button { padding:3px 7px; font-size:12px; line-height:1.2; }
      .hs-dot { width:8px; height:8px; border-radius:50%; background:#777; flex:0 0 auto; }
      .hs-dot.on { background:#5ad65a; }
      .hs-news { background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); overflow:hidden; }
      .hs-news .bd { padding:10px 12px; }
      .hs-news img { width:100%; height:120px; object-fit:cover; display:block; background:var(--very-dark); }
      .hs-news h4 { margin:0 0 4px; font-size:13px; }
      .hs-news pre { margin:0; font-size:11.5px; line-height:1.5; white-space:pre-wrap;
        max-height:120px; overflow:hidden; opacity:0.85; font-family:inherit; }
      .hs-news .tag { font-size:10px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6; }
      .hs-player { display:flex; justify-content:center; }
      .hs-player.left { justify-content:flex-start; }
      .hs-player.right { justify-content:flex-end; }
      .hs-greet { margin:0; font-weight:bold; line-height:1.2; }

      /* ── editing ── */
      /* Bottom RIGHT, and the icon alone. */
      #home-edit { position:fixed; right:18px; bottom:16px; z-index:30; display:flex; gap:8px; align-items:center; }
      #home-edit button { padding:7px 12px; }
      #home-edit button.icon-only { width:40px; height:40px; padding:0; border-radius:50%;
        display:flex; align-items:center; justify-content:center; }
      #home-edit button.icon-only i { font-size:19px; }
      body.home-editing .hs { outline:2px dashed color-mix(in srgb, var(--base-color) 70%, transparent);
        outline-offset:6px; border-radius:var(--border-radius); }
      body.home-editing .hs-card, body.home-editing .hs-item, body.home-editing .hs-news { pointer-events:none; }
      /* Inside the segment, not above it: at -10px the first row's buttons
         were clipped by the top of the scroller. */
      .hs-tools { position:absolute; top:4px; right:4px; display:none; gap:4px; z-index:6; }
      body.home-editing .hs-tools { display:flex; }
      .hs-tools button { padding:2px 6px; line-height:1; font-size:12px;
        background:var(--very-dark); border:1px solid var(--border-dark); }
      .hs-tools button.grab { cursor:grab; }
      .hs.dragging { opacity:0.45; }
      .hs-drop { outline:2px solid var(--base-color) !important; }
      /* Held over another segment: it will go BESIDE that one. */
      .hs-beside { outline:3px solid #5ad65a !important; }
      .hs-beside::after { content:"beside"; position:absolute; top:4px; left:4px; z-index:7;
        font-size:10px; text-transform:uppercase; letter-spacing:0.06em;
        background:#5ad65a; color:#06290b; padding:2px 6px; border-radius:4px; }

      /* A handle in each corner. The two bottom ones change the height as
         well, the top ones only the width. */
      .hs-grip { position:absolute; width:14px; height:14px; z-index:6; display:none; }
      body.home-editing .hs-grip { display:block; }
      .hs-grip::before { content:""; position:absolute; inset:3px; border-radius:2px;
        background:var(--base-color); opacity:0.85; }
      .hs-grip.nw { left:-7px; top:-7px; cursor:nwse-resize; }
      .hs-grip.ne { right:-7px; top:-7px; cursor:nesw-resize; }
      .hs-grip.sw { left:-7px; bottom:-7px; cursor:nesw-resize; }
      .hs-grip.se { right:-7px; bottom:-7px; cursor:nwse-resize; }
      .hs-size { position:absolute; left:50%; top:-12px; transform:translateX(-50%); z-index:7;
        font-size:11px; background:var(--base-color); color:#fff; padding:1px 7px;
        border-radius:4px; display:none; white-space:nowrap; }
      .hs.sizing .hs-size { display:block; }

      /* ── the segment picker ──
         It was a wall of icons and paragraphs. Now it is tiles: the icon, the
         name, and the explanation only when you hover one. */
      .he-search { width:100%; box-sizing:border-box; margin-bottom:12px; }
      .he-types { display:grid; grid-template-columns:repeat(auto-fill,minmax(118px,1fr)); gap:10px; }
      .he-type { display:flex; flex-direction:column; align-items:center; justify-content:center;
        gap:8px; text-align:center; padding:16px 8px; min-height:96px;
        border:2px solid var(--border-dark); background:var(--menu-bg);
        border-radius:var(--border-radius); cursor:pointer; transition:var(--smooth-transition); }
      .he-type:hover { border-color:var(--base-color); transform:translateY(-2px); }
      .he-type i { font-size:26px; opacity:0.9; }
      .he-type .n { font-weight:bold; font-size:12px; line-height:1.3; }
      .he-about { min-height:34px; margin-top:12px; font-size:12px; opacity:0.75; line-height:1.5; }
      .he-opt { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
      .he-opt label { font-size:12px; opacity:0.8; }
      .he-opt input[type="text"], .he-opt input[type="number"], .he-opt select { width:100%; box-sizing:border-box; }
      .he-opt.row { flex-direction:row; align-items:center; gap:8px; }
      .he-opt.row input { width:auto; margin:0; }
      .he-size { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end;
        border-top:1px solid var(--border-dark); margin-top:4px; padding-top:12px; }
      .he-size .he-opt { flex:1 1 150px; margin-bottom:0; }
      .he-media { display:flex; gap:8px; align-items:center; }
      .he-media input { flex:1; }
    `;
    document.head.appendChild(s);
  }

  // ── drawing a segment ──────────────────────────────────────────────────────

  const titleOf = (seg, node) => {
    const t = String(seg.title || '').trim();
    if (t) node.appendChild(el('h2', '', t));
  };

  // Opening a project's page, the way the mod browser hands it over.
  function openProject(p) {
    localStorage.setItem('selectedModrinthProject', JSON.stringify({
      project_id: p.id, slug: p.slug, title: p.title, description: p.description,
      icon_url: p.icon, author: p.author, downloads: p.downloads,
    }));
    localStorage.setItem('selectedProjectType', p.kind || 'mod');
    window.location.href = p.provider === 'curseforge' ? 'curseforge_project.html' : 'modrinth_project.html';
  }

  // "Play" on a modpack or a mod means: put it somewhere you can play it.
  //
  // The button the featured rows used to have did nothing useful -- it is
  // meant to make an instance from the thing when you have not got one
  // already, and to open the one you have when you do.
  async function installProject(p) {
    let existing = null;
    try {
      const r = await ipcRenderer.invoke('instance-for-project',
        { id: p.id, slug: p.slug, title: p.title, provider: p.provider });
      existing = r && r.profileId ? r.profileId : null;
    } catch { /* ask the project page instead */ }
    if (existing) { window.location.href = `instances.html?i=${encodeURIComponent(existing)}`; return; }
    // Nothing for it yet, so the project's own page opens with the install
    // flow ready -- that is where making an instance from it lives.
    localStorage.setItem('installIntent', '1');
    openProject(p);
  }

  function projectCard(p, seg) {
    const action = (seg && seg.action) || 'both';
    const card = el('div', 'hs-card');
    const box = el('div', 'ic');
    const img = el('img');
    img.src = p.icon || (window.DEFAULT_ICON || '');
    img.alt = '';
    img.onerror = () => { img.src = window.DEFAULT_ICON || ''; };
    box.appendChild(img);
    card.appendChild(box);
    card.appendChild(el('div', 't', p.title || ''));
    if (action === 'info' || action === 'both') {
      const bits = [];
      if (p.author) bits.push('by ' + p.author);
      if (p.downloads) bits.push(fmtCount(p.downloads) + ' downloads');
      card.appendChild(el('div', 'd', bits.join(' · ')));
    } else {
      card.appendChild(el('div', 'd', p.description || ''));
    }
    if (action === 'play' || action === 'both') {
      const go = el('div', 'go');
      const play = el('button', 'primary');
      play.innerHTML = '<i class="material-icons" style="font-size:13px;vertical-align:middle;">play_arrow</i> Play';
      play.onclick = (e) => { e.stopPropagation(); installProject(p); };
      go.appendChild(play);
      card.appendChild(go);
    }
    card.onclick = () => openProject(p);
    return card;
  }

  const fmtCount = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
    return String(v);
  };

  // Playtime as somebody would say it: "4h 20m", "3 days, 2h".
  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(Number(ms) || 0) / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const mins = Math.floor((total % 3600) / 60);
    if (days) return `${days} day${days === 1 ? '' : 's'}, ${hours}h`;
    if (hours) return `${hours}h ${mins}m`;
    if (mins) return `${mins}m`;
    return `${Math.floor(total)}s`;
  }

  // The greeting, which used to be an <h1> in the markup and so was the one
  // thing on the home page that could not be moved, reworded or removed.
  const GREETINGS = [
    'Hello there!',
    'Greetings, human.',
    'Back for more? Are ya ready?',
    'Systems online.',
    'Ready for action?',
    "What's on the menu today?",
    'Did you bring snacks?',
    "Let's get rolling!",
    'Welcome back, commander!',
    'The redstone awaits your command!',
  ];

  const DRAW = {
    greeting(seg, node) {
      const said = String(seg.text || '').trim()
        || (window.__homeGreeting || (window.__homeGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]));
      const h = el('h1', 'hs-greet', said);
      h.style.fontSize = (Number(seg.size) || 32) + 'px';
      h.style.textAlign = seg.align || 'left';
      node.appendChild(h);
    },

    recent(seg, node) {
      titleOf(seg, node);
      const grid = (seg.view || 'list') === 'grid';
      const box = el('div', grid ? 'hs-grid' : 'hs-list');
      node.appendChild(box);
      const action = seg.action || 'both';
      const open = (p) => { window.location.href = `instances.html?i=${encodeURIComponent(p.id)}`; };
      const play = async (p) => {
        const who = await ipcRenderer.invoke('get-selected-player');
        if (who == null) { window.location.href = 'players.html'; return; }
        ipcRenderer.send('launch-profile', { profileId: p.id, playerId: who });
        open(p);
      };
      const paint = () => {
        box.innerHTML = '';
        const items = (profilesCache || []).slice(0, Number(seg.count) || 6);
        if (!items.length) {
          const add = el('div', grid ? 'hs-card' : 'hs-item');
          add.appendChild(el('div', 't', 'Make an instance'));
          add.style.cursor = 'pointer';
          add.onclick = () => { window.location.href = 'instances.html?i=NEWINSTANCE'; };
          box.appendChild(add);
          return;
        }
        for (const p of items) {
          if (grid) {
            const card = el('div', 'hs-card');
            const ic = el('div', 'ic');
            const img = el('img');
            if (window.instanceIconInto) window.instanceIconInto(img, p);
            else img.src = window.DEFAULT_ICON || '';
            img.style.imageRendering = 'pixelated';
            ic.appendChild(img);
            card.append(ic, el('div', 't', p.name || ''));
            if (action === 'info' || action === 'both') {
              card.appendChild(el('div', 'd', `${p.version || ''}${p.loader ? ' · ' + p.loader : ''}`));
            }
            if (action === 'play' || action === 'both') {
              const go = el('div', 'go');
              const b = el('button', 'primary');
              b.innerHTML = '<i class="material-icons" style="font-size:13px;vertical-align:middle;">play_arrow</i> Play';
              b.onclick = (e) => { e.stopPropagation(); play(p); };
              go.appendChild(b);
              card.appendChild(go);
            }
            card.style.cursor = 'pointer';
            card.onclick = () => open(p);
            box.appendChild(card);
            continue;
          }
          const row = el('div', 'hs-item');
          row.style.cursor = 'pointer';
          const img = el('img');
          if (window.instanceIconInto) window.instanceIconInto(img, p);
          else img.src = window.DEFAULT_ICON || '';
          row.appendChild(img);
          row.appendChild(el('div', 't', p.name || ''));
          if (action === 'info' || action === 'both') {
            row.appendChild(el('div', 's', `${p.version || ''}${p.loader ? ' · ' + p.loader : ''}`));
          }
          if (action === 'play' || action === 'both') {
            // The play button this list used to have and lost.
            const go = el('div', 'go');
            const b = el('button', 'primary');
            b.title = 'Play';
            b.innerHTML = '<i class="material-icons" style="font-size:14px;vertical-align:middle;">play_arrow</i>';
            b.onclick = (e) => { e.stopPropagation(); play(p); };
            go.appendChild(b);
            row.appendChild(go);
          }
          row.onclick = () => open(p);
          box.appendChild(row);
        }
      };
      paint();
      node._repaint = paint;
    },

    async player(seg, node) {
      titleOf(seg, node);
      const box = el('div', 'hs-player ' + (seg.align || 'center'));
      box.style.flexDirection = 'column';
      box.style.alignItems = seg.align === 'left' ? 'flex-start'
        : seg.align === 'right' ? 'flex-end' : 'center';
      node.appendChild(box);
      const r = await ipcRenderer.invoke('pack:skinChoices');
      const account = r && r.account;
      if (!account) { node.appendChild(el('div', 'hs-empty', 'No account is signed in.')); return; }
      const canvas = el('canvas');
      box.appendChild(canvas);
      const skin = await ipcRenderer.invoke('head:skin', {
        uuid: account.uuid, name: account.name, offline: account.offline,
        playerId: account.offline ? account.id : null,
      });
      if (!skin || !skin.base64 || typeof skinview3d === 'undefined') {
        canvas.remove();
        const img = el('img');
        img.style.cssText = 'width:96px;height:96px;image-rendering:pixelated;border-radius:6px;';
        if (window.PlayerHead) window.PlayerHead.set(img, { uuid: account.uuid, name: account.name, size: 96 });
        box.appendChild(img);
        return;
      }
      const h = Math.max(120, Math.min(700, Number(seg.height) || 320));
      const v = new skinview3d.SkinViewer({ canvas, width: Math.round(h * 0.6), height: h });
      v.zoom = 0.9;
      v.autoRotate = !!seg.spin;
      // Whether it can be turned by hand. Some people want a picture, not a
      // toy that spins off-centre the moment the mouse crosses it.
      const movable = seg.movable !== false;
      try {
        v.controls.enabled = movable;
        v.controls.enableRotate = movable;
        v.controls.minPolarAngle = Math.PI / 2 - 0.55;
        v.controls.maxPolarAngle = Math.PI / 2 + 0.55;
        v.controls.enableZoom = false;
      } catch { /* an older bundle */ }
      canvas.style.cursor = movable ? 'grab' : 'default';
      await v.loadSkin('data:image/png;base64,' + skin.base64, { model: skin.slim ? 'slim' : 'default' });
      if (skin.capeUrl) { try { await v.loadCape(skin.capeUrl); } catch { /* no cape */ } }
      // What it is doing. skinview3d ships these; an unknown one or an older
      // bundle simply leaves it standing.
      const ANIM = {
        idle: 'IdleAnimation', walk: 'WalkingAnimation',
        run: 'RunningAnimation', fly: 'FlyingAnimation',
      };
      const want = ANIM[String(seg.animation || 'idle')];
      if (want && typeof skinview3d[want] === 'function') {
        try { v.animation = new skinview3d[want](); } catch { /* standing still it is */ }
      }
      cleanups.push(() => { try { v.dispose(); } catch { /* gone */ } });
      if (seg.showName !== false) box.appendChild(el('div', 'hs-sub', account.name || ''));
    },

    async friends(seg, node) {
      titleOf(seg, node);
      const id = await ipcRenderer.invoke('get-selected-player');
      if (id == null) { node.appendChild(el('div', 'hs-empty', 'Sign in to see your friends.')); return; }
      const loading = el('div', 'hs-empty', 'Loading friends…');
      node.appendChild(loading);
      const r = await ipcRenderer.invoke('friends:list', { accountId: id });
      loading.remove();
      if (!r || !r.success) {
        node.appendChild(el('div', 'hs-error', (r && r.error) || 'Your friends list could not be read.'));
        return;
      }
      let friends = r.friends || [];
      const presence = {};
      try {
        const pr = await ipcRenderer.invoke('friends:presence', { accountId: id });
        for (const [k, v] of Object.entries((pr && pr.presence) || {})) presence[k] = v;
      } catch { /* without it everybody simply shows as offline */ }
      const online = (f) => (presence[String(f.profileId || '').replace(/-/g, '')] || 'OFFLINE') !== 'OFFLINE';
      if (seg.onlineOnly) friends = friends.filter(online);
      friends.sort((a, b) => (online(b) ? 1 : 0) - (online(a) ? 1 : 0));
      if (!friends.length) {
        node.appendChild(el('div', 'hs-empty', seg.onlineOnly ? 'Nobody is online.' : 'No friends yet.'));
        return;
      }
      const list = el('div', 'hs-list');
      for (const f of friends.slice(0, Number(seg.count) || 8)) {
        const row = el('div', 'hs-item');
        const img = el('img');
        if (window.PlayerHead) window.PlayerHead.set(img, { uuid: f.profileId, name: f.name, size: 32 });
        row.appendChild(img);
        row.appendChild(el('div', 't', f.name || ''));
        const dot = el('div', 'hs-dot' + (online(f) ? ' on' : ''));
        row.appendChild(dot);
        list.appendChild(row);
      }
      node.appendChild(list);
    },

    async projects(seg, node) {
      titleOf(seg, node);
      const view = seg.view || 'row';
      const row = el('div', view === 'grid' ? 'hs-grid' : view === 'list' ? 'hs-list' : 'hs-row');
      node.appendChild(row);
      row.appendChild(el('div', 'hs-empty', 'Looking…'));
      const r = await ipcRenderer.invoke('home:projects', {
        provider: seg.provider, kind: seg.kind, sort: seg.sort, count: seg.count,
        query: seg.query, gameVersion: seg.gameVersion, loader: seg.loader, categories: seg.categories,
      });
      row.innerHTML = '';
      if (!r || !r.success) {
        row.appendChild(el('div', 'hs-error', (r && r.error) || 'Nothing could be fetched.'));
        return;
      }
      if (!r.hits.length) { row.appendChild(el('div', 'hs-empty', 'Nothing matched that.')); return; }
      if (view === 'list') {
        const action = seg.action || 'both';
        for (const p of r.hits) {
          const item = el('div', 'hs-item');
          item.style.cursor = 'pointer';
          const img = el('img');
          img.src = p.icon || (window.DEFAULT_ICON || '');
          img.style.imageRendering = 'auto';
          item.appendChild(img);
          item.appendChild(el('div', 't', p.title || ''));
          if (action === 'info' || action === 'both') {
            item.appendChild(el('div', 's', fmtCount(p.downloads) + ' downloads'));
          }
          if (action === 'play' || action === 'both') {
            const go = el('div', 'go');
            const b = el('button', 'primary');
            b.title = 'Play';
            b.innerHTML = '<i class="material-icons" style="font-size:14px;vertical-align:middle;">play_arrow</i>';
            b.onclick = (e) => { e.stopPropagation(); installProject(p); };
            go.appendChild(b);
            item.appendChild(go);
          }
          item.onclick = () => openProject(p);
          row.appendChild(item);
        }
        return;
      }
      for (const p of r.hits) row.appendChild(projectCard(p, seg));
    },

    async news(seg, node) {
      titleOf(seg, node);
      const r = await ipcRenderer.invoke('home:news', { count: seg.count });
      if (!r || !r.success) { node.appendChild(el('div', 'hs-error', (r && r.error) || 'The news could not be fetched.')); return; }
      if (!r.items.length) { node.appendChild(el('div', 'hs-empty', 'Nothing yet.')); return; }
      const list = el('div', 'hs-list');
      for (const n of r.items) {
        const box = el('div', 'hs-news');
        const head = el('h4', '', `${n.title}${n.prerelease ? ' (pre-release)' : ''}`);
        box.appendChild(head);
        if (n.at) box.appendChild(el('div', 'hs-sub', new Date(n.at).toLocaleDateString()));
        if (n.body) box.appendChild(el('pre', '', n.body));
        if (n.url) {
          box.style.cursor = 'pointer';
          box.onclick = () => { try { shell.openExternal(n.url); } catch { /* no browser */ } };
        }
        list.appendChild(box);
      }
      node.appendChild(list);
    },

    // One of Mojang's entries, as a card: their picture, what it is, and the
    // opening of what they wrote.
    async _mojang(seg, node, channel, args, emptyText) {
      const r = await ipcRenderer.invoke(channel, args);
      if (!r || !r.success) {
        node.appendChild(el('div', 'hs-error', (r && r.error) || emptyText));
        return;
      }
      if (!r.items.length) { node.appendChild(el('div', 'hs-empty', 'Nothing yet.')); return; }
      const list = el('div', 'hs-list');
      for (const n of r.items) {
        const box = el('div', 'hs-news');
        if (seg.images !== false && n.image) {
          const img = el('img');
          img.src = n.image;
          img.alt = '';
          img.onerror = () => img.remove();
          box.appendChild(img);
        }
        const bd = el('div', 'bd');
        if (n.tag || n.type) bd.appendChild(el('div', 'tag', n.tag || n.type));
        bd.appendChild(el('h4', '', n.title || n.id || ''));
        if (n.at) bd.appendChild(el('div', 'hs-sub', new Date(n.at).toLocaleDateString()));
        if (n.body) bd.appendChild(el('pre', '', n.body));
        box.appendChild(bd);
        if (n.url) {
          box.style.cursor = 'pointer';
          box.onclick = () => { try { shell.openExternal(n.url); } catch { /* no browser */ } };
        }
        list.appendChild(box);
      }
      node.appendChild(list);
    },

    // Mojang's written changelogs rather than a list of version numbers,
    // which is what this segment was and what made it useless: it said 25w14a
    // came out and nothing about what is in it.
    async snapshots(seg, node) {
      titleOf(seg, node);
      await DRAW._mojang(seg, node, 'home:patchnotes',
        { count: seg.count, releasesToo: seg.releasesToo },
        'The changelogs could not be fetched.');
    },

    async mcnews(seg, node) {
      titleOf(seg, node);
      await DRAW._mojang(seg, node, 'home:mcnews',
        { count: seg.count, category: seg.category },
        'The news could not be fetched.');
    },

    clock(seg, node) {
      titleOf(seg, node);
      const big = el('div', 'hs-big');
      big.style.fontSize = (Number(seg.size) || 44) + 'px';
      node.appendChild(big);
      const sub = el('div', 'hs-sub');
      node.appendChild(sub);
      const zone = String(seg.zone || '').trim() || undefined;
      const tick = () => {
        const now = new Date();
        try {
          big.textContent = now.toLocaleTimeString(undefined, {
            timeZone: zone, hour: '2-digit', minute: '2-digit',
            second: seg.seconds ? '2-digit' : undefined, hour12: !!seg.hour12,
          });
          sub.textContent = seg.showDate
            ? now.toLocaleDateString(undefined, { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long' })
              + (zone ? ' · ' + zone : '')
            : (zone || '');
        } catch {
          // An unknown time zone would otherwise throw every second.
          big.textContent = now.toLocaleTimeString();
          sub.textContent = `"${seg.zone}" is not a time zone`;
        }
      };
      tick();
      const t = setInterval(tick, seg.seconds ? 1000 : 15000);
      cleanups.push(() => clearInterval(t));
    },

    countdown(seg, node) {
      const big = el('div', 'hs-big');
      big.style.fontSize = (Number(seg.size) || 36) + 'px';
      const label = el('div', 'hs-sub', seg.title || '');
      node.appendChild(big);
      node.appendChild(label);
      const target = Date.parse(String(seg.target || '').replace(' ', 'T'));
      if (!Number.isFinite(target)) {
        big.textContent = '—';
        label.textContent = seg.target ? `"${seg.target}" is not a date` : 'Set a date for this countdown.';
        return;
      }
      const tick = () => {
        const left = target - Date.now();
        if (left <= 0) { big.textContent = seg.afterText || "It's here"; return; }
        const s = Math.floor(left / 1000);
        const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60), ss = s % 60;
        big.textContent = d
          ? `${d}d ${h}h ${m}m`
          : `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      };
      tick();
      const t = setInterval(tick, 1000);
      cleanups.push(() => clearInterval(t));
    },

    async playtime(seg, node) {
      titleOf(seg, node);
      const one = String(seg.profileId || '').trim();
      const r = await ipcRenderer.invoke('playtime:get', one ? { profileId: one } : {});
      if (!r || !r.success) { node.appendChild(el('div', 'hs-error', 'Playtime could not be read.')); return; }
      const big = el('div', 'hs-big', fmtDuration(r.total));
      big.style.fontSize = '32px';
      node.appendChild(big);
      const sessions = r.sessions || 0;
      node.appendChild(el('div', 'hs-sub',
        one
          ? `${sessions} session${sessions === 1 ? '' : 's'}`
          : `across ${sessions} session${sessions === 1 ? '' : 's'}`));
      if (one || !seg.breakdown || !r.instances) return;
      const rows = Object.entries(r.instances)
        .map(([id, v]) => ({ id, ...v }))
        .sort((a, b) => (b.total || 0) - (a.total || 0))
        .slice(0, Number(seg.count) || 5);
      if (!rows.length) {
        node.appendChild(el('div', 'hs-empty', 'Nothing played yet.'));
        return;
      }
      const list = el('div', 'hs-list');
      list.style.marginTop = '10px';
      for (const row of rows) {
        const p = (profilesCache || []).find(x => String(x.id) === String(row.id));
        const item = el('div', 'hs-item');
        const img = el('img');
        if (p && window.instanceIconInto) window.instanceIconInto(img, p);
        item.appendChild(img);
        item.appendChild(el('div', 't', (p && p.name) || row.id));
        item.appendChild(el('div', 's', fmtDuration(row.total)));
        if (p) {
          item.style.cursor = 'pointer';
          item.onclick = () => { window.location.href = `instances.html?i=${encodeURIComponent(p.id)}`; };
        }
        list.appendChild(item);
      }
      node.appendChild(list);
    },

    media(seg, node) {
      titleOf(seg, node);
      const src = String(seg.src || '').trim();
      if (!src) { node.appendChild(el('div', 'hs-empty', 'Choose a picture or video for this segment.')); return; }
      const h = Math.max(60, Math.min(800, Number(seg.height) || 220));
      const video = /\.(mp4|webm|ogv|mov)(\?|$)/i.test(src);
      const m = el(video ? 'video' : 'img', 'hs-media');
      m.src = src;
      m.style.height = h + 'px';
      m.style.objectFit = seg.fit || 'cover';
      if (video) {
        m.autoplay = true;
        m.loop = seg.loop !== false;
        m.muted = seg.muted !== false;
        m.playsInline = true;
        m.controls = false;
      } else {
        m.alt = seg.caption || '';
      }
      node.appendChild(m);
      if (seg.caption) node.appendChild(el('div', 'hs-sub', seg.caption));
    },
  };

  // ── the page ───────────────────────────────────────────────────────────────

  function clearSegments() {
    for (const fn of cleanups) { try { fn(); } catch { /* going anyway */ } }
    cleanups = [];
  }

  function drawAll() {
    const host = document.getElementById('home-segments');
    if (!host) return;
    clearSegments();
    host.innerHTML = '';
    host.style.setProperty('--home-cols', String(COLUMNS));
    for (const seg of LAYOUT) {
      const node = el('section', 'hs');
      node.dataset.id = seg.id;
      // How wide, and how tall if a height was set. A segment with no height
      // is as tall as its contents, which is how the page has always been.
      node.style.setProperty('--w', String(seg.w || COLUMNS));
      if (seg.h) { node.style.height = seg.h + 'px'; node.dataset.h = String(seg.h); }
      host.appendChild(node);
      // Each type draws itself; an async one that fails must not take the
      // rest of the page down with it.
      try {
        const r = (DRAW[seg.type] || (() => { }))(seg, node);
        if (r && typeof r.catch === 'function') {
          r.catch((e) => {
            node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
          });
        }
      } catch (e) {
        node.appendChild(el('div', 'hs-error', 'This segment could not be drawn: ' + (e && e.message || e)));
      }
      if (editing) addTools(node, seg);
    }
  }

  // Recent instances are the one segment whose data arrives on its own, from
  // the profile list the page already listens for.
  function setProfiles(list) {
    profilesCache = Array.isArray(list) ? list : [];
    for (const node of document.querySelectorAll('#home-segments .hs')) {
      if (node._repaint) node._repaint();
    }
  }

  // ── editing ────────────────────────────────────────────────────────────────

  // ── moving a segment ────────────────────────────────────────────────────
  //
  // The up and down buttons are gone. Dragging is how the accounts page
  // reorders, and it is how this does now -- with one addition: hold a
  // segment over another for half a second and it goes BESIDE that one
  // instead of before it, the two of them splitting the row between them.
  // That is the only way to put two things side by side.
  const HOLD_MS = 500;
  let dragId = null;
  let hoverTimer = null;
  let besideId = null;

  function clearDropMarks() {
    for (const n of document.querySelectorAll('.hs-drop, .hs-beside')) {
      n.classList.remove('hs-drop', 'hs-beside');
    }
  }

  function addTools(node, seg) {
    const tools = el('div', 'hs-tools');
    const grab = el('button', 'grab', '⠿'); grab.title = 'Drag to move';
    const cog = el('button', '', '⚙'); cog.title = 'Settings';
    const rm = el('button', '', '✕'); rm.title = 'Remove';
    cog.onclick = () => editSegment(seg.id);
    rm.onclick = () => removeSegment(seg.id);
    tools.append(grab, cog, rm);
    node.appendChild(tools);

    // Only the handle starts a drag, so selecting text or pressing a button
    // inside the segment does not.
    node.draggable = false;
    grab.addEventListener('mousedown', () => { node.draggable = true; });
    node.addEventListener('dragend', () => {
      node.draggable = false;
      node.classList.remove('dragging');
      clearDropMarks();
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      dragId = null; besideId = null;
    });
    node.addEventListener('dragstart', (e) => {
      dragId = seg.id;
      besideId = null;
      node.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', seg.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* fine */ }
    });
    node.addEventListener('dragover', (e) => {
      if (!dragId || dragId === seg.id) return;
      e.preventDefault();
      if (node.classList.contains('hs-drop') || node.classList.contains('hs-beside')) return;
      clearDropMarks();
      node.classList.add('hs-drop');
      // Held here long enough: it will land beside this one rather than
      // before it.
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        besideId = seg.id;
        node.classList.remove('hs-drop');
        node.classList.add('hs-beside');
      }, HOLD_MS);
    });
    node.addEventListener('dragleave', () => {
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      if (besideId === seg.id) besideId = null;
      node.classList.remove('hs-drop', 'hs-beside');
    });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
      const from = dragId;
      const pairUp = besideId === seg.id;
      clearDropMarks();
      dragId = null; besideId = null;
      if (!from || from === seg.id) return;
      pairUp ? placeBeside(from, seg.id) : placeBefore(from, seg.id);
    });

    addGrips(node, seg);
  }

  function placeBefore(fromId, ontoId) {
    const i = LAYOUT.findIndex(s => s.id === fromId);
    if (i < 0) return;
    const [moved] = LAYOUT.splice(i, 1);
    const j = LAYOUT.findIndex(s => s.id === ontoId);
    LAYOUT.splice(j < 0 ? LAYOUT.length : j, 0, moved);
    save();
  }

  // Side by side: put it straight after the one it was held over and split
  // that row between the two, so they actually end up next to each other
  // rather than merely adjacent in the list and still a row each.
  function placeBeside(fromId, ontoId) {
    const i = LAYOUT.findIndex(s => s.id === fromId);
    if (i < 0) return;
    const [moved] = LAYOUT.splice(i, 1);
    const j = LAYOUT.findIndex(s => s.id === ontoId);
    if (j < 0) { LAYOUT.push(moved); save(); return; }
    const onto = LAYOUT[j];
    // Only share the row out when they would not fit as they are.
    if ((onto.w || COLUMNS) + (moved.w || COLUMNS) > COLUMNS) {
      onto.w = Math.floor(COLUMNS / 2);
      moved.w = COLUMNS - onto.w;
    }
    LAYOUT.splice(j + 1, 0, moved);
    save();
  }

  // ── resizing ────────────────────────────────────────────────────────────
  //
  // A handle in each corner. All four change the width; the bottom two change
  // the height as well, which is the corner people reach for. The width snaps
  // to the grid's columns, because that is what the layout is made of.
  function addGrips(node, seg) {
    const host = document.getElementById('home-segments');
    const readout = el('div', 'hs-size');
    node.appendChild(readout);

    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const grip = el('div', 'hs-grip ' + corner);
      node.appendChild(grip);
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const colW = (host.clientWidth + 22) / COLUMNS;   // the gap counts as part of a column
        const startX = e.clientX, startY = e.clientY;
        const startW = seg.w || COLUMNS;
        const startH = seg.h || node.offsetHeight;
        const east = corner === 'ne' || corner === 'se';
        const south = corner === 'sw' || corner === 'se';
        node.classList.add('sizing');

        const show = (w, h) => {
          readout.textContent = h ? `${w}/${COLUMNS} · ${Math.round(h)}px` : `${w}/${COLUMNS}`;
        };
        show(startW, seg.h);

        const onMove = (ev) => {
          const dx = (ev.clientX - startX) * (east ? 1 : -1);
          const w = Math.max(2, Math.min(COLUMNS, startW + Math.round(dx / colW)));
          seg.w = w;
          node.style.setProperty('--w', String(w));
          let h = seg.h;
          if (south) {
            const dy = ev.clientY - startY;
            h = Math.max(80, Math.min(1200, startH + dy));
            seg.h = h;
            node.style.height = h + 'px';
            node.dataset.h = String(h);
          }
          show(w, h);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          node.classList.remove('sizing');
          // Saving redraws, which is how the rest of the row reflows.
          save();
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    }
  }

  const save = async () => {
    const r = await ipcRenderer.invoke('home:setLayout', { layout: LAYOUT });
    if (r && r.layout) LAYOUT = r.layout;
    drawAll();
  };

  function removeSegment(id) {
    LAYOUT = LAYOUT.filter(s => s.id !== id);
    save();
  }

  function overlay(title, bodyBuilder, { wide = false } = {}) {
    const ov = el('div', 'modal-overlay active');
    ov.style.zIndex = 6000;
    const box = el('div', 'modal-content');
    box.style.maxWidth = wide ? '680px' : '460px';
    const head = el('div', 'modal-header');
    head.appendChild(el('h2', '', title));
    const x = el('button', 'modal-close', '✕');
    head.appendChild(x);
    box.appendChild(head);
    const body = el('div');
    box.appendChild(body);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => ov.remove();
    x.onclick = close;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    bodyBuilder(body, box, close);
    return ov;
  }

  // The picker was a wall of icons each with a paragraph beside it. Tiles
  // now: the icon and the name, with the explanation shown once for whichever
  // one you are pointing at, and a box to narrow them down.
  function addSegment() {
    overlay('Add a segment', (body, box, close) => {
      const search = el('input', 'he-search');
      search.type = 'text';
      search.placeholder = 'Search';
      body.appendChild(search);

      const grid = el('div', 'he-types');
      const about = el('div', 'he-about', 'Pick something to put on the page.');
      const tiles = [];
      for (const t of TYPES) {
        const b = el('button', 'he-type');
        b.type = 'button';
        b.innerHTML = `<i class="material-icons">${t.icon || 'widgets'}</i><span class="n"></span>`;
        b.querySelector('.n').textContent = t.name;
        b.title = t.about || '';
        const say = () => { about.textContent = t.about || t.name; };
        b.addEventListener('mouseenter', say);
        b.addEventListener('focus', say);
        b.onclick = () => {
          close();
          const seg = { id: `${t.type}-${Date.now().toString(36)}`, type: t.type, w: 12, h: 0 };
          for (const o of t.options || []) seg[o.id] = o.default;
          LAYOUT.push(seg);
          save().then(() => editSegment(seg.id));
        };
        tiles.push({ b, t });
        grid.appendChild(b);
      }
      search.oninput = () => {
        const q = search.value.trim().toLowerCase();
        for (const { b, t } of tiles) {
          const hit = !q || (t.name + ' ' + (t.about || '')).toLowerCase().includes(q);
          b.style.display = hit ? '' : 'none';
        }
      };
      body.append(grid, about);
      setTimeout(() => search.focus(), 0);
    }, { wide: true });
  }

  // The settings for one segment, built from the type's own option list -- so
  // a new option is declared once in the main process and turns up here.
  function editSegment(id) {
    const seg = LAYOUT.find(s => s.id === id);
    if (!seg) return;
    const spec = typeSpec(seg.type);
    overlay(spec.name || seg.type, (body, box, close) => {
      const values = { ...seg };
      for (const o of spec.options || []) {
        const wrap = el('div', 'he-opt' + (o.kind === 'toggle' ? ' row' : ''));
        if (o.kind === 'toggle') {
          const cb = el('input');
          cb.type = 'checkbox';
          cb.checked = !!values[o.id];
          cb.onchange = () => { values[o.id] = cb.checked; };
          wrap.append(cb, el('label', '', o.label));
        } else if (o.kind === 'choice') {
          wrap.appendChild(el('label', '', o.label));
          const sel = el('select');
          for (const c of o.choices || []) {
            const op = el('option', '', c.label);
            op.value = c.value;
            if (String(values[o.id]) === String(c.value)) op.selected = true;
            sel.appendChild(op);
          }
          sel.onchange = () => { values[o.id] = sel.value; };
          wrap.appendChild(sel);
        } else if (o.kind === 'media') {
          wrap.appendChild(el('label', '', o.label));
          const row = el('div', 'he-media');
          const input = el('input');
          input.type = 'text';
          input.value = values[o.id] || '';
          input.placeholder = 'https://… or choose a file';
          input.oninput = () => { values[o.id] = input.value.trim(); };
          const pick = el('button', '', 'Choose…');
          pick.type = 'button';
          pick.onclick = async () => {
            const r = await ipcRenderer.invoke('home:pickMedia');
            if (!r || r.canceled) return;
            if (r.error) { if (window.notify) notify(r.error, 'error'); return; }
            input.value = r.url;
            values[o.id] = r.url;
          };
          row.append(input, pick);
          wrap.appendChild(row);
        } else {
          wrap.appendChild(el('label', '', o.label));
          const input = el('input');
          input.type = o.kind === 'number' ? 'number' : 'text';
          if (o.kind === 'number') {
            if (o.min != null) input.min = o.min;
            if (o.max != null) input.max = o.max;
          }
          input.value = values[o.id] == null ? '' : values[o.id];
          input.oninput = () => {
            values[o.id] = o.kind === 'number' ? (parseInt(input.value, 10) || o.default) : input.value;
          };
          wrap.appendChild(input);
        }
        body.appendChild(wrap);
      }
      // How big it is, which belongs to every type rather than to any one of
      // them -- so it is here rather than in each type's option list. The
      // corner handles write the same two numbers.
      const sizeRow = el('div', 'he-size');
      const wWrap = el('div', 'he-opt');
      wWrap.appendChild(el('label', '', `Width (of ${COLUMNS})`));
      const wIn = el('input');
      wIn.type = 'number'; wIn.min = 2; wIn.max = COLUMNS;
      wIn.value = String(values.w || COLUMNS);
      wIn.oninput = () => { values.w = Math.max(2, Math.min(COLUMNS, parseInt(wIn.value, 10) || COLUMNS)); };
      wWrap.appendChild(wIn);

      const hWrap = el('div', 'he-opt');
      hWrap.appendChild(el('label', '', 'Height in pixels (0 to fit its contents)'));
      const hIn = el('input');
      hIn.type = 'number'; hIn.min = 0; hIn.max = 1200;
      hIn.value = String(values.h || 0);
      hIn.oninput = () => {
        const n = parseInt(hIn.value, 10) || 0;
        values.h = n ? Math.max(80, Math.min(1200, n)) : 0;
      };
      hWrap.appendChild(hIn);
      sizeRow.append(wWrap, hWrap);
      body.appendChild(sizeRow);

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '12px';
      const ok = el('button', '', 'Done');
      ok.onclick = () => {
        Object.assign(seg, values);
        close();
        save();
      };
      actions.appendChild(ok);
      box.appendChild(actions);
    });
  }

  function setEditing(on) {
    editing = !!on;
    document.body.classList.toggle('home-editing', editing);
    const bar = document.getElementById('home-edit');
    if (bar) bar.innerHTML = '';
    if (!bar) return;
    if (editing) {
      const add = el('button', 'primary', 'Add a segment');
      add.onclick = addSegment;
      const reset = el('button', '', 'Start over');
      reset.onclick = async () => {
        const sure = window.uiConfirm
          ? await uiConfirm('Put the home page back the way it came?', { title: 'Start over', ok: 'Start over' })
          : true;
        if (!sure) return;
        const r = await ipcRenderer.invoke('home:resetLayout');
        if (r && r.layout) LAYOUT = r.layout.map(s => ({ ...s }));
        await load();
      };
      const done = el('button', '', 'Done');
      done.onclick = () => setEditing(false);
      bar.append(add, reset, done);
    } else {
      // The icon on its own, bottom right.
      const edit = el('button', 'icon-only');
      edit.title = 'Edit the page';
      edit.innerHTML = '<i class="material-icons">edit</i>';
      edit.onclick = () => setEditing(true);
      bar.appendChild(edit);
    }
    drawAll();
  }

  async function load() {
    const r = await ipcRenderer.invoke('home:layout');
    TYPES = (r && r.types) || [];
    COLUMNS = (r && r.columns) || 12;
    LAYOUT = ((r && r.layout) || []).map(s => ({ ...s }));
    drawAll();
  }

  let mounted = false;
  async function mount() {
    ensureStyle();
    if (!document.getElementById('home-edit')) {
      const bar = el('div');
      bar.id = 'home-edit';
      document.body.appendChild(bar);
    }
    await load();
    setEditing(false);
    // Once only: another call would stack a second listener on the same
    // channel and redraw the page twice for every change.
    if (mounted) return;
    mounted = true;
    // Another window changed the layout -- a second launcher window, or the
    // layout being reset.
    ipcRenderer.on('home-layout-changed', (e, layout) => {
      if (!Array.isArray(layout)) return;
      LAYOUT = layout.map(s => ({ ...s }));
      drawAll();
    });
  }

  window.Home = { mount, setProfiles, draw: drawAll, fmtDuration };
})();
