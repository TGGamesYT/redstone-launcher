// The Join tab: which of your instances can get into this server.
//
// The question people actually have is "can I play on this with what I have
// already", and the honest answer is a per-instance one -- so that is what
// this is: every instance, with either a Join button or the reason it would
// not work. The reason is always named, because "incompatible" on its own
// tells you nothing about what to do next, and where the reason is something
// fixable (the server has mods you have not got) there is a button to fix it.
//
// Nothing is hidden and nothing is forbidden. An instance that cannot join
// keeps a "Join anyway" button: all of this is worked out from file names and
// jar metadata, which can be wrong, and the launcher is not the right thing to
// have the last word on what you may try.
(() => {
  if (window.ServerJoin) return;
  const { ipcRenderer } = require('electron');

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Modern quick-play wants 1.20 or newer; older versions take the plain
  // --server/--port arguments instead. Same test as the desktop shortcuts'.
  const atLeast120 = (v) => {
    const parts = (String(v).match(/^\d+(\.\d+)*/) || [''])[0].split('.').filter(Boolean).map(Number);
    if (!parts.length) return false;
    const want = [1, 20];
    for (let i = 0; i < Math.max(parts.length, want.length); i++) {
      const a = parts[i] || 0, b = want[i] || 0;
      if (a !== b) return a > b;
    }
    return true;
  };

  // Start the server, and wait until it says it is ready rather than firing the
  // game at a port nothing is listening on yet. Only the console written AFTER
  // this point counts -- the log keeps the previous run's "Done" line, and
  // matching that would be no wait at all.
  async function ensureUp(name, say) {
    const info = await ipcRenderer.invoke('get-server-info', name);
    if (info && info.status === 'running') return true;
    const before = (await ipcRenderer.invoke('server-console', name) || '');
    const mark = (Array.isArray(before) ? before.join('') : String(before)).length;
    say('Starting the server…');
    if (!(await window.startServerChecked(name))) return false;
    for (let i = 0; i < 150; i++) {          // up to ~2.5 minutes
      await new Promise(r => setTimeout(r, 1000));
      const raw = await ipcRenderer.invoke('server-console', name) || '';
      const text = (Array.isArray(raw) ? raw.join('') : String(raw)).slice(mark);
      if (/Done \([\d.,]+s\)!/.test(text)) { say('The server is up.'); return true; }
      const live = await ipcRenderer.invoke('get-server-info', name);
      if (!live || live.status !== 'running') { say('The server stopped while starting. Its console says why.'); return false; }
      say(`Waiting for the server to finish starting… (${i + 1}s)`);
    }
    // It is taking a long time, which is not the same as having failed -- the
    // game takes a while to start too, so go anyway and say so.
    say('The server is still starting; going in anyway.');
    return true;
  }

  async function join(server, address, instance, say) {
    const who = await ipcRenderer.invoke('get-selected-player');
    if (who == null) { window.location.href = 'players.html'; return; }
    if (!(await ensureUp(server.name, say))) return;
    const quickPlay = { type: atLeast120(instance.version) ? 'multiplayer' : 'legacy', identifier: address };
    ipcRenderer.send('launch-profile', { profileId: instance.id, playerId: who, quickPlay });
    say(`Starting ${instance.name}…`);
  }

  // One instance's row.
  function row(data, server, address, redraw, say) {
    const li = el('li', 'profile-item');
    li.style.alignItems = 'flex-start';
    li.dataset.instance = data.id;

    const img = el('img');
    img.src = window.instanceIcon(data.icon);
    li.appendChild(img);

    const info = el('div', 'profile-info');
    info.appendChild(el('div', 'profile-name', data.name));
    info.appendChild(el('div', 'profile-details', `v${data.version} • ${data.loader}`));
    // Why not, or what is carrying it: either way the line the row is for.
    [...data.reasons, ...data.notes].forEach((line, i) => {
      const why = i < data.reasons.length;
      const n = el('div', why ? 'join-why' : 'join-note', line);
      n.style.cssText = 'font-size:12px; margin-top:4px; opacity:.85;'
        + (why ? ' color:#e0a33a;' : '');
      info.appendChild(n);
    });
    li.appendChild(info);

    // Its own class rather than the page's `server-actions`, which sizes its
    // buttons as 36px squares for icons -- these have words in them.
    const actions = el('div', 'join-actions');
    actions.style.cssText = 'display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end;';

    // The one problem that can be fixed from here.
    if (data.missing && data.missing.length) {
      const add = el('button', null, `Add ${data.missing.length === 1 ? 'the missing mod' : `the ${data.missing.length} missing mods`}`);
      add.title = data.missing.map(m => m.name).join('\n');
      add.onclick = async (e) => {
        e.stopPropagation();
        add.disabled = true; add.textContent = 'Copying…';
        const r = await ipcRenderer.invoke('join:addMods', {
          name: server.name, profileId: data.id, filenames: data.missing.map(m => m.filename),
        });
        if (!r || !r.success) { add.textContent = 'Could not copy'; return; }
        if (r.failed && r.failed.length) say(`${r.copied} copied; ${r.failed.length} could not be read.`);
        redraw();
      };
      actions.appendChild(add);
    }

    const go = el('button', data.level === 'no' ? null : 'play-button',
      data.level === 'no' ? 'Join anyway' : 'Join');
    go.title = data.level === 'no'
      ? 'This probably will not work, but the launcher is only guessing from file names.'
      : `Join ${server.name}`;
    go.onclick = (e) => { e.stopPropagation(); join(server, address, data, say); };
    actions.appendChild(go);

    li.appendChild(actions);
    return li;
  }

  // Draw the tab into `box` for `serverName`.
  async function render(serverName, box) {
    box.innerHTML = '';
    box.appendChild(el('p', null, 'Looking at your instances…')).style.opacity = '.7';
    const res = await ipcRenderer.invoke('join:options', { name: serverName });
    box.innerHTML = '';
    if (!res || !res.success) {
      box.appendChild(el('p', null, `Could not work that out: ${(res && res.error) || 'unknown'}`));
      return;
    }
    const { server, address, plan, instances } = res;
    const redraw = () => render(serverName, box);

    // A line that says what is happening, for the waiting that joining
    // involves -- starting a server takes a while and silence looks broken.
    const status = el('div');
    status.style.cssText = 'font-size:13px; min-height:18px; margin:0 0 10px 0; opacity:.9;';
    const say = (t) => { status.textContent = t; };

    const head = el('div');
    head.style.cssText = 'display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:10px;';
    const what = el('div');
    what.style.cssText = 'flex:1; min-width:220px;';
    what.appendChild(el('div', 'join-what', `${server.type} ${server.version} at ${address}`)).style.fontWeight = 'bold';
    const bits = [];
    if (server.kind === 'mods') bits.push(`${server.mods} mod${server.mods === 1 ? '' : 's'}, which an instance needs too`);
    else if (server.kind === 'plugins') bits.push(`${server.plugins} plugin${server.plugins === 1 ? '' : 's'}, which ${server.plugins === 1 ? 'stays' : 'stay'} on the server`);
    bits.push(server.status === 'running' ? 'running' : 'not running — joining will start it');
    what.appendChild(el('div', 'join-sub', bits.join(' • '))).style.cssText = 'font-size:12px; opacity:.75;';
    head.appendChild(what);

    const make = el('button', 'play-button');
    make.innerHTML = `<i class="material-icons" style="font-size:16px;vertical-align:middle;">add</i> Make an instance for this`;
    make.title = `A ${plan.describe} instance, and nothing else`;
    make.onclick = async () => {
      const name = await window.uiPrompt(
        `An instance of ${plan.describe}, built for this server. What should it be called?`,
        `${server.name} (join)`, { title: 'Make an instance for this server', ok: 'Make it' });
      if (name === null) return;
      make.disabled = true;
      say('Making the instance…');
      const r = await ipcRenderer.invoke('join:make', { name: serverName, instanceName: name });
      make.disabled = false;
      if (!r || !r.success) { say(`Could not make it: ${(r && r.error) || 'unknown'}`); return; }
      await redraw();
      box.querySelector('#joinStatus') && (box.querySelector('#joinStatus').textContent =
        r.copied ? `Made it, with ${r.copied} of the server's mods.` : 'Made it.');
    };
    head.appendChild(make);
    box.appendChild(head);
    status.id = 'joinStatus';
    box.appendChild(status);

    if (!instances.length) {
      box.appendChild(el('p', null, 'You have no instances yet. Make one for this server above.')).style.opacity = '.75';
      return;
    }

    const can = instances.filter(i => i.level !== 'no');
    const cannot = instances.filter(i => i.level === 'no');
    const section = (title, arr) => {
      if (!arr.length) return;
      const h = el('h4', null, title);
      h.style.cssText = 'margin:14px 0 6px 0;';
      box.appendChild(h);
      const ul = el('ul', 'uli');
      ul.style.cssText = 'list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px;';
      arr.forEach(d => ul.appendChild(row(d, server, address, redraw, say)));
      box.appendChild(ul);
    };
    section(`Can join (${can.length})`, can);
    section(`Would not get in (${cannot.length})`, cannot);
  }

  window.ServerJoin = { render };
})();
