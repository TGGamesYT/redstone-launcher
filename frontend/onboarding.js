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
      .imp-group { font-size:11px; text-transform:uppercase; opacity:0.65; margin:12px 0 4px; }
      .imp-row { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border-dark);
        border-radius:var(--border-radius); margin-bottom:6px; background:var(--menu-bg); }
      .imp-row .n { font-size:13px; }
      .imp-row .m { font-size:11px; opacity:0.7; }
      .imp-row input { width:18px; height:18px; margin:0; flex:0 0 18px; }
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
  async function openImport(onClose) {
    ensureStyle();
    const ov = document.createElement('div');
    ov.className = 'imp-overlay';
    ov.innerHTML = `
      <div class="imp-card">
        <div class="imp-head">
          <h2>Import from another launcher</h2>
          <button class="imp-x" style="background:none;border:none;color:var(--text-color);cursor:pointer;font-size:16px;">✕</button>
        </div>
        <p style="margin:0;font-size:12px;opacity:0.8;line-height:1.5;">
          Instances are copied, never moved — whichever launcher they came from keeps
          working exactly as it does now. Shared caches (assets, libraries, version
          jars) are left behind; this launcher fetches its own. Signed-in accounts
          come across too, so you don't have to sign in again.
        </p>
        <div class="imp-list"><div style="opacity:0.7;padding:20px 0;">Looking for other launchers…</div></div>
        <div class="imp-actions">
          <button class="imp-cancel">Close</button>
          <button class="imp-go primary" disabled>Import</button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const listEl = ov.querySelector('.imp-list');
    const goBtn = ov.querySelector('.imp-go');
    const close = () => { ov.remove(); if (onClose) onClose(); };
    ov.querySelector('.imp-x').onclick = close;
    ov.querySelector('.imp-cancel').onclick = close;

    let found = {}, accounts = [];
    try { found = await ipcRenderer.invoke('import:scan') || {}; } catch { }
    try { accounts = await ipcRenderer.invoke('import:accounts') || []; } catch { }
    const kinds = Object.keys(found);
    listEl.innerHTML = '';

    // Accounts first: signing in again for every launcher you have is busywork
    // when the tokens are already on disk.
    const accountRows = [];
    const newAccounts = accounts.filter(a => !a.already);
    if (newAccounts.length) {
      const g = document.createElement('div');
      g.className = 'imp-group';
      g.textContent = `Accounts — ${newAccounts.length} found`;
      listEl.appendChild(g);
      newAccounts.forEach(acc => {
        const row = document.createElement('div');
        row.className = 'imp-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        const info = document.createElement('div');
        info.style.flex = '1';
        info.innerHTML = `<div class="n"></div><div class="m"></div>`;
        info.querySelector('.n').textContent = acc.username;
        info.querySelector('.m').textContent = acc.offline
          ? `offline account · from ${LAUNCHER_LABELS[acc.source] || acc.source}`
          : acc.refreshToken
            ? `signed in · from ${LAUNCHER_LABELS[acc.source] || acc.source}`
            : `from ${LAUNCHER_LABELS[acc.source] || acc.source} — will need signing in again soon`;
        row.append(cb, info);
        listEl.appendChild(row);
        accountRows.push({ cb, acc, row });
      });
    }

    if (!kinds.length && !accountRows.length) {
      listEl.innerHTML = `<div style="opacity:0.75;padding:20px 0;line-height:1.6;">
        No other launchers found in the usual places. If yours keeps its instances
        somewhere unusual, you can still add an instance by hand, or import a pack
        from the Modrinth tab.</div>`;
      return;
    }

    const rows = [];
    kinds.forEach(kind => {
      const g = document.createElement('div');
      g.className = 'imp-group';
      g.textContent = `${LAUNCHER_LABELS[kind] || kind} — ${found[kind].instances.length} found`;
      listEl.appendChild(g);
      found[kind].instances.forEach(inst => {
        const row = document.createElement('div');
        row.className = 'imp-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = true;
        const info = document.createElement('div');
        info.style.flex = '1';
        info.innerHTML = `<div class="n"></div><div class="m"></div>`;
        info.querySelector('.n').textContent = inst.name;
        info.querySelector('.m').textContent = inst.versionUnknown
          ? "this launcher doesn't record the Minecraft version — set it after importing"
          : `${inst.version}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`;
        // Nothing to copy a version from, so importing it would just fail.
        if (inst.versionUnknown) { cb.checked = false; cb.disabled = true; row.style.opacity = '0.55'; }
        row.append(cb, info);
        listEl.appendChild(row);
        rows.push({ cb, inst, row });
      });
    });
    goBtn.disabled = !rows.length && !accountRows.length;

    goBtn.onclick = async () => {
      const chosenAccounts = accountRows.filter(r => r.cb.checked).map(r => r.acc);
      const chosen = rows.filter(r => r.cb.checked);
      if (!chosen.length && !chosenAccounts.length) return;
      goBtn.disabled = true;
      if (chosenAccounts.length) {
        goBtn.textContent = 'Adding accounts…';
        try { await ipcRenderer.invoke('import:accountsAdd', { accounts: chosenAccounts }); } catch { }
      }
      let done = 0, failed = 0;
      for (const r of chosen) {
        goBtn.textContent = `Importing ${done + 1}/${chosen.length}…`;
        r.row.style.opacity = '0.5';
        try {
          const res = await ipcRenderer.invoke('import:instance', { entry: r.inst });
          if (!res || !res.success) failed++;
        } catch { failed++; }
        done++;
      }
      goBtn.textContent = 'Import';
      if (window.notify) {
        const bits = [];
        if (done || failed) bits.push(`${done} instance${done === 1 ? '' : 's'}`);
        if (chosenAccounts.length) bits.push(`${chosenAccounts.length} account${chosenAccounts.length === 1 ? '' : 's'}`);
        window.notify(failed ? `${failed} of ${chosen.length} could not be imported` : `Imported ${bits.join(' and ')}`,
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
      openOnboarding((skipped) => {
        if (!skipped) showFinished();
        if (onFinish) onFinish(skipped);
      });
    },
    // The whole first-run flow: the tour, then the import modal either way, and
    // a send-off back to the home page when it wasn't skipped.
    start() {
      openOnboarding._andImport = true;
      openOnboarding((skipped) => openImport(() => { if (!skipped) showFinished(); }));
    },
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
