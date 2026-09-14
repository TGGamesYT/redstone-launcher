// First-run onboarding and the import-from-another-launcher modal.
//
// Both are reachable from Settings at any time; the onboarding also runs itself
// once, the first time the launcher is opened, and hands over to the import
// modal at the end (or when skipped).
(function () {
  const { ipcRenderer } = require('electron');

  const SEEN_KEY = 'onboardingDone';

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
      .ob-pop button { padding:6px 12px; border:1px solid var(--border-dark); background:var(--menu-bg);
        color:var(--text-color); border-radius:var(--border-radius); cursor:pointer; font-family:var(--text-font); }
      .ob-pop button.primary { background:var(--base-color); }
      .ob-step { font-size:11px; opacity:0.6; }

      .imp-overlay { position:fixed; inset:38px 0 0 70px; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); z-index:8500; }
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
          jars) are left behind; this launcher fetches its own.
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

    let found = {};
    try { found = await ipcRenderer.invoke('import:scan') || {}; } catch { }
    const kinds = Object.keys(found);
    listEl.innerHTML = '';
    if (!kinds.length) {
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
        info.querySelector('.m').textContent =
          `${inst.version}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`;
        row.append(cb, info);
        listEl.appendChild(row);
        rows.push({ cb, inst, row });
      });
    });
    goBtn.disabled = !rows.length;

    goBtn.onclick = async () => {
      const chosen = rows.filter(r => r.cb.checked);
      if (!chosen.length) return;
      goBtn.disabled = true;
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
        window.notify(failed ? `${failed} of ${chosen.length} could not be imported` : `Imported ${done} instances`,
          failed ? 'error' : 'success');
      }
      close();
    };
  }

  // ── Onboarding ────────────────────────────────────────────────────────────
  // Each step points at a real sidebar item and asks the user to click it, so
  // the tour teaches where things are rather than just describing them.
  const STEPS = [
    { sel: 'a[href="index.html"]', title: 'Home', body: "Where you land. Recent instances and what's new." },
    { sel: 'a[href="instances.html"]', title: 'Instances', body: 'Every copy of the game you have set up. Create one here, or import from another launcher.' },
    { sel: 'a[href="modrinth.html"]', title: 'Mods & modpacks', body: 'Browse Modrinth and CurseForge. Install a mod straight into an instance, or a whole modpack as a new one.' },
    { sel: 'a[href="server.html"]', title: 'Server manager', body: 'Run your own server, with mods and resource packs, and share it over the internet without port forwarding.' },
    { sel: '.menu.middle', title: 'Your instances', body: 'Pinned instances sit here for one-click launching. Hover one for its name.' },
    { sel: 'a[href="players.html"], #players-login', title: 'Accounts', body: 'Sign in with Microsoft here. You can add more than one account and switch between them.' },
    { sel: 'a[href="profile-manager.html"], a[href="profile-manager.html"] i', title: 'Skins', body: 'Your skin library — edit skins, browse thousands more, and apply them without leaving the launcher.' },
    { sel: 'a[href="settings.html"]', title: 'Settings', body: 'Themes, RAM, syncing between instances — and this tour, if you ever want it again.' },
  ];

  function openOnboarding(onFinish) {
    ensureStyle();
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

    let i = 0;
    const cleanup = () => {
      shades.forEach(s => s.remove());
      ring.remove(); pop.remove();
      window.removeEventListener('resize', place);
    };
    const finish = (skipped) => {
      try { localStorage.setItem(SEEN_KEY, '1'); } catch { }
      cleanup();
      if (onFinish) onFinish(skipped);
    };

    function targetRect() {
      for (const sel of STEPS[i].sel.split(',')) {
        const el = document.querySelector(sel.trim());
        if (el && el.getBoundingClientRect().width) return el.getBoundingClientRect();
      }
      return null;
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
      pop.innerHTML = `
        <h3></h3><p></p>
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

  window.Onboarding = {
    openImport,
    openTour: openOnboarding,
    // The whole first-run flow: the tour, then the import modal either way.
    start() { openOnboarding(() => openImport()); },
    hasRun() { try { return !!localStorage.getItem(SEEN_KEY); } catch { return true; } },
    // Called on the home page; runs once ever.
    maybeRunFirstTime() {
      if (window.Onboarding.hasRun()) return;
      // Let the page settle so the sidebar is actually laid out.
      setTimeout(() => window.Onboarding.start(), 700);
    },
  };
})();
