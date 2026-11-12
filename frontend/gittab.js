// The Git tab, for a dev instance whose project folder is a clone.
//
// What it is for: pulling, changing branch and going back to a commit
// without leaving the launcher. What it is deliberately NOT for: committing,
// resetting, discarding, force-pushing. This is somebody's working copy, and
// a launcher that can quietly destroy a day's work in it is a launcher
// nobody should point at a working copy. Everything here either moves HEAD
// -- which git itself refuses when it would lose work -- or changes a remote
// URL.
//
// The one thing it does that is not git is the part after git: a branch can
// be a different Minecraft version, a different loader and a different mod
// id, all of which the instance shows and one of which decides how it
// launches. So every operation reports what changed about the project, and
// the tab says so in words rather than leaving somebody to notice that the
// instance now claims to be something else.
(function () {
  const { ipcRenderer } = require('electron');

  function ensureStyle() {
    if (document.getElementById('gittab-style')) return;
    const s = document.createElement('style');
    s.id = 'gittab-style';
    s.textContent = `
      .gt { display:flex; flex-direction:column; gap:14px; }
      .gt-card { background:var(--menu-bg); border:1px solid var(--border-dark);
        border-radius:var(--border-radius); padding:14px; }
      .gt-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .gt-branch { font-size:17px; font-weight:600; display:flex; align-items:center; gap:6px; }
      .gt-branch .material-icons { font-size:19px; opacity:0.75; }
      .gt-tag { font-size:11px; padding:2px 7px; border-radius:999px;
        border:1px solid var(--border-dark); opacity:0.85; white-space:nowrap; }
      .gt-tag.gt-warn { border-color:var(--base-color); color:var(--base-color); opacity:1; }
      .gt-sub { font-size:12px; opacity:0.72; margin-top:6px; word-break:break-word; }
      .gt-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
      .gt-actions button { padding:6px 12px; }
      .gt-title { font-size:12px; text-transform:uppercase; letter-spacing:0.06em;
        opacity:0.55; margin:0 0 8px; }
      .gt-list { max-height:260px; overflow-y:auto; display:flex; flex-direction:column; gap:2px; }
      .gt-item { display:flex; align-items:center; gap:10px; padding:6px 8px;
        border-radius:var(--border-radius); cursor:pointer; border:1px solid transparent; }
      .gt-item:hover { background:var(--third-color); border-color:var(--border-dark); }
      .gt-item.gt-here { border-color:var(--base-color); cursor:default; }
      .gt-item.gt-here:hover { background:transparent; }
      .gt-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gt-when { font-size:11px; opacity:0.6; white-space:nowrap; }
      .gt-hash { font-family:ui-monospace, Consolas, monospace; font-size:11px; opacity:0.7; }
      .gt-files { font-size:12px; opacity:0.8; margin-top:8px; max-height:140px; overflow-y:auto; }
      .gt-files div { display:flex; gap:8px; }
      .gt-files .gt-state { width:22px; opacity:0.6; font-family:ui-monospace, monospace; }
      .gt-out { font-family:ui-monospace, Consolas, monospace; font-size:11px; white-space:pre-wrap;
        background:var(--very-dark, rgba(0,0,0,0.25)); border-radius:var(--border-radius);
        padding:8px 10px; margin-top:10px; max-height:180px; overflow:auto; }
      .gt-changed { border-left:3px solid var(--base-color); padding-left:10px; margin-top:10px; font-size:13px; }
      .gt-changed b { font-weight:600; }
      .gt-row { display:flex; gap:8px; align-items:center; }
      .gt-row input { flex:1; min-width:0; }
      .gt-empty { opacity:0.65; font-size:13px; }
    `;
    document.head.appendChild(s);
  }

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /** "3 days ago", from an ISO date, because a timestamp tells nobody anything. */
  function ago(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const secs = Math.max(0, (Date.now() - then) / 1000);
    const steps = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'],
      [86400, 'day'], [3600, 'hour'], [60, 'minute']];
    for (const [size, name] of steps) {
      if (secs >= size) {
        const n = Math.floor(secs / size);
        return `${n} ${name}${n === 1 ? '' : 's'} ago`;
      }
    }
    return 'just now';
  }

  /**
   * Mount the tab.
   *
   * `onChanged` is called with the list of things a git operation changed
   * about the project, so the page around this can redraw the instance's
   * own heading -- the version and the loader it shows are among them.
   */
  async function mount(host, opts) {
    ensureStyle();
    const profileId = opts && opts.profileId;
    const onChanged = (opts && opts.onChanged) || (() => {});
    let busy = false;

    host.innerHTML = '';
    const root = el('div', 'gt');
    host.appendChild(root);

    const say = (text, kind) => {
      if (window.notify) window.notify(text, kind || 'success');
    };

    async function draw() {
      let r = null;
      try { r = await ipcRenderer.invoke('git:info', { profileId }); }
      catch (e) { r = { success: false, error: e.message }; }
      root.innerHTML = '';

      if (!r || !r.success) {
        root.appendChild(card(el('div', 'gt-empty', (r && r.error) || 'That could not be read.')));
        return;
      }
      // No git at all. The answer differs by platform, and on Windows it is
      // a button rather than an instruction.
      if (!r.git) return drawNoGit(r.advice);
      if (!r.repo) {
        const c = card(el('div', 'gt-empty',
          'This project is not in a Git repository, so there is nothing to pull or switch between.'));
        c.appendChild(el('div', 'gt-sub', r.dir || ''));
        root.appendChild(c);
        return;
      }

      root.appendChild(whereCard(r));
      root.appendChild(branchCard(r));
      root.appendChild(commitCard(r));
      root.appendChild(remoteCard(r));
    }

    const card = (...kids) => {
      const c = el('div', 'gt-card');
      for (const k of kids) if (k) c.appendChild(k);
      return c;
    };

    function drawNoGit(advice) {
      const c = card(el('div', null, 'There is no Git on this computer.'));
      c.appendChild(el('div', 'gt-sub', (advice && advice.say) || ''));
      if (advice && advice.canFetch) {
        const row = el('div', 'gt-actions');
        const get = el('button', null, 'Get one');
        const out = el('div', 'gt-out');
        out.style.display = 'none';
        get.onclick = async () => {
          get.disabled = true;
          out.style.display = '';
          out.textContent = '';
          const onLine = (_e, m) => { out.textContent += (m.line || '') + '\n'; out.scrollTop = out.scrollHeight; };
          ipcRenderer.on('git-progress', onLine);
          const g = await ipcRenderer.invoke('git:install');
          ipcRenderer.removeListener('git-progress', onLine);
          if (g && g.success) { say('Git is ready'); draw(); }
          else { get.disabled = false; say((g && g.error) || 'It could not be fetched', 'error'); }
        };
        row.appendChild(get);
        c.appendChild(row);
        c.appendChild(out);
      }
      root.appendChild(c);
    }

    /** Where this working copy is: the branch, the commit, and what is uncommitted. */
    function whereCard(r) {
      const head = el('div', 'gt-head');
      const name = el('div', 'gt-branch');
      const icon = el('i', 'material-icons', r.detached ? 'adjust' : 'call_split');
      name.appendChild(icon);
      name.appendChild(el('span', null, r.detached ? 'On a commit, not a branch' : r.branch));
      head.appendChild(name);

      if (r.tag) head.appendChild(el('span', 'gt-tag', r.tag));
      if (r.behind) head.appendChild(el('span', 'gt-tag gt-warn', `${r.behind} behind`));
      if (r.ahead) head.appendChild(el('span', 'gt-tag', `${r.ahead} ahead`));
      if (r.changeCount) head.appendChild(el('span', 'gt-tag gt-warn',
        `${r.changeCount} uncommitted change${r.changeCount === 1 ? '' : 's'}`));

      const c = card(head);
      if (r.head) {
        const sub = el('div', 'gt-sub');
        sub.appendChild(el('span', 'gt-hash', r.head.short + '  '));
        sub.appendChild(el('span', null, r.head.subject || ''));
        sub.appendChild(el('span', null, `  — ${r.head.author || 'someone'}, ${ago(r.head.when)}`));
        c.appendChild(sub);
      }
      if (r.detached) {
        c.appendChild(el('div', 'gt-sub',
          'Anything committed here belongs to no branch and is easy to lose. Switch to a branch below before you work on it.'));
      }
      if (r.changeCount) {
        const files = el('div', 'gt-files');
        for (const ch of r.changes) {
          const row = el('div');
          row.appendChild(el('span', 'gt-state', ch.state));
          row.appendChild(el('span', null, ch.file));
          files.appendChild(row);
        }
        if (r.changeCount > r.changes.length) {
          files.appendChild(el('div', null, `…and ${r.changeCount - r.changes.length} more`));
        }
        c.appendChild(files);
      }

      const actions = el('div', 'gt-actions');
      actions.appendChild(button('Pull', 'git:pull', {},
        r.behind ? `Bring down the ${r.behind} commit${r.behind === 1 ? '' : 's'} you are behind` : 'Bring down anything new'));
      actions.appendChild(button('Fetch', 'git:fetch', {}, 'Ask the remote what it has, and change nothing'));
      c.appendChild(actions);
      return c;
    }

    /** A button that runs one operation and then says what it did to the project. */
    function button(label, channel, args, tip) {
      const b = el('button', null, label);
      if (tip) b.title = tip;
      b.onclick = async () => {
        if (busy) return;
        busy = true;
        const was = b.textContent;
        b.textContent = '…';
        b.disabled = true;
        let r = null;
        try { r = await ipcRenderer.invoke(channel, { profileId, ...args }); }
        catch (e) { r = { success: false, error: e.message }; }
        busy = false;
        b.textContent = was;
        b.disabled = false;
        await draw();
        report(r, label);
      };
      return b;
    }

    /**
     * What happened, and what it did to the instance.
     *
     * The second half is the part that matters: a checkout that moved the
     * project from Fabric 1.21 to NeoForge 1.20 has just changed what this
     * instance IS, and being told is the difference between that and finding
     * out when it refuses to launch.
     */
    function report(r, what) {
      if (!r || !r.success) {
        say((r && r.error) || `${what} did not work`, 'error');
        if (r && r.error) {
          const out = el('div', 'gt-out', r.error);
          root.appendChild(out);
        }
        return;
      }
      if (r.changed && r.changed.length) {
        const box = el('div', 'gt-changed');
        box.appendChild(el('div', null, 'The project is not the same one it was:'));
        for (const c of r.changed) {
          const line = el('div');
          line.appendChild(el('b', null, c.what));
          line.appendChild(el('span', null, ` ${c.from || 'nothing'} → ${c.to || 'nothing'}`));
          box.appendChild(line);
        }
        box.appendChild(el('div', 'gt-sub', 'The instance has been updated to match.'));
        root.insertBefore(box, root.firstChild);
        onChanged(r.changed);
        say('Done — and the instance was updated to match');
      } else {
        say(`${what}: done`);
      }
    }

    /** Which branch to be on. */
    function branchCard(r) {
      const c = card(el('p', 'gt-title', 'Branches'));
      const list = el('div', 'gt-list');
      const b = r.branches || { local: [], remote: [] };
      if (!b.local.length && !b.remote.length) {
        list.appendChild(el('div', 'gt-empty', 'There are no branches yet.'));
      }
      for (const one of b.local) {
        const here = !r.detached && one.name === r.branch;
        const row = el('div', 'gt-item' + (here ? ' gt-here' : ''));
        row.appendChild(el('i', 'material-icons', here ? 'check' : 'call_split'));
        row.appendChild(el('span', 'gt-name', one.name));
        if (one.upstream) row.appendChild(el('span', 'gt-when', one.upstream));
        if (!here) row.onclick = () => switchTo(one.name, false);
        list.appendChild(row);
      }
      for (const one of b.remote) {
        const row = el('div', 'gt-item');
        row.appendChild(el('i', 'material-icons', 'cloud_download'));
        row.appendChild(el('span', 'gt-name', one.makes));
        row.appendChild(el('span', 'gt-when', 'on ' + one.name.replace(/\/.*$/, '')));
        // As a local branch tracking it, never as a bare remote ref:
        // checking out `origin/thing` leaves a detached head that quietly
        // loses anything committed on it.
        row.onclick = () => switchTo(one.name, true);
        list.appendChild(row);
      }
      c.appendChild(list);
      return c;
    }

    async function switchTo(ref, asBranch) {
      if (busy) return;
      busy = true;
      let r = null;
      try { r = await ipcRenderer.invoke('git:checkout', { profileId, ref, asBranch }); }
      catch (e) { r = { success: false, error: e.message }; }
      busy = false;
      await draw();
      report(r, 'Switching to ' + ref);
    }

    /** And which commit, for going back to one. */
    function commitCard(r) {
      const c = card(el('p', 'gt-title', 'Recent commits'));
      const list = el('div', 'gt-list');
      for (const one of r.commits || []) {
        const here = r.head && one.hash === r.head.hash;
        const row = el('div', 'gt-item' + (here ? ' gt-here' : ''));
        row.appendChild(el('span', 'gt-hash', one.short));
        row.appendChild(el('span', 'gt-name', one.subject || ''));
        row.appendChild(el('span', 'gt-when', ago(one.when)));
        if (!here) {
          row.title = 'Put the project back to this commit';
          row.onclick = async () => {
            const ok = window.uiConfirm
              ? await window.uiConfirm(
                `Put the project back to ${one.short} — "${one.subject}"?\n\n`
                + 'You will be on that commit rather than on a branch, which is fine for '
                + 'testing and a bad place to work. Switching to a branch again puts you back.',
                { title: 'Go back to a commit', ok: 'Go there' })
              : confirm(`Put the project back to ${one.short}?`);
            if (!ok) return;
            switchTo(one.hash, false);
          };
        }
        list.appendChild(row);
      }
      if (!(r.commits || []).length) list.appendChild(el('div', 'gt-empty', 'No commits yet.'));
      c.appendChild(list);
      return c;
    }

    /** Where it came from, and the token for getting at it if it is private. */
    function remoteCard(r) {
      const c = card(el('p', 'gt-title', 'Where it came from'));
      const names = Object.keys(r.remotes || {});
      if (!names.length) c.appendChild(el('div', 'gt-empty', 'It has no remote, so there is nothing to pull from.'));
      for (const name of names) {
        const row = el('div', 'gt-row');
        row.style.marginBottom = '8px';
        const input = el('input');
        input.type = 'text';
        input.value = (r.remotes[name].fetch) || (r.remotes[name].push) || '';
        input.spellcheck = false;
        const save = el('button', null, 'Change');
        save.onclick = async () => {
          const url = input.value.trim();
          if (!url) return;
          save.disabled = true;
          let out = null;
          try { out = await ipcRenderer.invoke('git:setRemote', { profileId, name, url }); }
          catch (e) { out = { success: false, error: e.message }; }
          save.disabled = false;
          await draw();
          report(out, 'Changing ' + name);
        };
        row.appendChild(el('span', 'gt-when', name));
        row.appendChild(input);
        row.appendChild(save);
        c.appendChild(row);
      }
      if (!names.length) {
        const row = el('div', 'gt-row');
        const input = el('input');
        input.type = 'text';
        input.placeholder = 'https://github.com/someone/their-mod.git';
        const add = el('button', null, 'Add');
        add.onclick = async () => {
          const url = input.value.trim();
          if (!url) return;
          const out = await ipcRenderer.invoke('git:setRemote', { profileId, name: 'origin', url });
          await draw();
          report(out, 'Adding origin');
        };
        row.appendChild(input);
        row.appendChild(add);
        c.appendChild(row);
      }
      c.appendChild(tokenRow(r));
      return c;
    }

    /**
     * The token, for a private repository on a computer whose Git has never
     * been signed in to one.
     *
     * Where the system Git already has a credential helper this is never
     * needed and the row says so rather than asking for something.
     */
    function tokenRow(r) {
      const box = el('div');
      box.style.marginTop = '12px';
      box.appendChild(el('div', 'gt-sub', r.hasToken
        ? 'A GitHub token is saved, and is used only for github.com. It never leaves this computer and is not synced.'
        : 'A private repository needs a sign-in. If your own Git is already signed in, nothing is needed here — '
          + 'otherwise paste a GitHub token (Settings → Developer settings → Personal access tokens, with "repo" or read-only "Contents").'));
      const row = el('div', 'gt-row');
      row.style.marginTop = '6px';
      const input = el('input');
      input.type = 'password';
      input.placeholder = r.hasToken ? '••••••••  (saved)' : 'github_pat_… or ghp_…';
      input.spellcheck = false;
      const save = el('button', null, r.hasToken ? 'Replace' : 'Save');
      save.onclick = async () => {
        const token = input.value.trim();
        if (!token) return;
        await ipcRenderer.invoke('git:setToken', { token });
        input.value = '';
        say('Saved');
        draw();
      };
      row.appendChild(input);
      row.appendChild(save);
      if (r.hasToken) {
        const forget = el('button', null, 'Forget it');
        forget.onclick = async () => {
          await ipcRenderer.invoke('git:setToken', { token: '' });
          say('Forgotten');
          draw();
        };
        row.appendChild(forget);
      }
      box.appendChild(row);
      return box;
    }

    await draw();
  }

  window.GitTab = { mount };
})();
