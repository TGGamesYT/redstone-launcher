// Starting a modpack install. Kicking one off used to be a single await that
// came back minutes later, with nothing on screen in the meantime; now the main
// process takes a ticket, answers straight away, and reports its progress
// against that ticket — so the caller can hand the user straight over to the
// instances page, which follows the rest of the work.
(function () {
  const { ipcRenderer } = require('electron');

  window.ModpackInstall = {
    // url: the .mrpack download. name: what to call it until the pack's own
    // name comes back out of the archive.
    async start(url, name) {
      const ticket = 'mp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const res = await ipcRenderer.invoke('modpack:install', { url, ticket, name: name || '' });
      if (!res || !res.success) {
        alert('Could not start the install: ' + ((res && res.error) || 'unknown error'));
        return null;
      }
      window.location.href = 'instances.html?installing=' + encodeURIComponent(ticket);
      return ticket;
    },
  };
})();
