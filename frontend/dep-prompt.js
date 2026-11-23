// "Install dependencies?" -- the one popup for a mod that needs other mods.
//
// The mod browser inside an instance asked this; installing from a project's
// own page (Modrinth or CurseForge, into an instance, a new instance or a
// server) did not, and either left the dependencies out -- a game that would
// not start -- or put them in without asking. Both now ask the same way.
//
//   DepPrompt.fromModrinth({ version, gameVersion, loader, target })
//   DepPrompt.fromCurseForge({ file, gameVersion, loader, target, downloadUrl })
//       -> Promise<[{ type, name, fileUrl, installed }]>
//   DepPrompt.ask(deps)                -> Promise<the chosen ones>
//   DepPrompt.install(chosen, target)  -> Promise
//   DepPrompt.offer(deps, target)      -> ask, then install what was chosen
//
// `target` is { id, isServer }.
(function () {
  if (window.DepPrompt) return;
  const { ipcRenderer } = require('electron');

  const installedAt = async (target, url) => {
    try { return !!(await ipcRenderer.invoke('check-file-exists', String(target.id), !target.isServer, url)); }
    catch { return false; }
  };

  // A Modrinth version's required and optional dependencies, each as the
  // newest file for this game version and loader.
  async function fromModrinth({ version, gameVersion, loader, target }) {
    const deps = ((version && version.dependencies) || [])
      .filter(d => d.project_id && (d.dependency_type === 'required' || d.dependency_type === 'optional'));
    const out = [];
    for (const d of deps) {
      try {
        const q = new URLSearchParams();
        q.set('game_versions', JSON.stringify([gameVersion]));
        if (loader && loader !== 'vanilla') q.set('loaders', JSON.stringify([loader]));
        const [vs, proj] = await Promise.all([
          fetch(`https://api.modrinth.com/v2/project/${d.project_id}/version?${q}`).then(r => r.json()),
          fetch(`https://api.modrinth.com/v2/project/${d.project_id}`).then(r => r.json()),
        ]);
        const v = (Array.isArray(vs) ? vs : []).sort((a, b) => new Date(b.date_published) - new Date(a.date_published))[0];
        const file = v && ((v.files || []).find(f => f.primary) || (v.files || [])[0]);
        if (!file) continue;
        out.push({
          type: d.dependency_type, name: (proj && proj.title) || d.project_id,
          fileUrl: file.url, installed: await installedAt(target, file.url),
        });
      } catch { /* one that cannot be found is left out */ }
    }
    return out;
  }

  // A CurseForge file's required (3) and optional (2) dependencies.
  async function fromCurseForge({ file, gameVersion, loader, target, downloadUrl }) {
    const lc = (x) => String(x || '').toLowerCase();
    const deps = ((file && file.dependencies) || []).filter(d => d && d.modId && (d.relationType === 3 || d.relationType === 2));
    const out = [];
    for (const d of deps) {
      try {
        const res = await fetch(`https://curseforge.tgdoescode.workers.dev/files?projectID=${d.modId}`);
        const data = await res.json();
        const files = Array.isArray(data.data) ? data.data : [];
        const f = files.find(x => {
          const gv = (x.gameVersions || []).map(lc);
          return gv.includes(lc(gameVersion)) && (!loader || loader === 'vanilla' || gv.includes(lc(loader)));
        });
        if (!f) continue;
        const url = downloadUrl ? (await downloadUrl(d.modId, f.id, f.fileName)) : f.downloadUrl;
        if (!url) continue;
        out.push({
          type: d.relationType === 3 ? 'required' : 'optional',
          name: f.displayName || f.fileName || `Project ${d.modId}`,
          fileUrl: url, installed: await installedAt(target, url),
        });
      } catch { /* left out */ }
    }
    return out;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // The popup. Required ones start ticked, optional ones not, and ones already
  // there are shown as such and cannot be unticked.
  function ask(deps) {
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'modal-overlay active';
      ov.style.zIndex = 5000;
      const rows = deps.map((d, i) =>
        `<label style="display:flex;align-items:center;gap:8px;margin:6px 0;${d.installed ? 'opacity:.6;' : ''}">
           <input type="checkbox" data-i="${i}" ${d.installed ? 'checked disabled' : (d.type === 'required' ? 'checked' : '')} />
           <span>${esc(d.name)} <span style="opacity:.6;">(${d.installed ? 'already installed' : d.type})</span></span>
         </label>`).join('');
      ov.innerHTML = `<div class="modal-content" style="max-width:420px;">
        <div class="modal-header"><h2>Install dependencies?</h2></div>
        <div>This add-on needs other mods to work. Choose which to install too:</div>
        <div style="margin:10px 0;">${rows}</div>
        <div class="modal-actions">
          <button class="dep-go">Install selected</button>
          <button class="dep-skip">Skip</button>
        </div></div>`;
      document.body.appendChild(ov);
      ov.querySelector('.dep-skip').onclick = () => { ov.remove(); resolve([]); };
      ov.querySelector('.dep-go').onclick = () => {
        const chosen = [...ov.querySelectorAll('input[type=checkbox]')]
          .filter(c => c.checked).map(c => deps[+c.dataset.i]).filter(d => d && !d.installed);
        ov.remove(); resolve(chosen);
      };
    });
  }

  async function install(chosen, target) {
    for (const d of chosen || []) {
      await ipcRenderer.invoke('mod-download', { server: !!target.isServer, id: target.id, fileUrl: d.fileUrl, projectType: 'mod' });
    }
  }

  // Asked only when something is not there yet: every dependency already
  // installed is no reason for a popup.
  async function offer(deps, target) {
    if (!(deps || []).some(d => !d.installed)) return [];
    const chosen = await ask(deps);
    await install(chosen, target);
    return chosen;
  }

  window.DepPrompt = { fromModrinth, fromCurseForge, ask, install, offer };
})();
