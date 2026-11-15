// The credits dialog, opened from Settings.
//
// Four sections, every one of them read rather than written into the page:
// the founders (whose Minecraft names are looked up, so a name change shows),
// everyone who has contributed to the launcher's repository and to the
// website's -- most added first, as GitHub counts it -- and the rest, from
// credits.json in the launcher's repository. See backend/credits.js.
(function () {
  if (window.Credits) return;
  const { ipcRenderer, shell } = require('electron');

  function ensureStyle() {
    if (document.getElementById('credits-style')) return;
    const s = document.createElement('style');
    s.id = 'credits-style';
    s.textContent = `
      .modal-content.cr-modal { max-width:640px; display:flex; flex-direction:column; overflow:hidden; height:min(760px, 100%); }
      .cr-body { flex:1; min-height:0; overflow-y:auto; padding-right:4px; }
      .cr-section { margin-bottom:22px; }
      .cr-title { font-size:12px; text-transform:uppercase; letter-spacing:0.06em; opacity:0.6; margin:0 0 10px; }
      .cr-sub { font-size:12px; opacity:0.6; margin:-6px 0 10px; }
      .cr-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(180px, 1fr)); gap:8px; }
      .cr-person { display:flex; align-items:center; gap:10px; padding:8px 10px; border-radius:var(--border-radius);
        background:var(--menu-bg); border:1px solid var(--border-dark); min-width:0; }
      .cr-person.cr-link { cursor:pointer; }
      .cr-person.cr-link:hover { border-color:var(--base-color); }
      .cr-person img { width:32px; height:32px; border-radius:6px; flex:0 0 32px; image-rendering:pixelated; object-fit:cover; background:var(--very-dark); }
      .cr-person img.cr-avatar { image-rendering:auto; border-radius:50%; }
      .cr-name { font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .cr-what { font-size:11px; opacity:0.65; }
      .cr-who { min-width:0; display:flex; flex-direction:column; }
      .cr-place { width:20px; text-align:right; font-size:11px; opacity:0.5; flex:0 0 20px; }
      .cr-founders .cr-person img { width:44px; height:44px; flex-basis:44px; }
      .cr-founders .cr-name { font-size:16px; }
      .cr-note { font-size:12px; opacity:0.7; }
      .cr-wait { display:flex; flex-direction:column; align-items:center; gap:10px; padding:60px 0; font-size:13px; opacity:0.85; }
    `;
    document.head.appendChild(s);
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const lines = (n) => n == null ? null : (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  /** A Minecraft player: their head, and their current name. */
  function player(p, opts = {}) {
    const row = el('div', 'cr-person');
    const img = el('img');
    img.alt = '';
    if (p.uuid && window.setPlayerHead) window.setPlayerHead(img, { uuid: p.uuid, name: p.name || '', size: 32 });
    else img.style.visibility = 'hidden';
    const who = el('div', 'cr-who');
    who.appendChild(el('div', 'cr-name', p.name || p.uuid || '?'));
    if (opts.what) who.appendChild(el('div', 'cr-what', opts.what));
    row.append(img, who);
    return row;
  }

  /** A GitHub contributor: their avatar, their login, how much they added. */
  function contributor(c, place) {
    const row = el('div', 'cr-person' + (c.url ? ' cr-link' : ''));
    row.appendChild(el('div', 'cr-place', String(place)));
    const img = el('img', 'cr-avatar');
    img.alt = '';
    if (c.avatar) img.src = c.avatar + (c.avatar.includes('?') ? '&' : '?') + 's=64';
    else img.style.visibility = 'hidden';
    img.onerror = () => { img.style.visibility = 'hidden'; };
    const who = el('div', 'cr-who');
    who.appendChild(el('div', 'cr-name', c.login));
    const bits = [];
    if (c.added != null) bits.push(`+${lines(c.added)} lines`);
    if (c.commits) bits.push(`${c.commits} commit${c.commits === 1 ? '' : 's'}`);
    who.appendChild(el('div', 'cr-what', bits.join(' · ')));
    row.append(img, who);
    if (c.url) {
      row.title = c.url;
      row.onclick = () => { try { shell.openExternal(c.url); } catch { /* nothing to open with */ } };
    }
    return row;
  }

  function section(title, sub) {
    const s = el('div', 'cr-section');
    s.appendChild(el('p', 'cr-title', title));
    if (sub) s.appendChild(el('p', 'cr-sub', sub));
    return s;
  }

  function contributors(title, repo, list) {
    const s = section(title, repo ? `github.com/${repo}` : null);
    if (list == null) { s.appendChild(el('div', 'cr-note', 'GitHub could not be reached just now.')); return s; }
    if (!list.length) { s.appendChild(el('div', 'cr-note', 'Nobody yet.')); return s; }
    const grid = el('div', 'cr-grid');
    list.forEach((c, i) => grid.appendChild(contributor(c, i + 1)));
    s.appendChild(grid);
    return s;
  }

  async function open() {
    ensureStyle();
    const ov = el('div', 'modal-overlay active');
    ov.style.zIndex = 6000;
    const box = el('div', 'modal-content cr-modal');
    box.innerHTML = '<div class="modal-header"><h2>Credits</h2><button class="modal-close" type="button">✕</button></div>';
    const body = el('div', 'cr-body');
    const actions = el('div', 'modal-actions');
    const close = el('button', null, 'Close');
    actions.appendChild(close);
    box.append(body, actions);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const bye = () => ov.remove();
    close.onclick = bye;
    box.querySelector('.modal-close').onclick = bye;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) bye(); });

    // The launcher's own loader while GitHub is asked; the first time can
    // take a few seconds, because GitHub works its statistics out on demand.
    const wait = el('div', 'cr-wait');
    const spin = el('div');
    spin.style.cssText = 'width:48px;height:48px;';
    wait.append(spin, el('div', null, 'Gathering everybody…'));
    body.appendChild(wait);
    let loader = null;
    try { if (window.Loading && window.Loading.mount) loader = window.Loading.mount(spin, { size: 48 }); } catch { loader = null; }

    let r = null;
    try { r = await ipcRenderer.invoke('credits:get', {}); } catch (e) { r = { success: false, error: e.message }; }
    if (loader) { try { loader.stop(); } catch { } }
    if (!ov.isConnected) return;
    body.innerHTML = '';
    if (!r || !r.success) {
      body.appendChild(el('div', 'cr-note', (r && r.error) || 'The credits could not be loaded.'));
      return;
    }

    const f = section('Founders');
    f.classList.add('cr-founders');
    const fg = el('div', 'cr-grid');
    for (const p of r.founders || []) fg.appendChild(player(p));
    f.appendChild(fg);
    body.appendChild(f);

    body.appendChild(contributors('Launcher contributors', r.repos && r.repos.launcher, r.launcher));
    body.appendChild(contributors('Website contributors', r.repos && r.repos.web, r.web));

    for (const sec of r.other || []) {
      const s = section(sec.title);
      const g = el('div', 'cr-grid');
      for (const p of sec.people || []) g.appendChild(player(p));
      s.appendChild(g);
      body.appendChild(s);
    }
  }

  window.Credits = { open };
})();
