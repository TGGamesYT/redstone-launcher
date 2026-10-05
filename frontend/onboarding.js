// First-run onboarding and the import-from-another-launcher modal.
//
// Both are reachable from Settings at any time; the onboarding also runs itself
// once, the first time the launcher is opened, and hands over to the import
// modal at the end (or when skipped).
(function () {
  // Loaded both directly by a few pages and injected by sidebar.js everywhere
  // else, so it has to be safe to evaluate twice.
  if (window.Onboarding) return;
  const { ipcRenderer } = require('electron');

  const SEEN_KEY = 'onboardingDone';
  // Survives a navigation within the tab, which is exactly the lifetime the
  // tour needs: it walks the user through the sidebar, so it has to live
  // across the page loads that clicking the sidebar causes.
  const STATE_KEY = 'onboardingTour';

  function ensureStyle() {
    if (document.getElementById('ob-style')) return;
    const s = document.createElement('style');
    s.id = 'ob-style';
    s.textContent = `
      .ob-overlay { position:fixed; inset:0; z-index:9000; }
      /* A hole punched over the thing being explained: four panels around it,
         so the target stays fully visible AND clickable. */
      .ob-shade { position:fixed; background:rgba(0,0,0,0.66); z-index:9000; }
      .ob-ring { position:fixed; z-index:9001; border:2px solid var(--base-color); border-radius:10px;
        box-shadow:0 0 0 3px color-mix(in srgb, var(--base-color) 40%, transparent); pointer-events:none;
        transition:all 0.25s ease; }
      .ob-pop { position:fixed; z-index:9002; width:300px; max-width:80vw;
        background:linear-gradient(135deg, var(--third-color), color-mix(in srgb, var(--third-color) 80%, black));
        border:2px solid var(--border-dark); border-radius:var(--border-radius); padding:14px;
        box-shadow:0 18px 60px rgba(0,0,0,0.7); transition:all 0.25s ease; }
      .ob-pop h3 { margin:0 0 6px; font-size:1em; }
      .ob-pop p { margin:0 0 12px; font-size:12px; line-height:1.5; opacity:0.9; }
      .ob-pop .row { display:flex; gap:8px; justify-content:space-between; align-items:center; }
      /* A call to action, not a sentence in the body text. It used to be
         var(--base-color) on the panel, which on a red theme is red on red. */
      .ob-pop .ob-ask { margin:0 0 12px; padding:7px 10px; font-size:12px; line-height:1.4;
        display:flex; align-items:center; gap:7px; border-radius:var(--border-radius);
        background:var(--base-color); color:#fff; font-weight:600;
        border:1px solid rgba(255,255,255,0.25); text-shadow:0 1px 2px rgba(0,0,0,0.45); }
      .ob-pop .ob-ask i { font-size:16px; }
      /* A soft pulse on the thing we are asking them to click, so "click this"
         reads as an instruction rather than decoration. */
      .ob-ring.ob-ask-ring { animation: ob-pulse 1.5s ease-in-out infinite; }
      @keyframes ob-pulse {
        0%, 100% { box-shadow:0 0 0 3px color-mix(in srgb, var(--base-color) 40%, transparent); }
        50% { box-shadow:0 0 0 9px color-mix(in srgb, var(--base-color) 10%, transparent); }
      }
      .ob-pop button { padding:6px 12px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .ob-pop button.primary { background:var(--base-color); }
      .ob-step { font-size:11px; opacity:0.6; }

      /* Stops where the chrome starts (38px top bar, 70px sidebar). The square
         corner cut straight across the joint between the two bars, so it is
         rounded to follow it. */
      .imp-overlay { position:fixed; inset:38px 0 0 70px; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); z-index:7900;
        border-top-left-radius:var(--border-radius, 8px); }
      .imp-card { background:linear-gradient(135deg, var(--third-color), color-mix(in srgb, var(--third-color) 80%, black));
        border:2px solid var(--border-dark); border-radius:var(--border-radius); padding:18px; width:660px; max-width:94%;
        max-height:86vh; display:flex; flex-direction:column; box-shadow:0 18px 60px rgba(0,0,0,0.7); }
      .imp-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
      .imp-head h2 { margin:0; font-size:1.1em; }
      .imp-list { overflow-y:auto; flex:1; min-height:120px; margin-top:10px; }
      .imp-group { font-size:11px; text-transform:uppercase; letter-spacing:0.04em; opacity:0.65; margin:14px 0 6px; }
      .imp-group:first-child { margin-top:4px; }
      .imp-empty { opacity:0.72; padding:22px 4px; font-size:13px; line-height:1.6; }
      /* Same shape as the mod/modpack search rows: art, title, a line under it. */
      .imp-row { display:flex; align-items:center; gap:12px; padding:10px 12px; border:2px solid var(--border-dark);
        border-radius:var(--border-radius); margin-bottom:8px; transition:var(--smooth-transition);
        background:linear-gradient(135deg, color-mix(in srgb, var(--secondary-color) 50%, black) 0%, var(--menu-bg) 100%); }
      .imp-row.imp-click { cursor:pointer; }
      .imp-row.imp-click:hover, .imp-row:hover { border-color:var(--base-color); }
      .imp-art { width:40px; height:40px; flex:0 0 40px; border-radius:8px; overflow:hidden; background:var(--very-dark);
        display:flex; align-items:center; justify-content:center; }
      .imp-art img { width:100%; height:100%; object-fit:cover; display:block; }
      .imp-art i { font-size:22px; opacity:0.75; }
      .imp-row .n { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .imp-row .m { font-size:11px; opacity:0.72; margin-top:2px; line-height:1.4;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .imp-tag { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; opacity:0.7; flex:0 0 auto;
        border:1px solid var(--border-dark); border-radius:6px; padding:2px 6px; }
      .imp-row input[type=checkbox] { width:18px; height:18px; margin:0; flex:0 0 18px; }
      .imp-ver { width:92px; flex:0 0 92px; padding:5px 7px; font-size:11px;
        border:1px solid var(--border-dark); border-radius:var(--border-radius);
        background:var(--very-dark); color:var(--text-color); font-family:var(--text-font); }
      .imp-actions { display:flex; gap:8px; justify-content:flex-end; margin-top:14px; }
      .imp-actions button { padding:8px 16px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .imp-actions button.primary { background:var(--base-color); }
      .imp-actions button:disabled { opacity:0.5; cursor:not-allowed; }`;
    document.head.appendChild(s);
  }

  const LAUNCHER_LABELS = {
    modrinth: 'Modrinth App',
    curseforge: 'CurseForge',
    prism: 'Prism Launcher',
    multimc: 'MultiMC',
    vanilla: 'Minecraft Launcher',
  };

  // ── Import ────────────────────────────────────────────────────────────────
  // opts.single: pick ONE instance and hand it back, for "new instance → from
  // another launcher". Without it this is the bulk importer from Settings and
  // the end of the tour, which also offers accounts and skins.
  async function openImport(onClose, opts) {
    opts = opts || {};
    const single = !!opts.single;
    ensureStyle();
    const ov = document.createElement('div');
    ov.className = 'imp-overlay';
    ov.innerHTML = `
      <div class="imp-card">
        <div class="imp-head">
          <h2>${single ? 'Import an instance' : 'Import from another launcher'}</h2>
          <button class="imp-x" style="background:none;border:none;color:var(--text-color);cursor:pointer;font-size:16px;">✕</button>
        </div>
        <p style="margin:0;font-size:12px;opacity:0.8;line-height:1.5;">
          ${single
      ? 'Everything is copied, never moved — the launcher it came from keeps working exactly as it does now.'
      : 'Instances are copied, never moved — whichever launcher they came from keeps working exactly as it does now. Signed-in accounts and saved skins come across too.'}
        </p>
        <div class="imp-list"><div class="imp-empty">Looking for other launchers…</div></div>
        <div class="imp-actions">
          <button class="imp-cancel">${single ? 'Back' : 'Close'}</button>
          ${single ? '' : '<button class="imp-go primary" disabled>Import</button>'}
        </div>
      </div>`;
    document.body.appendChild(ov);

    const listEl = ov.querySelector('.imp-list');
    const goBtn = ov.querySelector('.imp-go');
    const close = () => { ov.remove(); if (onClose) onClose(); };
    ov.querySelector('.imp-x').onclick = close;
    ov.querySelector('.imp-cancel').onclick = close;

    let found = {}, accounts = [], skins = [];
    try { found = await ipcRenderer.invoke('import:scan') || {}; } catch { }
    if (!single) {
      try { accounts = await ipcRenderer.invoke('import:accounts') || []; } catch { }
      try { skins = await ipcRenderer.invoke('import:skins') || []; } catch { }
    }
    const kinds = Object.keys(found);
    listEl.innerHTML = '';

    const group = (text) => {
      const g = document.createElement('div');
      g.className = 'imp-group';
      g.textContent = text;
      listEl.appendChild(g);
    };
    // A row in the same shape as the mod/modpack search: icon, title, a line of
    // detail under it, and the whole row is the click target.
    const row = ({ icon, img, title, detail, tag, checkbox, onClick }) => {
      const el = document.createElement('div');
      el.className = 'imp-row' + (onClick ? ' imp-click' : '');
      let cb = null;
      if (checkbox) {
        cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        cb.onclick = (e) => e.stopPropagation();
        el.appendChild(cb);
      }
      const art = document.createElement('div');
      art.className = 'imp-art';
      if (img) {
        const i = document.createElement('img');
        i.src = img;
        i.onerror = () => { art.innerHTML = `<i class="material-icons">${icon || 'widgets'}</i>`; };
        art.appendChild(i);
      } else {
        art.innerHTML = `<i class="material-icons">${icon || 'widgets'}</i>`;
      }
      el.appendChild(art);
      const body = document.createElement('div');
      body.style.cssText = 'flex:1;min-width:0;';
      const t = document.createElement('div'); t.className = 'n'; t.textContent = title;
      const d = document.createElement('div'); d.className = 'm'; d.textContent = detail || '';
      body.append(t, d);
      el.appendChild(body);
      if (tag) {
        const g = document.createElement('div');
        g.className = 'imp-tag'; g.textContent = tag;
        el.appendChild(g);
      }
      if (onClick) el.onclick = onClick;
      else if (cb) el.onclick = () => { cb.checked = !cb.checked; };
      listEl.appendChild(el);
      return { el, cb };
    };

    const accountRows = [], skinRows = [], rows = [];

    // ── Accounts first: not having to sign in again is the best part of this.
    const newAccounts = accounts.filter(a => !a.already);
    if (newAccounts.length) {
      group(`Accounts — ${newAccounts.length} found`);
      newAccounts.forEach(acc => {
        const r = row({
          icon: 'person',
          img: `https://mc-heads.net/avatar/${encodeURIComponent(acc.username)}/40`,
          title: acc.username,
          detail: acc.offline ? 'offline account'
            : acc.refreshToken ? 'signed in — comes across ready to play'
              : 'will need signing in again before long',
          tag: LAUNCHER_LABELS[acc.source] || acc.source,
          checkbox: true,
        });
        accountRows.push({ cb: r.cb, acc, row: r.el });
      });
    }

    const newSkins = skins.filter(sk => !sk.already);
    if (newSkins.length) {
      group(`Skins — ${newSkins.length} found`);
      newSkins.forEach(sk => {
        const r = row({
          icon: 'face',
          img: 'data:image/png;base64,' + sk.base64,
          title: sk.name,
          detail: 'adds to your skin library',
          tag: LAUNCHER_LABELS[sk.source] || sk.source,
          checkbox: true,
        });
        // A skin PNG is 64x64 of flat colour; let it show as pixels.
        const i = r.el.querySelector('img');
        if (i) i.style.imageRendering = 'pixelated';
        skinRows.push({ cb: r.cb, sk });
      });
    }

    if (!kinds.length && !accountRows.length && !skinRows.length) {
      listEl.innerHTML = `<div class="imp-empty">
        No other launchers found in the usual places. If yours keeps its instances
        somewhere unusual, you can still add an instance by hand, or install a pack
        from the Modrinth tab.</div>`;
      if (goBtn) goBtn.disabled = true;
      return;
    }

    kinds.forEach(kind => {
      const list = found[kind].instances;
      group(`${LAUNCHER_LABELS[kind] || kind} — ${list.length} found`);
      list.forEach(inst => {
        const detail = inst.versionUnknown
          ? 'Minecraft version unknown — choose one below'
          : `${inst.version}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`
          + (inst.approximate ? ' (best guess)' : '');
        const r = row({
          icon: 'inventory_2',
          img: inst.icon || undefined,
          title: inst.name,
          detail,
          tag: inst.loader && inst.loader !== 'vanilla' ? inst.loader : 'vanilla',
          checkbox: !single,
          onClick: single ? () => { ov.remove(); if (opts.onPick) opts.onPick(withVersion(inst, r)); } : null,
        });
        // An unknown version is no longer a reason to refuse the instance: ask
        // for it instead. Disabling the row left the user with nothing to do.
        if (inst.versionUnknown) {
          const pick = document.createElement('input');
          pick.type = 'text';
          pick.placeholder = 'e.g. 1.20.1';
          pick.className = 'imp-ver';
          pick.onclick = (e) => e.stopPropagation();
          r.el.appendChild(pick);
          r._ver = pick;
          if (r.cb) r.cb.checked = false;
        }
        rows.push({ cb: r.cb, inst, row: r.el, ver: r._ver || null });
      });
    });

    // Pair a row with whatever version the user typed into it.
    function withVersion(inst, r) {
      const typed = r && r._ver ? r._ver.value.trim() : '';
      return typed ? { ...inst, version: typed, versionUnknown: false } : inst;
    }

    if (single) return;   // one click picks; there is nothing to submit

    goBtn.disabled = !rows.length && !accountRows.length && !skinRows.length;
    goBtn.onclick = async () => {
      const chosenAccounts = accountRows.filter(r => r.cb.checked).map(r => r.acc);
      const chosenSkins = skinRows.filter(r => r.cb.checked).map(r => r.sk);
      const chosen = rows.filter(r => r.cb && r.cb.checked);
      if (!chosen.length && !chosenAccounts.length && !chosenSkins.length) return;
      goBtn.disabled = true;

      if (chosenAccounts.length) {
        goBtn.textContent = 'Adding accounts…';
        try { await ipcRenderer.invoke('import:accountsAdd', { accounts: chosenAccounts }); } catch { }
      }
      if (chosenSkins.length) {
        goBtn.textContent = 'Adding skins…';
        try { await ipcRenderer.invoke('import:skinsAdd', { skins: chosenSkins }); } catch { }
      }

      let done = 0, failed = 0;
      for (const r of chosen) {
        goBtn.textContent = `Importing ${done + 1}/${chosen.length}…`;
        r.row.style.opacity = '0.5';
        const entry = r.ver && r.ver.value.trim()
          ? { ...r.inst, version: r.ver.value.trim() } : r.inst;
        try {
          const res = await ipcRenderer.invoke('import:instance', { entry });
          if (!res || !res.success) failed++;
        } catch { failed++; }
        done++;
      }
      goBtn.textContent = 'Import';
      if (window.notify) {
        const bits = [];
        if (chosen.length) bits.push(`${done - failed} instance${done - failed === 1 ? '' : 's'}`);
        if (chosenAccounts.length) bits.push(`${chosenAccounts.length} account${chosenAccounts.length === 1 ? '' : 's'}`);
        if (chosenSkins.length) bits.push(`${chosenSkins.length} skin${chosenSkins.length === 1 ? '' : 's'}`);
        window.notify(failed ? `${failed} of ${chosen.length} could not be imported` : `Imported ${bits.join(', ')}`,
          failed ? 'error' : 'success');
      }
      close();
    };
  }

  // ── Onboarding ────────────────────────────────────────────────────────────
  // Each step points at a real sidebar item and asks the user to click it, so
  // the tour teaches where things are rather than just describing them.
  // `page` is the file a step's tab opens. Steps that have one ask to be
  // clicked and the tour picks itself up on the page that opens; steps without
  // one are just explained where they are.
  const STEPS = [
    { sel: 'a[href="index.html"]', page: 'index.html', title: 'Home', body: "Where you land. Recent instances and what's new." },
    { sel: 'a[href="instances.html"]', page: 'instances.html', title: 'Instances', body: 'Every copy of the game you have set up. Create one here, or import from another launcher.' },
    { sel: 'a[href="modrinth.html"]', page: 'modrinth.html', title: 'Mods & modpacks', body: 'Browse Modrinth and CurseForge. Install a mod straight into an instance, or a whole modpack as a new one.' },
    { sel: 'a[href="server.html"]', page: 'server.html', title: 'Server manager', body: 'Run your own server, with mods and resource packs, and share it over the internet without port forwarding.' },
    { sel: '.menu.middle', title: 'Your instances', body: 'Pinned instances sit here for one-click launching. Hover one for its name.' },
    { sel: 'a[href="players.html"], #players-login', page: 'players.html', title: 'Accounts', body: 'Sign in with Microsoft here. You can add more than one account and switch between them.' },
    { sel: 'a[href="profile-manager.html"]', page: 'profile-manager.html', title: 'Skins', body: 'Your skin library — edit skins, browse thousands more, and apply them without leaving the launcher.' },
    { sel: 'a[href="settings.html"]', page: 'settings.html', title: 'Settings', body: 'Themes, RAM, syncing between instances — and this tour, if you ever want it again.' },
  ];

  // The sidebar is not consistent: most rows are `<a><li>…</li></a>`, but Skins
  // and Settings are `<li><a><i/></a><span/></li>`, so matching the <a> on
  // those two highlights the bare icon and nothing else. Climb to whichever of
  // <a>/<li> sits directly inside the menu list and highlight that, so every
  // row gets the same treatment.
  function navUnit(el) {
    let best = el;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.tagName === 'A' || n.tagName === 'LI') best = n;
      const p = n.parentElement;
      if (p && p.classList && p.classList.contains('menu')) return best;
    }
    return best;
  }

  const readState = () => {
    try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); } catch { return null; }
  };
  const writeState = (s) => {
    try {
      if (s) sessionStorage.setItem(STATE_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(STATE_KEY);
    } catch { }
  };

  // Only ever one tour on screen. Two could start at once -- a resume landing
  // at the same time as a Settings "run the tour again", say -- and each built
  // its own shades and popup, so the screen ended up double-dimmed with two
  // conflicting rings.
  let closeCurrentTour = null;

  function openOnboarding(onFinish, startAt) {
    ensureStyle();
    if (closeCurrentTour) { try { closeCurrentTour(); } catch { /* gone already */ } }
    const shades = [0, 1, 2, 3].map(() => {
      const d = document.createElement('div');
      d.className = 'ob-shade';
      document.body.appendChild(d);
      return d;
    });
    const ring = document.createElement('div');
    ring.className = 'ob-ring';
    document.body.appendChild(ring);
    const pop = document.createElement('div');
    pop.className = 'ob-pop';
    document.body.appendChild(pop);

    let i = Math.max(0, Math.min(STEPS.length - 1, Number(startAt) || 0));
    // The element this step asks to be clicked, so the handler can come off
    // again when the step changes.
    let armed = null, armedHandler = null;

    // Whatever navigates the page, the tour goes with it. Arming the step's own
    // tab only covered the tabs; clicking a pinned instance in the sidebar (the
    // "Your instances" step literally asks you to look at them) opened that
    // instance and the tour died on the spot. beforeunload catches every route
    // out of the page, so the tour always comes back.
    const handoff = () => {
      // Clicking the step's OWN tab advances; anything else resumes where it is.
      if (!writeState._armedFired) {
        writeState({ i, andImport: !!openOnboarding._andImport });
      }
      writeState._armedFired = false;
    };
    window.addEventListener('beforeunload', handoff);

    const disarm = () => {
      if (armed && armedHandler) armed.removeEventListener('click', armedHandler, true);
      armed = null; armedHandler = null;
    };
    const cleanup = () => {
      disarm();
      shades.forEach(s => s.remove());
      ring.remove(); pop.remove();
      window.removeEventListener('resize', place);
      window.removeEventListener('beforeunload', handoff);
      if (closeCurrentTour === cleanup) closeCurrentTour = null;
    };
    closeCurrentTour = cleanup;
    const finish = (skipped) => {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { }
      writeState(null);
      cleanup();
      if (onFinish) onFinish(skipped);
    };

    function stepEl() {
      for (const sel of STEPS[i].sel.split(',')) {
        const el = document.querySelector(sel.trim());
        if (el && el.getBoundingClientRect().width) return navUnit(el);
      }
      return null;
    }
    function targetRect() {
      const el = stepEl();
      return el ? el.getBoundingClientRect() : null;
    }

    // True when this step's tab would actually take us somewhere — on the page
    // it points at, clicking it is a no-op, so the step is explained in place.
    function leadsAway(step) {
      if (!step.page) return false;
      const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      return here !== step.page.toLowerCase();
    }

    // Hand the tour to the next page. Written before navigation so whichever
    // page loads next picks up where this one left off.
    function arm(step) {
      disarm();
      if (!leadsAway(step)) return false;
      const el = stepEl();
      if (!el) return false;
      armed = el;
      armedHandler = () => {
        // Stay on THIS step. Clicking the tab is how you see what it opens --
        // being thrown onto the next step the instant you did meant you never
        // got to look at the page you had just been asked to open. Next is how
        // you move on.
        writeState({ i, andImport: !!openOnboarding._andImport });
        writeState._armedFired = true;
      };
      // Capture, so the state is saved even if something else handles the
      // click first and navigates.
      el.addEventListener('click', armedHandler, true);
      return true;
    }

    function place() {
      const r = targetRect();
      const pad = 6;
      if (r) {
        ring.style.display = '';
        ring.style.left = (r.left - pad) + 'px';
        ring.style.top = (r.top - pad) + 'px';
        ring.style.width = (r.width + pad * 2) + 'px';
        ring.style.height = (r.height + pad * 2) + 'px';
        // Four panels around the hole, so the highlighted control stays usable.
        const L = r.left - pad, T = r.top - pad, R = r.right + pad, B = r.bottom + pad;
        const set = (el, x, y, w, h) => {
          el.style.left = Math.max(0, x) + 'px'; el.style.top = Math.max(0, y) + 'px';
          el.style.width = Math.max(0, w) + 'px'; el.style.height = Math.max(0, h) + 'px';
        };
        set(shades[0], 0, 0, innerWidth, T);
        set(shades[1], 0, B, innerWidth, innerHeight - B);
        set(shades[2], 0, T, L, B - T);
        set(shades[3], R, T, innerWidth - R, B - T);
        pop.style.left = Math.min(innerWidth - 320, R + 14) + 'px';
        pop.style.top = Math.min(innerHeight - 190, Math.max(50, T)) + 'px';
      } else {
        // The step's target isn't on this page — dim everything and centre it.
        ring.style.display = 'none';
        shades.forEach((s, n) => {
          if (n) { s.style.width = '0'; s.style.height = '0'; return; }
          s.style.left = '0'; s.style.top = '0'; s.style.width = innerWidth + 'px'; s.style.height = innerHeight + 'px';
        });
        pop.style.left = Math.max(20, innerWidth / 2 - 150) + 'px';
        pop.style.top = Math.max(60, innerHeight / 2 - 90) + 'px';
      }
    }

    function render() {
      const s = STEPS[i];
      const asking = arm(s);
      ring.classList.toggle('ob-ask-ring', asking);
      pop.innerHTML = `
        <h3></h3><p></p>
        ${asking ? '<p class="ob-ask"></p>' : ''}
        <div class="row">
          <span class="ob-step">${i + 1} of ${STEPS.length}</span>
          <span style="display:flex;gap:6px;">
            <button class="ob-skip">Skip</button>
            ${i > 0 ? '<button class="ob-back">Back</button>' : ''}
            <button class="ob-next primary">${i === STEPS.length - 1 ? 'Finish' : 'Next'}</button>
          </span>
        </div>`;
      pop.querySelector('h3').textContent = s.title;
      pop.querySelector('p').textContent = s.body;
      if (asking) {
        const ask = pop.querySelector('.ob-ask');
        ask.innerHTML = '<i class="material-icons">ads_click</i><span></span>';
        ask.querySelector('span').textContent = `Open ${s.title}`;
      }
      pop.querySelector('.ob-skip').onclick = () => finish(true);
      const back = pop.querySelector('.ob-back');
      if (back) back.onclick = () => { i--; render(); place(); };
      pop.querySelector('.ob-next').onclick = () => {
        if (i === STEPS.length - 1) return finish(false);
        i++; render(); place();
      };
      place();
    }

    window.addEventListener('resize', place);
    render();
  }

  // ── Welcome ───────────────────────────────────────────────────────────────
  // Shown before the tour, on first launch and whenever the tour is started
  // from Settings. Then the accounts found in other launchers, so nobody has to
  // sign in again — and when there are none, the ordinary sign-in instead,
  // because an empty "we found nothing" panel helps nobody.
  function showWelcome(onContinue) {
    ensureStyle();
    const ov = document.createElement('div');
    ov.className = 'imp-overlay';
    ov.style.zIndex = 9100;
    ov.innerHTML = `
      <div class="imp-card" style="width:460px;text-align:center;">
        <img src="icon.png" alt="" style="width:72px;height:72px;margin:4px auto 12px;display:block;
          image-rendering:pixelated;filter:drop-shadow(0 6px 16px rgba(0,0,0,0.5));">
        <h2 style="margin:0 0 10px;font-size:1.3em;">Welcome to Redstone Launcher</h2>
        <p style="margin:0 0 20px;font-size:13px;opacity:0.86;line-height:1.65;">
          Instances, modpacks, servers, skins and accounts in one place — and
          most of it set up for you. Let's get you playing.
        </p>
        <div class="imp-actions" style="justify-content:center;">
          <button class="ob-welcome-skip">Skip setup</button>
          <button class="ob-welcome-go primary">Get started</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const done = (go) => { ov.remove(); if (onContinue) onContinue(go); };
    ov.querySelector('.ob-welcome-go').onclick = () => done(true);
    ov.querySelector('.ob-welcome-skip').onclick = () => done(false);
  }

  // Accounts from other launchers, or the sign-in page when there are none.
  async function offerAccounts(onDone) {
    let accounts = [];
    try { accounts = await ipcRenderer.invoke('import:accounts') || []; } catch { }
    const fresh = accounts.filter(a => !a.already);
    if (!fresh.length) {
      // Nothing to import: send them to the sign-in rather than showing an
      // empty importer.
      ensureStyle();
      const ov = document.createElement('div');
      ov.className = 'imp-overlay';
      ov.style.zIndex = 9100;
      ov.innerHTML = `
        <div class="imp-card" style="width:440px;text-align:center;">
          <h2 style="margin:0 0 10px;font-size:1.15em;">Sign in to Minecraft</h2>
          <p style="margin:0 0 18px;font-size:13px;opacity:0.85;line-height:1.6;">
            No signed-in accounts were found in any other launcher on this
            computer, so you'll need to sign in once with Microsoft.
          </p>
          <div class="imp-actions" style="justify-content:center;">
            <button class="ob-login-later">Later</button>
            <button class="ob-login-go primary">Sign in</button>
          </div>
        </div>`;
      document.body.appendChild(ov);
      ov.querySelector('.ob-login-later').onclick = () => { ov.remove(); if (onDone) onDone(); };
      ov.querySelector('.ob-login-go').onclick = () => { ov.remove(); location.href = 'players.html'; };
      return;
    }
    openImport(onDone);
  }

  // The end of the tour. Finishing on the Settings page with the panel simply
  // vanishing gave no sense that it was over -- and left the user parked on
  // Settings, which is not where anyone wants to start. Say it's done, then go
  // home.
  function showFinished(onClose) {
    ensureStyle();
    const ov = document.createElement('div');
    ov.className = 'imp-overlay';
    ov.style.zIndex = 9100;
    ov.innerHTML = `
      <div class="imp-card" style="width:420px;text-align:center;">
        <div style="font-size:40px;line-height:1;margin:6px 0 10px;">🎉</div>
        <h2 style="margin:0 0 8px;font-size:1.15em;">That's the tour</h2>
        <p style="margin:0 0 18px;font-size:13px;opacity:0.85;line-height:1.6;">
          You know where everything lives now. Make an instance, or start one you
          imported — you're ready to play.
        </p>
        <div class="imp-actions" style="justify-content:center;">
          <button class="ob-done primary">Take me home</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const go = () => {
      ov.remove();
      if (onClose) onClose();
      // Back to the start, not wherever the last step happened to be.
      const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
      if (here !== 'index.html') location.href = 'index.html';
    };
    ov.querySelector('.ob-done').onclick = go;
    ov.addEventListener('mousedown', e => { if (e.target === ov) go(); });
  }

  // Picks the tour back up after a sidebar click navigated the page.
  function resumeTour() {
    const st = readState();
    if (!st) return false;
    writeState(null);
    const next = Number(st.i) || 0;
    const done = (skipped) => {
      if (st.andImport) openImport(() => { if (!skipped) showFinished(); });
      else if (!skipped) showFinished();
    };
    if (next >= STEPS.length) {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { }
      done(false);
      return true;
    }
    // Let the page lay its sidebar out first, or the ring lands on nothing.
    setTimeout(() => {
      openOnboarding._andImport = !!st.andImport;
      openOnboarding((skipped) => done(skipped), next);
    }, 250);
    return true;
  }

  window.Onboarding = {
    openImport,
    openTour(onFinish) {
      openOnboarding._andImport = false;
      showWelcome((go) => {
        if (!go) { if (onFinish) onFinish(true); return; }
        openOnboarding((skipped) => {
          if (!skipped) showFinished();
          if (onFinish) onFinish(skipped);
        });
      });
    },
    // The whole first-run flow: welcome, then the accounts sitting in other
    // launchers (or the sign-in when there are none), then the tour, then the
    // importer, then a send-off home.
    start() {
      showWelcome((go) => {
        if (!go) { try { localStorage.setItem(SEEN_KEY, '1'); } catch { } return; }
        offerAccounts(() => {
          openOnboarding._andImport = true;
          openOnboarding((skipped) => openImport(() => { if (!skipped) showFinished(); }));
        });
      });
    },
    welcome: showWelcome,
    hasRun() { try { return !!localStorage.getItem(SEEN_KEY); } catch { return true; } },
    resume: resumeTour,
    // Called on the home page; runs once ever.
    maybeRunFirstTime() {
      if (window.Onboarding.hasRun()) return;
      // Let the page settle so the sidebar is actually laid out.
      setTimeout(() => window.Onboarding.start(), 700);
    },
  };

  // Every page that has a sidebar loads this file, so this is where a tour in
  // progress comes back after a click navigated away.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resumeTour, { once: true });
  } else {
    resumeTour();
  }
})();
