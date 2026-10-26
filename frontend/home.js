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
      #home-segments { display:flex; flex-direction:column; gap:26px; padding-bottom:40px; }
      .hs { position:relative; }
      .hs > h2, .hs > h3 { margin:0 0 10px; }
      .hs-empty { opacity:0.6; font-size:13px; }
      .hs-error { opacity:0.7; font-size:12px; }
      /* A row of project cards, which scrolls sideways rather than wrapping
         into a block that pushes everything else off the page. */
      .hs-row { display:flex; gap:12px; overflow-x:auto; padding-bottom:6px; }
      .hs-card { flex:0 0 190px; background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); padding:10px; cursor:pointer; }
      .hs-card:hover { border-color:var(--base-color); }
      .hs-card img { width:100%; aspect-ratio:1; object-fit:cover; border-radius:6px; background:var(--very-dark);
        image-rendering:auto; }
      .hs-card .t { font-weight:bold; font-size:13px; margin-top:8px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hs-card .d { font-size:11px; opacity:0.7; margin-top:2px;
        display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
      .hs-big { font-variant-numeric:tabular-nums; line-height:1.1; font-weight:bold; }
      .hs-sub { font-size:12px; opacity:0.7; margin-top:4px; }
      .hs-media { width:100%; border-radius:var(--border-radius); background:var(--very-dark); display:block; }
      .hs-list { display:flex; flex-direction:column; gap:6px; }
      .hs-item { display:flex; align-items:center; gap:10px; background:var(--menu-bg);
        border:1px solid var(--border-dark); border-radius:var(--border-radius); padding:8px 10px; }
      .hs-item img { width:32px; height:32px; border-radius:4px; image-rendering:pixelated; background:var(--very-dark); }
      .hs-item .t { font-size:13px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .hs-item .s { font-size:11px; opacity:0.7; }
      .hs-dot { width:8px; height:8px; border-radius:50%; background:#777; flex:0 0 auto; }
      .hs-dot.on { background:#5ad65a; }
      .hs-news { background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); padding:10px 12px; }
      .hs-news h4 { margin:0 0 4px; font-size:13px; }
      .hs-news pre { margin:0; font-size:11.5px; line-height:1.5; white-space:pre-wrap;
        max-height:120px; overflow:hidden; opacity:0.85; font-family:inherit; }
      .hs-player { display:flex; justify-content:center; }

      /* ── editing ── */
      #home-edit { position:fixed; left:86px; bottom:14px; z-index:30; display:flex; gap:8px; align-items:center; }
      #home-edit button { padding:7px 12px; }
      body.home-editing .hs { outline:2px dashed color-mix(in srgb, var(--base-color) 70%, transparent);
        outline-offset:6px; border-radius:var(--border-radius); }
      body.home-editing .hs-card, body.home-editing .hs-item { pointer-events:none; }
      .hs-tools { position:absolute; top:-10px; right:0; display:none; gap:4px; z-index:4; }
      body.home-editing .hs-tools { display:flex; }
      .hs-tools button { padding:2px 6px; line-height:1; font-size:12px; }
      .hs.dragging { opacity:0.5; }
      .hs-drop { outline:2px solid var(--base-color) !important; }

      .he-types { display:grid; grid-template-columns:repeat(auto-fill,minmax(180px,1fr)); gap:8px; }
      .he-type { display:flex; gap:8px; align-items:flex-start; text-align:left; padding:10px;
        border:2px solid var(--border-dark); background:var(--menu-bg);
        border-radius:var(--border-radius); cursor:pointer; }
      .he-type:hover { border-color:var(--base-color); }
      .he-type .n { font-weight:bold; font-size:13px; }
      .he-type .a { font-size:11px; opacity:0.7; margin-top:2px; }
      .he-opt { display:flex; flex-direction:column; gap:4px; margin-bottom:10px; }
      .he-opt label { font-size:12px; opacity:0.8; }
      .he-opt input[type="text"], .he-opt input[type="number"], .he-opt select { width:100%; box-sizing:border-box; }
      .he-opt.row { flex-direction:row; align-items:center; gap:8px; }
      .he-opt.row input { width:auto; margin:0; }
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

  function projectCard(p) {
    const card = el('div', 'hs-card');
    const img = el('img');
    img.src = p.icon || (window.DEFAULT_ICON || '');
    img.alt = '';
    card.appendChild(img);
    card.appendChild(el('div', 't', p.title || ''));
    const bits = [];
    if (p.author) bits.push('by ' + p.author);
    if (p.downloads) bits.push(fmtCount(p.downloads) + ' downloads');
    card.appendChild(el('div', 'd', bits.join(' · ')));
    card.onclick = () => {
      // The project page reads what to show from here, the same way the mod
      // browser hands it over.
      localStorage.setItem('selectedModrinthProject', JSON.stringify({
        project_id: p.id, slug: p.slug, title: p.title, description: p.description,
        icon_url: p.icon, author: p.author, downloads: p.downloads,
      }));
      localStorage.setItem('selectedProjectType', p.kind || 'mod');
      window.location.href = p.provider === 'curseforge' ? 'curseforge_project.html' : 'modrinth_project.html';
    };
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

  const DRAW = {
    recent(seg, node) {
      titleOf(seg, node);
      const list = el('div', 'hs-list');
      node.appendChild(list);
      const paint = () => {
        list.innerHTML = '';
        const items = (profilesCache || []).slice(0, Number(seg.count) || 6);
        if (!items.length) {
          const add = el('div', 'hs-item');
          add.appendChild(el('div', 't', 'Make an instance'));
          add.style.cursor = 'pointer';
          add.onclick = () => { window.location.href = 'instances.html?i=NEWINSTANCE'; };
          list.appendChild(add);
          return;
        }
        for (const p of items) {
          const row = el('div', 'hs-item');
          row.style.cursor = 'pointer';
          const img = el('img');
          if (window.instanceIconInto) window.instanceIconInto(img, p);
          else img.src = window.DEFAULT_ICON || '';
          row.appendChild(img);
          const t = el('div', 't', p.name || '');
          row.appendChild(t);
          row.appendChild(el('div', 's', `${p.version || ''}${p.loader ? ' · ' + p.loader : ''}`));
          row.onclick = () => { window.location.href = `instances.html?i=${encodeURIComponent(p.id)}`; };
          list.appendChild(row);
        }
      };
      paint();
      node._repaint = paint;
    },

    async player(seg, node) {
      titleOf(seg, node);
      const box = el('div', 'hs-player');
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
      try {
        v.controls.minPolarAngle = Math.PI / 2 - 0.55;
        v.controls.maxPolarAngle = Math.PI / 2 + 0.55;
        v.controls.enableZoom = false;
      } catch { /* an older bundle */ }
      await v.loadSkin('data:image/png;base64,' + skin.base64, { model: skin.slim ? 'slim' : 'default' });
      if (skin.capeUrl) { try { await v.loadCape(skin.capeUrl); } catch { /* no cape */ } }
      cleanups.push(() => { try { v.dispose(); } catch { /* gone */ } });
      box.appendChild(el('div', 'hs-sub', account.name || ''));
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
      const row = el('div', 'hs-row');
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
      for (const p of r.hits) row.appendChild(projectCard(p));
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

    async snapshots(seg, node) {
      titleOf(seg, node);
      const r = await ipcRenderer.invoke('home:snapshots', { count: seg.count, releasesToo: seg.releasesToo });
      if (!r || !r.success) { node.appendChild(el('div', 'hs-error', (r && r.error) || 'The version list could not be read.')); return; }
      const list = el('div', 'hs-list');
      for (const v of r.items) {
        const row = el('div', 'hs-item');
        row.appendChild(el('div', 't', v.id));
        row.appendChild(el('div', 's', `${v.type}${v.at ? ' · ' + new Date(v.at).toLocaleDateString() : ''}`));
        if (v.latest) {
          const dot = el('div', 'hs-dot on');
          dot.title = 'the newest';
          row.appendChild(dot);
        }
        list.appendChild(row);
      }
      node.appendChild(list);
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
    for (const seg of LAYOUT) {
      const node = el('section', 'hs');
      node.dataset.id = seg.id;
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

  function addTools(node, seg) {
    const tools = el('div', 'hs-tools');
    const up = el('button', '', '↑'); up.title = 'Move up';
    const down = el('button', '', '↓'); down.title = 'Move down';
    const cog = el('button', '', '⚙'); cog.title = 'Settings';
    const rm = el('button', '', '✕'); rm.title = 'Remove';
    up.onclick = () => move(seg.id, -1);
    down.onclick = () => move(seg.id, 1);
    cog.onclick = () => editSegment(seg.id);
    rm.onclick = () => removeSegment(seg.id);
    tools.append(up, down, cog, rm);
    node.appendChild(tools);
  }

  const save = async () => {
    const r = await ipcRenderer.invoke('home:setLayout', { layout: LAYOUT });
    if (r && r.layout) LAYOUT = r.layout;
    drawAll();
  };

  function move(id, by) {
    const i = LAYOUT.findIndex(s => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= LAYOUT.length) return;
    const [seg] = LAYOUT.splice(i, 1);
    LAYOUT.splice(j, 0, seg);
    save();
  }

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

  function addSegment() {
    overlay('Add a segment', (body, box, close) => {
      const grid = el('div', 'he-types');
      for (const t of TYPES) {
        const b = el('button', 'he-type');
        b.type = 'button';
        b.innerHTML = `<i class="material-icons">${t.icon || 'widgets'}</i>
          <span><span class="n">${t.name}</span><span class="a">${t.about || ''}</span></span>`;
        b.onclick = () => {
          close();
          const seg = { id: `${t.type}-${Date.now().toString(36)}`, type: t.type };
          for (const o of t.options || []) seg[o.id] = o.default;
          LAYOUT.push(seg);
          save().then(() => editSegment(seg.id));
        };
        grid.appendChild(b);
      }
      body.appendChild(grid);
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
      const edit = el('button', '', '');
      edit.innerHTML = '<i class="material-icons" style="font-size:16px;vertical-align:middle;">edit</i> Edit page';
      edit.onclick = () => setEditing(true);
      bar.appendChild(edit);
    }
    drawAll();
  }

  async function load() {
    const r = await ipcRenderer.invoke('home:layout');
    TYPES = (r && r.types) || [];
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
