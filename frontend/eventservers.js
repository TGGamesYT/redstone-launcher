// Event servers, from the window's side.
//
// Three things: the list of the ones you have, the modals that walk through
// running one, and the editor for writing one.
//
// The editor does not ask you to remember the format. Everything the runner
// understands is declared in backend/event-server.js and handed over by
// `eventserver:schema`, so the stages, the kinds of question, the loaders and
// the kinds of content are offered as lists rather than typed from memory --
// and the file is checked as it is written rather than when it is run.
(function () {
  const { ipcRenderer } = require('electron');

  let SCHEMA = null;
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function ensureStyle() {
    if (document.getElementById('es-style')) return;
    const s = document.createElement('style');
    s.id = 'es-style';
    s.textContent = [
      '.es-list { display:flex; flex-direction:column; gap:8px; }',
      '.es-item { display:flex; align-items:center; gap:12px; background:var(--menu-bg);',
      '  border:1px solid var(--border-dark); border-radius:var(--border-radius); padding:10px 12px; }',
      '.es-item .b { flex:1; min-width:0; }',
      '.es-item .n { font-weight:bold; }',
      '.es-item .d { font-size:12px; opacity:0.75; margin-top:2px; }',
      '.es-item .go { display:flex; gap:6px; flex:0 0 auto; }',
      '.es-empty { opacity:0.7; padding:14px 2px; font-size:13px; }',

      /* the editor */
      '.es-edit { display:flex; gap:14px; min-height:380px; }',
      '.es-edit textarea { flex:1; min-width:0; font-family:ui-monospace,Consolas,monospace;',
      '  font-size:12px; line-height:1.5; resize:vertical; min-height:380px;',
      '  background:var(--very-dark); color:var(--text-color);',
      '  border:1px solid var(--border-dark); border-radius:var(--border-radius); padding:10px; }',
      '.es-side { flex:0 0 240px; overflow:auto; max-height:460px; font-size:12px; }',
      '.es-side h4 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.7; }',
      '.es-side section { margin-bottom:14px; }',
      '.es-chip { display:inline-block; margin:0 4px 4px 0; padding:3px 8px; cursor:pointer;',
      '  background:var(--menu-bg); border:1px solid var(--border-dark);',
      '  border-radius:var(--border-radius); font-family:ui-monospace,Consolas,monospace; }',
      '.es-chip:hover { border-color:var(--base-color); }',
      '.es-problems { margin-top:10px; font-size:12px; line-height:1.6; max-height:120px; overflow:auto; }',
      '.es-problems .bad { color:#ff9b94; }',
      '.es-problems .good { color:#8fd98f; }',

      /* running */
      '.es-run { font-size:13px; line-height:1.6; }',
      '.es-ask { font-size:15px; margin:0 0 12px; }',
      '.es-log { margin-top:12px; max-height:200px; overflow:auto; font-size:12px;',
      '  background:var(--very-dark); border:1px solid var(--border-dark);',
      '  border-radius:var(--border-radius); padding:8px 10px; }',
      '.es-log div { line-height:1.6; }',
      '.es-log .bad { color:#ff9b94; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  const schema = async () => (SCHEMA || (SCHEMA = await ipcRenderer.invoke('eventserver:schema')));

  // A modal that is not in anybody's way: the page's own if it has one, or a
  // plain overlay.
  function modal(title, build, { wide = false } = {}) {
    const ov = el('div', 'modal-overlay active');
    ov.style.zIndex = 7000;
    const box = el('div', 'modal-content');
    box.style.maxWidth = wide ? '900px' : '480px';
    const head = el('div', 'modal-header');
    head.appendChild(el('h2', '', title));
    const x = el('button', 'modal-close', '✕');
    head.appendChild(x);
    box.appendChild(head);
    const body = el('div');
    box.appendChild(body);
    ov.appendChild(box);
    document.body.appendChild(ov);
    const close = () => { if (window.ModalFX) window.ModalFX.close(ov, () => ov.remove()); else ov.remove(); };
    x.onclick = close;
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    build(body, box, close);
    return { ov, close };
  }

  // ── running one ───────────────────────────────────────────────────────────
  //
  // A question at a time, because a question may depend on an earlier answer.
  // The main process decides what to ask next; this only puts it.
  async function run(entry, onDone) {
    ensureStyle();
    const begun = await ipcRenderer.invoke('eventserver:begin', { id: entry.id, text: entry.text });
    if (!begun || !begun.success) {
      const why = (begun && begun.problems || []).join('\n') || (begun && begun.error) || 'It could not be started.';
      if (window.uiAlert) uiAlert(why, { title: 'That event server has problems' });
      else alert(why);
      return;
    }

    let state = begun;
    modal(begun.name || 'Event server', (body, box, close) => {
      const wrap = el('div', 'es-run');
      const ask = el('p', 'es-ask');
      const field = el('div');
      const log = el('div', 'es-log');
      log.style.display = 'none';
      wrap.append(ask, field, log);
      body.appendChild(wrap);

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '14px';
      const next = el('button', 'primary', 'Next');
      actions.appendChild(next);
      box.appendChild(actions);

      let made = null;
      const say = (text, kind) => {
        log.style.display = '';
        const line = el('div', kind === 'error' ? 'bad' : '', text);
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
      };
      const progress = (e, m) => {
        if (!m || m.run !== begun.run) return;
        say(m.text, m.kind);
      };
      ipcRenderer.on('eventserver-progress', progress);
      const done = () => {
        ipcRenderer.removeListener('eventserver-progress', progress);
        ipcRenderer.invoke('eventserver:stop', { run: begun.run }).catch(() => { });
      };
      const bye = () => { done(); close(); if (onDone) onDone(); };

      // Whatever the current step wants: a question, or a button to get on
      // with the stage.
      const draw = async () => {
        field.innerHTML = '';
        // Once it exists it stays existing. Only the step that builds it
        // reports `created`, and the answers to the stage after that do not
        // carry it back -- so without keeping it the window went back to
        // offering to make the server all over again.
        if (state.created) made = state.created;
        if (state.question) {
          const q = state.question;
          ask.textContent = q.ask;
          let read = () => '';
          if (q.type === 'yesno') {
            const sel = el('select');
            for (const v of ['yes', 'no']) {
              const o = el('option', '', v === 'yes' ? 'Yes' : 'No');
              o.value = v;
              sel.appendChild(o);
            }
            if (q.default) sel.value = q.default;
            field.appendChild(sel);
            read = () => sel.value;
          } else if (q.type === 'choice') {
            const sel = el('select');
            for (const v of q.options || []) {
              const o = el('option', '', v);
              o.value = v;
              sel.appendChild(o);
            }
            field.appendChild(sel);
            read = () => sel.value;
          } else if (q.type === 'mcversion') {
            const sel = el('select');
            sel.appendChild(el('option', '', 'Loading versions…'));
            field.appendChild(sel);
            read = () => sel.value;
            // The real list, so nobody types a version that does not exist.
            ipcRenderer.invoke('icon:pickerVersions').then((r) => {
              sel.innerHTML = '';
              const all = [...(r && r.releases || []), ...(r && r.snapshots || [])];
              for (const v of all.slice(0, 400)) {
                const o = el('option', '', v.id);
                o.value = v.id;
                sel.appendChild(o);
              }
              if (q.default) sel.value = q.default;
            }).catch(() => { sel.innerHTML = ''; });
          } else {
            const input = el('input');
            input.type = q.type === 'number' ? 'number' : 'text';
            input.value = q.default || '';
            input.style.width = '100%';
            field.appendChild(input);
            setTimeout(() => input.focus(), 0);
            read = () => input.value;
            input.onkeydown = (e) => { if (e.key === 'Enter') next.click(); };
          }
          next.textContent = 'Next';
          next.onclick = async () => {
            next.disabled = true;
            state = await ipcRenderer.invoke('eventserver:answer', { run: begun.run, value: read() });
            next.disabled = false;
            draw();
          };
          return;
        }

        // No more questions for this stage.
        if (state.finished) {
          ask.textContent = 'All done.';
          next.textContent = 'Close';
          next.onclick = bye;
          return;
        }
        if (state.waiting) {
          ask.textContent = 'Waiting for the server to finish starting…';
          next.textContent = 'Close';
          next.onclick = bye;
          return;
        }
        ask.textContent = made ? `"${made}" is ready.` : 'Ready to make the server.';
        next.textContent = made ? 'Carry on' : 'Make it';
        next.onclick = async () => {
          next.disabled = true;
          next.textContent = 'Working…';
          const r = await ipcRenderer.invoke('eventserver:go', { run: begun.run });
          next.disabled = false;
          if (!r || !r.success) {
            say((r && r.error) || 'It did not work.', 'error');
            next.textContent = 'Close';
            next.onclick = bye;
            return;
          }
          state = r;
          if (r.created && onDone) onDone();      // the list has a new server on it
          draw();
        };
      };
      draw();
    });
  }

  // ── writing one ───────────────────────────────────────────────────────────

  const EXAMPLE = {
    name: 'My event',
    description: 'What this is',
    oncreated: {
      questions: [
        { ask: 'What version?', var: 'mcver', type: 'mcversion' },
        { ask: 'Start it now (and accept the EULA)?', var: 'doeula', type: 'yesno' },
      ],
      server: {
        name: 'my event server',
        loader: 'paper-latest',
        version: '${mcver}',
        autoEula: '${doeula} == yes',
        autoStart: '${doeula} == yes',
        content: { plugins: [] },
      },
    },
    onstarted: {
      questions: [
        { ask: 'Op yourself?', var: 'toop', type: 'yesno' },
        { ask: "What's your username?", var: 'username', type: 'string', when: '${toop} == yes' },
      ],
    },
    onfullystarted: {
      commands: [
        { run: 'op ${username}', when: '${toop} == yes' },
        'say Starting event..',
      ],
    },
    onplayerjoin: { commands: [{ run: 'msg ${player} welcome to the event' }] },
  };

  async function edit(entry, onSaved) {
    ensureStyle();
    const sc = await schema();
    modal(entry ? 'Edit event server' : 'New event server', (body, box, close) => {
      const row = el('div', 'es-edit');
      const area = el('textarea');
      area.spellcheck = false;
      area.value = entry ? entry.text : JSON.stringify(EXAMPLE, null, 2);

      // What there is, rather than leaving somebody to remember it. Clicking
      // one drops it in where the cursor is.
      const side = el('div', 'es-side');
      const insert = (text) => {
        const at = area.selectionStart || 0;
        area.value = area.value.slice(0, at) + text + area.value.slice(area.selectionEnd || at);
        area.focus();
        area.selectionStart = area.selectionEnd = at + text.length;
        area.dispatchEvent(new Event('input'));
      };
      const group = (title, items, toText, toTip) => {
        const sec = el('section');
        sec.appendChild(el('h4', '', title));
        for (const it of items) {
          const chip = el('span', 'es-chip', typeof it === 'string' ? it : (it.id || it.name));
          if (toTip) chip.title = toTip(it);
          chip.onclick = () => insert(toText(it));
          sec.appendChild(chip);
        }
        side.appendChild(sec);
      };
      group('Stages', sc.phases, (p) => `"${p.id}": {\n  \n}`, (p) => `${p.name} — ${p.about}`);
      group('Question types', sc.questionTypes, (t) => `"type": "${t.id}"`, (t) => t.about || t.name);
      group('Loaders', sc.loaders, (l) => `"loader": "${l.id}"`, (l) => l.name);
      group('Content', sc.contentKinds, (k) => `"${k.id}": ["modrinth:id"]`, (k) => `Goes in ${k.dir}/`);
      group('Pieces', [
        { id: 'a question', text: '{ "ask": "What?", "var": "name", "type": "string" }' },
        { id: 'a command', text: '{ "run": "say hello", "when": "${name} == yes" }' },
        { id: 'a condition', text: '"when": "${name} == yes"' },
        { id: 'an answer', text: '${name}' },
        { id: 'who joined', text: '${player}' },
      ], (p) => p.text, (p) => p.text);

      row.append(area, side);
      body.appendChild(row);

      const problems = el('div', 'es-problems');
      body.appendChild(problems);

      // Checked as it is written rather than when it is run.
      let soon = null;
      const look = async () => {
        const r = await ipcRenderer.invoke('eventserver:validate', { text: area.value });
        problems.innerHTML = '';
        if (r && r.success) {
          problems.appendChild(el('div', 'good', '✓ This reads correctly.'));
          save.disabled = false;
          return;
        }
        save.disabled = true;
        for (const p of (r && r.problems) || []) problems.appendChild(el('div', 'bad', '• ' + p));
      };
      area.addEventListener('input', () => {
        if (soon) clearTimeout(soon);
        soon = setTimeout(look, 250);
      });

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '12px';
      const save = el('button', 'primary', 'Save');
      save.onclick = async () => {
        const r = await ipcRenderer.invoke('eventserver:save', { id: entry && entry.id, text: area.value });
        if (!r || !r.success) {
          problems.innerHTML = '';
          for (const p of (r && r.problems) || ['It could not be saved.']) {
            problems.appendChild(el('div', 'bad', '• ' + p));
          }
          return;
        }
        close();
        if (onSaved) onSaved(r.items);
      };
      actions.appendChild(save);
      box.appendChild(actions);
      look();
    }, { wide: true });
  }

  // ── the list ──────────────────────────────────────────────────────────────

  async function openList(onChanged) {
    ensureStyle();
    await schema();
    modal('Event servers', (body, box, close) => {
      const about = el('div', 'es-empty',
        'A server described in a file: what to ask, what to build from the answers, and what to do as it starts up.');
      const list = el('div', 'es-list');
      body.append(about, list);

      const draw = async () => {
        const r = await ipcRenderer.invoke('eventserver:list');
        const items = (r && r.items) || [];
        list.innerHTML = '';
        if (!items.length) {
          list.appendChild(el('div', 'es-empty', 'None yet. Press New to write one.'));
          return;
        }
        for (const it of items) {
          const row = el('div', 'es-item');
          const b = el('div', 'b');
          b.append(el('div', 'n', it.name || 'Event server'));
          if (it.description) b.appendChild(el('div', 'd', it.description));
          const go = el('div', 'go');
          const play = el('button', 'primary', 'Run');
          play.onclick = () => { close(); run(it, onChanged); };
          const pen = el('button', '', 'Edit');
          pen.onclick = () => edit(it, draw);
          const rm = el('button', '', 'Delete');
          rm.onclick = async () => {
            const sure = window.uiConfirm
              ? await uiConfirm(`Delete "${it.name}"?`, { title: 'Delete', ok: 'Delete' })
              : true;
            if (!sure) return;
            await ipcRenderer.invoke('eventserver:delete', { id: it.id });
            draw();
          };
          go.append(play, pen, rm);
          row.append(b, go);
          list.appendChild(row);
        }
      };

      const actions = el('div', 'modal-actions');
      actions.style.marginTop = '14px';
      const add = el('button', 'primary', 'New');
      add.onclick = () => edit(null, draw);
      actions.appendChild(add);
      box.appendChild(actions);
      draw();
    }, { wide: false });
  }

  window.EventServers = { openList, run, edit };
})();
