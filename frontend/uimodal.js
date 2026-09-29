// Launcher-styled replacements for window.alert / confirm / prompt.
//
// Chromium's own dialogs are a grey OS box in the middle of a themed app, they
// block the whole renderer while they're up, and in a frameless window they
// look like something has gone wrong. These do the same job in the launcher's
// own styling, and return promises so callers `await` them.
//
// Load this before any script that uses it. It also installs itself over
// window.alert/confirm/prompt so older code picks it up without being
// rewritten — those overrides return promises, so anything that used the
// blocking return value has to be awaited (that's the only behaviour change).
(function () {
  if (window.uiConfirm) return;

  function ensureStyle() {
    if (document.getElementById('uim-style')) return;
    const s = document.createElement('style');
    s.id = 'uim-style';
    s.textContent = `
      .uim-overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center;
        background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); z-index:12000; }
      .uim-card { background:linear-gradient(135deg, var(--third-color, #2b2b2b), color-mix(in srgb, var(--third-color, #2b2b2b) 80%, black));
        border:2px solid var(--border-dark, #111); border-radius:var(--border-radius, 8px); padding:18px;
        width:430px; max-width:90%; box-shadow:0 18px 60px rgba(0,0,0,0.7);
        color:var(--text-color, #eee); font-family:var(--text-font, inherit); }
      .uim-card h2 { margin:0 0 8px; font-size:1.05em; }
      .uim-card p { margin:0 0 14px; font-size:13px; line-height:1.55; opacity:0.9; white-space:pre-wrap; }
      .uim-card input { width:100%; box-sizing:border-box; padding:8px 10px; margin-bottom:14px;
        border:1px solid var(--border-dark, #111); border-radius:var(--border-radius, 8px);
        background:var(--very-dark, #1a1a1a); color:var(--text-color, #eee); font-family:var(--text-font, inherit); }
      .uim-actions { display:flex; gap:8px; justify-content:flex-end; }
      .uim-actions button { padding:8px 16px; border:1px solid var(--border-dark, #111);
        background:var(--menu-bg, #333); color:var(--text-color, #eee); border-radius:var(--border-radius, 8px);
        cursor:pointer; font-family:var(--text-font, inherit); }
      .uim-actions button.primary { background:var(--base-color, #c33); }
      .uim-actions button.danger { background:#b3392f; border-color:#7c241d; }`;
    document.head.appendChild(s);
  }

  // kind: 'alert' | 'confirm' | 'prompt'
  function dialog(kind, { title, body, ok, cancel, danger, value, placeholder } = {}) {
    ensureStyle();
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'uim-overlay';
      const card = document.createElement('div');
      card.className = 'uim-card';
      card.innerHTML = `
        <h2></h2>
        <p></p>
        ${kind === 'prompt' ? '<input type="text">' : ''}
        <div class="uim-actions">
          ${kind === 'alert' ? '' : '<button class="uim-no"></button>'}
          <button class="uim-yes ${danger ? 'danger' : 'primary'}"></button>
        </div>`;
      card.querySelector('h2').textContent = title || (kind === 'alert' ? 'Notice' : 'Are you sure?');
      const p = card.querySelector('p');
      p.textContent = body || '';
      if (!body) p.style.display = 'none';
      card.querySelector('.uim-yes').textContent = ok || (kind === 'alert' ? 'OK' : 'Yes');
      const no = card.querySelector('.uim-no');
      if (no) no.textContent = cancel || 'Cancel';
      const input = card.querySelector('input');
      if (input) { input.value = value == null ? '' : String(value); if (placeholder) input.placeholder = placeholder; }
      ov.appendChild(card);
      document.body.appendChild(ov);

      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', onKey, true);
        ov.remove();
        resolve(v);
      };
      const no_ = kind === 'alert' ? undefined : (kind === 'prompt' ? null : false);
      const yes = () => done(kind === 'prompt' ? (input ? input.value : '') : (kind === 'alert' ? undefined : true));

      card.querySelector('.uim-yes').onclick = yes;
      if (no) no.onclick = () => done(no_);
      ov.addEventListener('mousedown', e => { if (e.target === ov) done(no_); });
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(no_); }
        else if (e.key === 'Enter' && (kind !== 'prompt' || document.activeElement === input)) { e.stopPropagation(); yes(); }
      };
      document.addEventListener('keydown', onKey, true);
      setTimeout(() => (input || card.querySelector('.uim-yes')).focus(), 0);
    });
  }

  window.uiAlert = (body, title) =>
    dialog('alert', typeof body === 'object' && body ? body : { body: String(body == null ? '' : body), title });
  window.uiConfirm = (body, opts) =>
    dialog('confirm', typeof body === 'object' && body ? body : { body: String(body == null ? '' : body), ...(opts || {}) });
  window.uiPrompt = (body, value, opts) =>
    dialog('prompt', typeof body === 'object' && body ? body : { body: String(body == null ? '' : body), value, ...(opts || {}) });

  // Anything still calling the built-ins gets these instead.
  window.alert = (m) => window.uiAlert(m);
  window.confirm = (m) => window.uiConfirm(m);
  window.prompt = (m, v) => window.uiPrompt(m, v);
})();
