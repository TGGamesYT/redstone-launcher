/**
 * Things you can type into the launcher's devtools console.
 *
 * Loaded on every page, so whichever one happens to be open has them. Nothing
 * here is reachable from the interface: devtools themselves are behind the
 * "Developer mode" setting, and everything below needs a password that only
 * the relay knows the answer to.
 *
 *   viewAdmin("password")              open the admin panel
 *   viewSuggestions("password")        the same, on the suggestions panel
 *
 * The panel's contents are not defined here or anywhere else in the launcher —
 * it asks the relay what it holds. See adminpanel.html.
 */
(function () {
  if (window.viewAdmin) return;

  let ipc = null;
  try { ipc = require('electron').ipcRenderer; } catch { /* not in Electron */ }

  async function viewAdmin(password, panel) {
    if (!ipc) return 'Not available here.';
    if (!password) return 'viewAdmin("password")';
    const r = await ipc.invoke('admin:open', { password: String(password), panel: panel || null });
    if (!r || !r.ok) return (r && r.error) || 'Could not open it.';
    return `Open — ${r.panels} panel${r.panels === 1 ? '' : 's'}.`;
  }

  window.viewAdmin = viewAdmin;
  window.viewSuggestions = (password) => viewAdmin(password, 'suggestions');
})();
