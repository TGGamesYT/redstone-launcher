class InstanceRenderer {
  static createInstanceCard(instance, options = {}) {
    const card = document.createElement('div');
    card.className = 'instance-card-enhanced';
    card.id = `instance-${instance.name.replace(/\s+/g, '-')}`;

    const lastPlayed = instance.lastPlayed ? new Date(instance.lastPlayed).toLocaleDateString() : 'Never';
    const version = instance.version || 'Unknown';
    const loader = instance.loader || 'Vanilla';
    const mods = instance.mods ? instance.mods.length : 0;
    const size = instance.size ? this.formatBytes(instance.size) : 'N/A';

    card.innerHTML = `
      <div class="instance-header">
        <h4 class="instance-title">${this.escapeHtml(instance.name)}</h4>
        <button class="instance-play-btn" data-instance="${instance.name}">
          <i class="material-icons" style="font-size: 0.9rem; margin-right: 2px;">play_arrow</i>Play
        </button>
      </div>

      <div class="instance-metadata">
        <div class="metadata-item">
          <div class="metadata-label">Version</div>
          <div class="metadata-value">${this.escapeHtml(version)}</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-label">Loader</div>
          <div class="metadata-value">${this.escapeHtml(loader)}</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-label">Last Played</div>
          <div class="metadata-value">${lastPlayed}</div>
        </div>
        <div class="metadata-item">
          <div class="metadata-label">Size</div>
          <div class="metadata-value">${size}</div>
        </div>
      </div>

      <div class="instance-stats">
        <div class="stat-badge">
          <i class="material-icons">extension</i>
          ${mods} ${mods === 1 ? 'Mod' : 'Mods'}
        </div>
        <div class="stat-badge">
          <i class="material-icons">schedule</i>
          ${instance.playTime ? this.formatPlayTime(instance.playTime) : '0h'}
        </div>
        ${instance.java ? `<div class="stat-badge"><i class="material-icons">settings</i>Java ${instance.java}</div>` : ''}
        ${instance.ram ? `<div class="stat-badge"><i class="material-icons">memory</i>${instance.ram}MB</div>` : ''}
      </div>

      ${instance.ram ? `
        <div class="instance-progress">
          <div class="instance-progress-bar" style="width: ${Math.min(instance.ram / 8192 * 100, 100)}%"></div>
        </div>
      ` : ''}

      <div class="instance-actions">
        <button class="action-btn" data-action="edit" title="Edit instance">
          <i class="material-icons">edit</i>
          <span>Edit</span>
        </button>
        <button class="action-btn" data-action="folder" title="Open folder">
          <i class="material-icons">folder</i>
          <span>Folder</span>
        </button>
        <button class="action-btn" data-action="delete" title="Delete instance">
          <i class="material-icons">delete</i>
          <span>Delete</span>
        </button>
      </div>
    `;

    return card;
  }

  static createDetailView(instance) {
    const detail = document.createElement('div');
    detail.className = 'instance-detail-view';

    const storageUsed = instance.storageUsed || 0;
    const storageTotal = instance.storageTotal || 1;
    const storagePercent = (storageUsed / storageTotal) * 100;

    detail.innerHTML = `
      <div class="detail-tabs">
        <button class="detail-tab active" data-tab="overview">
          <i class="material-icons" style="font-size: 0.95rem; vertical-align: middle;">info</i>
          Overview
        </button>
        <button class="detail-tab" data-tab="files">
          <i class="material-icons" style="font-size: 0.95rem; vertical-align: middle;">storage</i>
          Files
        </button>
        <button class="detail-tab" data-tab="mods">
          <i class="material-icons" style="font-size: 0.95rem; vertical-align: middle;">extension</i>
          Mods
        </button>
      </div>

      <div class="detail-content active" data-content="overview">
        <div class="detail-grid">
          <div class="detail-card">
            <div class="detail-card-header">Version</div>
            <div class="detail-card-value">${this.escapeHtml(instance.version || 'Unknown')}</div>
            <div class="detail-card-subtext">Minecraft version</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-header">Mod Loader</div>
            <div class="detail-card-value">${this.escapeHtml(instance.loader || 'Vanilla')}</div>
            <div class="detail-card-subtext">Modding platform</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-header">Total Playtime</div>
            <div class="detail-card-value">${instance.playTime ? this.formatPlayTime(instance.playTime) : '0h'}</div>
            <div class="detail-card-subtext">Time in instance</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-header">Last Played</div>
            <div class="detail-card-value">${instance.lastPlayed ? new Date(instance.lastPlayed).toLocaleDateString() : 'Never'}</div>
            <div class="detail-card-subtext">Recent activity</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-header">Java Settings</div>
            <div class="detail-card-value">${instance.java || 'Default'}</div>
            <div class="detail-card-subtext">${instance.ram || '2GB'} RAM</div>
          </div>
          <div class="detail-card">
            <div class="detail-card-header">Mods Installed</div>
            <div class="detail-card-value">${instance.mods ? instance.mods.length : 0}</div>
            <div class="detail-card-subtext">Mod count</div>
          </div>
        </div>
      </div>

      <div class="detail-content" data-content="files">
        <div class="detail-grid">
          <div class="detail-card" style="grid-column: 1/-1;">
            <div class="detail-card-header">Storage Usage</div>
            <div style="margin-top: 12px;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                <span>${this.formatBytes(storageUsed)}</span>
                <span style="color: rgba(255, 255, 255, 0.5);">${this.formatBytes(storageTotal)}</span>
              </div>
              <div class="storage-bar">
                <div class="storage-used" style="width: ${storagePercent}%"></div>
              </div>
              <div style="color: rgba(255, 255, 255, 0.5); font-size: 0.75rem; margin-top: 6px;">
                ${Math.round(storagePercent)}% used
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="detail-content" data-content="mods">
        <div class="detail-grid">
          ${instance.mods && instance.mods.length > 0 ? instance.mods.map(mod => `
            <div class="detail-card">
              <div class="detail-card-header">${this.escapeHtml(mod.name || 'Unknown Mod')}</div>
              <div class="detail-card-value" style="font-size: 0.95rem; word-break: break-word;">
                ${mod.version || 'N/A'}
              </div>
              <div class="detail-card-subtext">${mod.author || 'Unknown author'}</div>
            </div>
          `).join('') : '<p style="color: rgba(255, 255, 255, 0.5);">No mods installed</p>'}
        </div>
      </div>
    `;

    return detail;
  }

  static formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static formatPlayTime(ms) {
    if (!ms) return '0h';
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  static escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  static attachDetailHandlers(detailView) {
    const tabs = detailView.querySelectorAll('.detail-tab');
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const tabName = tab.getAttribute('data-tab');
        
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const contents = detailView.querySelectorAll('.detail-content');
        contents.forEach(c => c.classList.remove('active'));
        detailView.querySelector(`[data-content="${tabName}"]`).classList.add('active');
      });
    });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = InstanceRenderer;
}
