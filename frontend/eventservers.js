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

      /* the form, which is the editor proper -- the JSON is the other view */
      '.es-views { display:flex; gap:6px; margin-bottom:10px; }',
      '.es-form { flex:1; min-width:0; max-height:62vh; overflow-y:auto; padding-right:4px; }',
      '.es-stage { border:1px solid var(--border-dark); border-radius:var(--border-radius);',
      '  margin-bottom:10px; background:var(--very-dark); }',
      '.es-stage > header { display:flex; align-items:center; gap:8px; padding:9px 11px; cursor:pointer; }',
      '.es-stage > header .nm { flex:1; font-weight:bold; font-size:13px; }',
      '.es-stage > header .ct { font-size:11px; opacity:0.6; }',
      '.es-stage > header .chev { font-size:18px; opacity:0.6; transition:transform 0.15s ease; }',
      '.es-stage.open > header .chev { transform:rotate(90deg); }',
      '.es-stage > .bd { display:none; padding:0 11px 11px; }',
      '.es-stage.open > .bd { display:block; }',
      '.es-stage .about { font-size:12px; opacity:0.65; margin:0 0 10px; line-height:1.5; }',
      '.es-sub { font-size:11px; text-transform:uppercase; letter-spacing:0.05em; opacity:0.6;',
      '  margin:12px 0 6px; }',
      '.es-card { border:1px solid var(--border-dark); border-radius:var(--border-radius);',
      '  padding:9px; margin-bottom:7px; background:var(--menu-bg); }',
      '.es-card .top { display:flex; align-items:center; gap:6px; margin-bottom:7px; }',
      '.es-card .top .lab { flex:1; font-size:11px; opacity:0.6; }',
      '.es-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(150px, 1fr)); gap:8px 10px; }',
      '.es-f { display:flex; flex-direction:column; gap:3px; }',
      '.es-f.wide { grid-column:1 / -1; }',
      '.es-f > label { font-size:11px; opacity:0.7; }',
      '.es-f input, .es-f select { width:100%; box-sizing:border-box; margin:0; }',
      '.es-f .hint { font-size:11px; opacity:0.5; }',
      '.es-mini { display:flex; align-items:center; justify-content:center; width:24px; height:24px;',
      '  padding:0; margin:0; background:transparent; border:1px solid transparent;',
      '  border-radius:4px; color:var(--text-color); opacity:0.65; cursor:pointer; }',
      '.es-mini:hover { opacity:1; border-color:var(--base-color); }',
      '.es-mini:disabled { opacity:0.25; cursor:default; }',
      '.es-mini i { font-size:15px; }',
      '.es-add { padding:5px 10px; font-size:12px; margin:0; }',
      '.es-none { font-size:12px; opacity:0.55; padding:2px 0 6px; }',
      '.es-refs { display:flex; flex-direction:column; gap:5px; }',
      '.es-ref { display:flex; gap:6px; align-items:center; }',
      '.es-ref select { flex:0 0 120px; margin:0; }',
      '.es-ref input { flex:1; margin:0; }',
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


  // ── The editor's form view ────────────────────────────────────────────────
  //
  // The file is JSON, and editing it as JSON means knowing the shape, spelling
  // every key right and keeping the brackets balanced -- for a file whose
  // whole point is being handed to somebody else. So the form is the editor
  // and the JSON is the other view of it: the same document either way, and
  // switching between them reads and writes the same text.
  //
  // Everything here is built from the schema the main process hands over, so a
  // new stage, question type, loader or kind of content turns up in the form
  // without this file being told about it.
  function buildForm(host, doc, sc, changed) {
    host.innerHTML = '';

    const field = (label, control, { wide = false, hint = null } = {}) => {
      const f = el('div', 'es-f' + (wide ? ' wide' : ''));
      f.appendChild(el('label', '', label));
      f.appendChild(control);
      if (hint) f.appendChild(el('div', 'hint', hint));
      return f;
    };
    const text = (value, onInput, placeholder) => {
      const i = el('input');
      i.type = 'text';
      i.value = value == null ? '' : String(value);
      if (placeholder) i.placeholder = placeholder;
      i.oninput = () => { onInput(i.value); changed(); };
      return i;
    };
    const choose = (value, options, onPick) => {
      const sel = el('select');
      for (const o of options) {
        const op = el('option', '', o.label);
        op.value = o.value;
        if (String(value) === String(o.value)) op.selected = true;
        sel.appendChild(op);
      }
      // Whatever is in the file stays choosable even if it is not one of ours.
      if (value != null && value !== '' && !options.some(o => String(o.value) === String(value))) {
        const op = el('option', '', String(value) + ' (not one we know)');
        op.value = String(value);
        op.selected = true;
        sel.insertBefore(op, sel.firstChild);
      }
      sel.onchange = () => { onPick(sel.value); changed(); };
      return sel;
    };
    const mini = (icon, title, fn, off) => {
      const b = el('button', 'es-mini');
      b.type = 'button';
      b.title = title;
      b.disabled = !!off;
      b.innerHTML = `<i class="material-icons">${icon}</i>`;
      b.onclick = fn;
      return b;
    };
    // A condition, or nothing. The only thing standing between a step and
    // being carried out, so it is a field on everything that has one.
    const whenField = (obj) => field('Only when', text(obj.when, (v) => {
      if (v.trim()) obj.when = v; else delete obj.when;
    }, '${answer} == yes'), { wide: true, hint: 'Leave blank to always do it.' });

    // A list of cards with add, remove and reorder, which is every list in the
    // format: questions, commands, and a kind of content's references.
    const listOf = (into, arr, { label, add, draw, empty }) => {
      const box = el('div');
      const redraw = () => {
        box.innerHTML = '';
        if (!arr.length) box.appendChild(el('div', 'es-none', empty));
        arr.forEach((item, i) => {
          const card = el('div', 'es-card');
          const top = el('div', 'top');
          top.appendChild(el('span', 'lab', `${label} ${i + 1}`));
          top.appendChild(mini('keyboard_arrow_up', 'Move up', () => {
            arr.splice(i - 1, 0, arr.splice(i, 1)[0]); changed(); redraw();
          }, i === 0));
          top.appendChild(mini('keyboard_arrow_down', 'Move down', () => {
            arr.splice(i + 1, 0, arr.splice(i, 1)[0]); changed(); redraw();
          }, i === arr.length - 1));
          top.appendChild(mini('delete', 'Remove', () => {
            arr.splice(i, 1); changed(); redraw();
          }));
          card.appendChild(top);
          draw(card, item);
          box.appendChild(card);
        });
        const plus = el('button', 'es-add', '+ ' + label);
        plus.type = 'button';
        plus.onclick = () => { arr.push(add()); changed(); redraw(); };
        box.appendChild(plus);
      };
      redraw();
      into.appendChild(box);
      return box;
    };

    // ── what it is ──
    const head = el('div', 'es-stage open');
    const headBody = el('div', 'bd');
    const h = el('header');
    h.innerHTML = '<i class="material-icons chev">chevron_right</i><span class="nm">What this is</span>';
    h.onclick = () => head.classList.toggle('open');
    const grid0 = el('div', 'es-grid');
    grid0.appendChild(field('Name', text(doc.name, (v) => { doc.name = v; }), { wide: true }));
    grid0.appendChild(field('Description', text(doc.description, (v) => { doc.description = v; }),
      { wide: true, hint: 'Shown in the list of event servers.' }));
    headBody.appendChild(grid0);
    head.append(h, headBody);
    host.appendChild(head);

    // ── a stage each ──
    for (const phase of sc.phases) {
      const got = doc[phase.id] || (doc[phase.id] = {});
      const stage = el('div', 'es-stage');
      const header = el('header');
      header.innerHTML = '<i class="material-icons chev">chevron_right</i>'
        + `<span class="nm">${phase.name}</span><span class="ct"></span>`;
      const body = el('div', 'bd');
      header.onclick = () => stage.classList.toggle('open');
      stage.append(header, body);
      body.appendChild(el('p', 'about', phase.about));

      const count = () => {
        const bits = [];
        if ((got.questions || []).length) bits.push(`${got.questions.length} question${got.questions.length === 1 ? '' : 's'}`);
        if ((got.commands || []).length) bits.push(`${got.commands.length} command${got.commands.length === 1 ? '' : 's'}`);
        if (got.server) bits.push('a server');
        header.querySelector('.ct').textContent = bits.join(' · ');
      };

      if (phase.allows.includes('questions')) {
        body.appendChild(el('div', 'es-sub', 'What to ask'));
        if (!Array.isArray(got.questions)) got.questions = [];
        listOf(body, got.questions, {
          label: 'Question',
          empty: 'Nothing is asked at this stage.',
          add: () => ({ ask: '', var: '', type: 'string' }),
          draw: (card, q) => {
            const g = el('div', 'es-grid');
            g.appendChild(field('Ask', text(q.ask, (v) => { q.ask = v; }), { wide: true }));
            g.appendChild(field('Remember as', text(q.var, (v) => { q.var = v; }, 'mcver'),
              { hint: 'Used later as ${' + (q.var || 'name') + '}' }));
            g.appendChild(field('Kind of answer', choose(q.type,
              sc.questionTypes.map(t => ({ value: t.id, label: t.name })),
              (v) => { q.type = v; changed(); buildForm(host, doc, sc, changed); })));
            if (q.type === 'choice') {
              if (!Array.isArray(q.options)) q.options = [];
              g.appendChild(field('The answers to choose from',
                text(q.options.join(', '), (v) => {
                  q.options = v.split(',').map(x => x.trim()).filter(Boolean);
                }, 'one, two, three'), { wide: true }));
            }
            g.appendChild(whenField(q));
            card.appendChild(g);
          },
        });
        count();
      }

      if (phase.allows.includes('commands')) {
        body.appendChild(el('div', 'es-sub', 'What to run'));
        if (!Array.isArray(got.commands)) got.commands = [];
        listOf(body, got.commands, {
          label: 'Command',
          empty: 'Nothing is run at this stage.',
          add: () => ({ run: '' }),
          draw: (card, c) => {
            const g = el('div', 'es-grid');
            g.appendChild(field('Send to the console', text(c.run, (v) => { c.run = v; }, 'say hello'),
              { wide: true, hint: phase.id === 'onplayerjoin' ? '${player} is whoever just joined.' : null }));
            g.appendChild(whenField(c));
            card.appendChild(g);
          },
        });
        count();
      }

      if (phase.allows.includes('server')) {
        body.appendChild(el('div', 'es-sub', 'The server those answers describe'));
        const sv = got.server || (got.server = { name: '', loader: 'vanilla', version: '', content: {} });
        const g = el('div', 'es-grid');
        g.appendChild(field('Called', text(sv.name, (v) => { sv.name = v; }), { wide: true }));
        g.appendChild(field('Software', choose(sv.loader,
          sc.loaders.map(l => ({ value: l.id, label: l.name })), (v) => { sv.loader = v; })));
        g.appendChild(field('Minecraft version', text(sv.version, (v) => { sv.version = v; }, '${mcver}'),
          { hint: 'An answer, or a version written out.' }));
        // These three are conditions as much as switches: "yes" is a
        // condition that is always true, so one field does both.
        const cond = (key, label, hint) => field(label, text(
          sv[key] === true ? 'always' : sv[key] === false || sv[key] == null ? '' : String(sv[key]),
          (v) => {
            const t = v.trim();
            if (!t) delete sv[key];
            else if (/^(always|yes|true)$/i.test(t)) sv[key] = true;
            else sv[key] = v;
          }, '${answer} == yes'), { wide: true, hint });
        g.appendChild(cond('autoEula', 'Accept the EULA', 'Blank never does. "always", or a condition.'));
        g.appendChild(cond('autoStart', 'Start it straight away', 'Blank leaves it for you to start.'));
        g.appendChild(cond('autoShare', 'Share it over the internet once it has started',
          'Needs a premium account signed in. The join address is shown when it is up.'));
        body.appendChild(g);

        body.appendChild(el('div', 'es-sub', 'What to put in it'));
        if (!sv.content || typeof sv.content !== 'object') sv.content = {};
        for (const kind of sc.contentKinds) {
          const refs = Array.isArray(sv.content[kind.id]) ? sv.content[kind.id] : [];
          const wrap = el('div', 'es-card');
          const top = el('div', 'top');
          top.appendChild(el('span', 'lab', `${kind.name} — goes in ${kind.dir}/`));
          wrap.appendChild(top);
          const rows = el('div', 'es-refs');
          const redraw = () => {
            rows.innerHTML = '';
            if (!refs.length) rows.appendChild(el('div', 'es-none', 'None.'));
            refs.forEach((ref, i) => {
              const m = /^([a-z]+):(.*)$/i.exec(String(ref || ''));
              const prov = m ? m[1].toLowerCase() : sc.providers[0];
              const id = m ? m[2] : String(ref || '');
              const line = el('div', 'es-ref');
              const write = () => {
                refs[i] = `${line.querySelector('select').value}:${line.querySelector('input').value.trim()}`;
                sv.content[kind.id] = refs;
                changed();
              };
              line.appendChild(choose(prov, sc.providers.map(x => ({ value: x, label: x })), write));
              const idIn = el('input');
              idIn.type = 'text';
              idIn.value = id;
              idIn.placeholder = 'project id or slug';
              idIn.oninput = write;
              line.appendChild(idIn);
              line.appendChild(mini('delete', 'Remove', () => {
                refs.splice(i, 1);
                if (refs.length) sv.content[kind.id] = refs; else delete sv.content[kind.id];
                changed(); redraw();
              }));
              rows.appendChild(line);
            });
            const plus = el('button', 'es-add', '+ ' + kind.name.replace(/s$/, ''));
            plus.type = 'button';
            plus.onclick = () => {
              refs.push(`${sc.providers[0]}:`);
              sv.content[kind.id] = refs;
              changed(); redraw();
            };
            rows.appendChild(plus);
          };
          redraw();
          wrap.appendChild(rows);
          body.appendChild(wrap);
        }
        count();
      }

      count();
      host.appendChild(stage);
    }
  }

  async function edit(entry, onSaved) {
    ensureStyle();
    const sc = await schema();
    modal(entry ? 'Edit event server' : 'New event server', (body, box, close) => {
      // Two views of one document. The form is the editor; the JSON is there
      // for anybody who would rather see the file, and for pasting one in.
      const views = el('div', 'es-views');
      const formBtn = el('button', 'primary', 'Form');
      const jsonBtn = el('button', '', 'JSON');
      formBtn.type = jsonBtn.type = 'button';
      views.append(formBtn, jsonBtn);
      body.appendChild(views);

      const form = el('div', 'es-form');
      const row = el('div', 'es-edit');
      const area = el('textarea');
      area.spellcheck = false;
      area.value = entry ? entry.text : JSON.stringify(EXAMPLE, null, 2);

      let doc = null;
      try { doc = JSON.parse(area.value); } catch { doc = null; }
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) doc = {};

      // The document is written back to the textarea on every change, so the
      // textarea is always what would be saved whichever view is showing. One
      // place that saves, one place that is validated.
      const sync = () => {
        area.value = JSON.stringify(doc, null, 2);
        area.dispatchEvent(new Event('input'));
      };
      const drawForm = () => buildForm(form, doc, sc, sync);

      let view = 'form';
      const showView = (v) => {
        if (v === 'json') {
          // Whatever the form has, as text.
          area.value = JSON.stringify(doc, null, 2);
        } else {
          // And back: text that does not parse cannot become a form, so the
          // JSON view keeps it and says why.
          try {
            const next = JSON.parse(area.value);
            if (next && typeof next === 'object' && !Array.isArray(next)) doc = next;
          } catch {
            problems.innerHTML = '';
            problems.appendChild(el('div', 'bad', '\u2022 The JSON has to read correctly before the form can show it.'));
            return;
          }
          drawForm();
        }
        view = v;
        form.style.display = v === 'form' ? '' : 'none';
        row.style.display = v === 'form' ? 'none' : 'flex';
        formBtn.className = v === 'form' ? 'primary' : '';
        jsonBtn.className = v === 'json' ? 'primary' : '';
      };
      formBtn.onclick = () => showView('form');
      jsonBtn.onclick = () => showView('json');

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
      body.append(form, row);

      const problems = el('div', 'es-problems');
      body.appendChild(problems);

      drawForm();
      row.style.display = 'none';
      // Ctrl+F in the JSON view, same as every other editor.
      if (window.FindBar) window.FindBar.attach(area, { host: row });

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
        // What the form holds, when that is the view being used: the textarea
        // is kept in step, but a half-typed JSON view must not overwrite it.
        if (view === 'form') area.value = JSON.stringify(doc, null, 2);
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
  // The form on its own, so it can be put under test without the modal, the
  // list and the main process around it.
  window.__buildForm = buildForm;
})();
