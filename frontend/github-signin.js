// "Sign in with GitHub", through GitHub CLI -- `gh auth login --web`, which
// is the device flow: a short code shown here, typed in at
// github.com/login/device and approved there. See backend/github-auth.js.
//
//   GitHubSignIn.account()            -> Promise<{ gh, login, hasToken }>
//   GitHubSignIn.open()               -> Promise<{ success, login, ... }>
//   GitHubSignIn.mount(parent, before, onSignedIn)
//       puts "GitHub CLI: signed in as NAME" and the button that goes with
//       it into `parent`, before `before`.
(function () {
  if (window.GitHubSignIn) return;
  const { ipcRenderer, shell } = require('electron');

  async function account() {
    try { return await ipcRenderer.invoke('github:account'); }
    catch { return { gh: false, login: null, hasToken: false }; }
  }
  async function available() { return !!(await account()).gh; }

  // Who gh is signed in as, said where the sign-in is offered: the button
  // does something different depending on it, and gh can be signed in or
  // out from a terminal without the launcher being told.
  function mount(parent, before, onSignedIn) {
    const wrap = document.createElement('div');
    wrap.className = 'gh-account';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0;font-size:12px;';
    parent.insertBefore(wrap, before || null);
    const paint = async () => {
      const a = await account();
      if (!wrap.isConnected) return;
      wrap.innerHTML = '';
      const line = document.createElement('span');
      line.style.opacity = '0.8';
      if (!a.gh) {
        line.textContent = 'GitHub CLI is not installed. With it (cli.github.com), you can sign in here instead of making a token.';
        wrap.appendChild(line);
        return;
      }
      line.textContent = a.login ? `GitHub CLI is signed in as ${a.login}` : 'GitHub CLI is not signed in';
      wrap.appendChild(line);
      // Signed in to gh and the launcher already has its token: nothing to do.
      if (a.login && a.hasToken) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.login ? `Use ${a.login}` : 'Sign in with GitHub';
      b.onclick = async () => {
        b.disabled = true;
        const r = await open();
        b.disabled = false;
        await paint();
        if (r && r.success && onSignedIn) onSignedIn(r);
      };
      wrap.appendChild(b);
    };
    paint();
    return { refresh: paint, el: wrap };
  }

  function open() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 6400;
      ov.innerHTML = `<div class="modal-content" style="max-width:440px;">
        <div class="modal-header"><h2>Sign in with GitHub</h2><button class="modal-close" type="button">✕</button></div>
        <div class="gh-body" style="text-align:center;">
          <p class="gh-say" style="font-size:13px;opacity:0.85;">Asking GitHub for a code…</p>
          <div class="gh-code" style="display:none;font-family:ui-monospace,Consolas,monospace;font-size:30px;letter-spacing:4px;
            padding:12px 0;margin:8px 0;border:1px dashed var(--border-dark);border-radius:var(--border-radius);user-select:all;"></div>
          <div class="gh-wait" style="display:flex;justify-content:center;margin:10px 0;"><span class="gh-spin" style="display:inline-block;width:40px;height:40px;"></span></div>
        </div>
        <div class="modal-actions"><button class="gh-open" type="button" style="display:none;">Open github.com/login/device</button><button class="gh-cancel" type="button">Close</button></div>
      </div>`;
      document.body.appendChild(ov);
      const say = ov.querySelector('.gh-say');
      const codeEl = ov.querySelector('.gh-code');
      const openBtn = ov.querySelector('.gh-open');
      let loader = null;
      try { if (window.Loading) loader = window.Loading.mount(ov.querySelector('.gh-spin'), { size: 40 }); } catch { }
      let url = 'https://github.com/login/device';
      const onCode = (_e, m) => {
        if (!m || !m.code) return;
        url = m.url || url;
        codeEl.textContent = m.code;
        codeEl.style.display = '';
        openBtn.style.display = '';
        say.textContent = 'Type this code in at github.com/login/device and approve. It has been opened in your browser.';
      };
      ipcRenderer.on('github-signin', onCode);
      let finished = false;
      const done = (r) => {
        if (finished) return;
        finished = true;
        ipcRenderer.removeListener('github-signin', onCode);
        if (loader) { try { loader.stop(); } catch { } }
        resolve(r);
      };
      openBtn.onclick = () => { try { shell.openExternal(url); } catch { } };
      const close = () => { ov.remove(); done({ success: false, error: 'Closed' }); };
      ov.querySelector('.modal-close').onclick = close;
      ov.querySelector('.gh-cancel').onclick = close;

      ipcRenderer.invoke('github:signIn').then((r) => {
        if (!ov.isConnected) return;
        if (r && r.success) {
          say.textContent = r.login ? `Signed in as ${r.login}.` : 'Signed in.';
          if (r.gitHelper) say.textContent += ' Git on this computer uses it too.';
          codeEl.style.display = 'none';
          openBtn.style.display = 'none';
          ov.querySelector('.gh-wait').style.display = 'none';
          ov.querySelector('.gh-cancel').textContent = 'Done';
        } else {
          say.textContent = (r && r.error) || 'GitHub sign-in did not finish.';
          ov.querySelector('.gh-wait').style.display = 'none';
        }
        done(r || { success: false });
      }).catch((e) => { say.textContent = e.message; done({ success: false, error: e.message }); });
    });
  }

  window.GitHubSignIn = { account, available, open, mount };
})();
