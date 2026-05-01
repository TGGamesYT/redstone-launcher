class LaunchExperience {
  constructor() {
    this.launches = new Map();
    this.setupStyles();
  }

  setupStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .launch-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        backdrop-filter: blur(4px);
        animation: fadeIn 0.3s ease;
      }

      .launch-modal {
        background: var(--base-color);
        border: 1px solid var(--border-dark);
        border-radius: var(--border-radius);
        padding: 24px;
        min-width: 350px;
        max-width: 500px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
        animation: slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      }

      .launch-title {
        color: var(--text-color);
        font-size: 1.3rem;
        font-weight: bold;
        margin: 0 0 16px;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .launch-spinner {
        width: 24px;
        height: 24px;
        border: 3px solid rgba(255, 255, 255, 0.2);
        border-top-color: var(--third-color);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .launch-status {
        color: rgba(255, 255, 255, 0.8);
        font-size: 0.95rem;
        margin-bottom: 16px;
        min-height: 20px;
      }

      .launch-progress {
        background: rgba(0, 0, 0, 0.3);
        height: 6px;
        border-radius: 3px;
        overflow: hidden;
        margin: 16px 0;
      }

      .launch-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, var(--base-color), var(--third-color));
        border-radius: 3px;
        width: 0%;
        transition: width 0.3s ease;
        box-shadow: 0 0 10px var(--third-color);
      }

      .launch-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 16px;
      }

      .launch-stat {
        background: rgba(0, 0, 0, 0.3);
        padding: 10px;
        border-radius: 4px;
        border-left: 3px solid var(--third-color);
        font-size: 0.85rem;
      }

      .launch-stat-label {
        color: rgba(255, 255, 255, 0.6);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }

      .launch-stat-value {
        color: var(--text-color);
        font-weight: bold;
        font-size: 1.05rem;
      }

      .launch-error {
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.3);
        border-radius: 4px;
        padding: 12px;
        color: #fca5a5;
        font-size: 0.9rem;
        margin-top: 12px;
      }

      .launch-success {
        background: rgba(16, 185, 129, 0.1);
        border: 1px solid rgba(16, 185, 129, 0.3);
        border-radius: 4px;
        padding: 12px;
        color: #86efac;
        font-size: 0.9rem;
        margin-top: 12px;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .launch-success i {
        font-size: 1.1rem;
      }

      .launch-cancel-btn {
        margin-top: 16px;
        width: 100%;
        padding: 10px;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: var(--text-color);
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.2s ease;
      }

      .launch-cancel-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        border-color: var(--third-color);
      }

      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }

      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `;
    document.head.appendChild(style);
  }

  startLaunch(instanceName) {
    const launchId = Math.random().toString(36).substr(2, 9);
    
    const overlay = document.createElement('div');
    overlay.className = 'launch-overlay';
    overlay.id = `launch-${launchId}`;

    const modal = document.createElement('div');
    modal.className = 'launch-modal';
    modal.innerHTML = `
      <div class="launch-title">
        <div class="launch-spinner"></div>
        <span>Launching ${this.escapeHtml(instanceName)}</span>
      </div>
      <div class="launch-status" data-status="status">Initializing instance...</div>
      <div class="launch-progress">
        <div class="launch-progress-bar" data-progress="bar"></div>
      </div>
      <div class="launch-stats">
        <div class="launch-stat">
          <div class="launch-stat-label">Memory</div>
          <div class="launch-stat-value" data-stat="memory">Loading...</div>
        </div>
        <div class="launch-stat">
          <div class="launch-stat-label">Time Elapsed</div>
          <div class="launch-stat-value" data-stat="time">0s</div>
        </div>
      </div>
      <button class="launch-cancel-btn" data-action="cancel">Cancel Launch</button>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const launchData = {
      id: launchId,
      instanceName,
      overlay,
      modal,
      startTime: Date.now(),
      progress: 0,
      timer: null,
      cancelled: false
    };

    this.launches.set(launchId, launchData);

    this.startTimer(launchId);
    this.setupCancelHandler(launchId);

    return launchId;
  }

  updateProgress(launchId, percent, status) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    launch.progress = Math.min(100, Math.max(0, percent));
    const bar = launch.modal.querySelector('[data-progress="bar"]');
    const statusEl = launch.modal.querySelector('[data-status="status"]');

    if (bar) bar.style.width = launch.progress + '%';
    if (statusEl && status) statusEl.textContent = status;
  }

  updateMemory(launchId, memory) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    const memEl = launch.modal.querySelector('[data-stat="memory"]');
    if (memEl) memEl.textContent = memory;
  }

  startTimer(launchId) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    launch.timer = setInterval(() => {
      if (launch.cancelled) {
        clearInterval(launch.timer);
        return;
      }
      const elapsed = Math.floor((Date.now() - launch.startTime) / 1000);
      const timeEl = launch.modal.querySelector('[data-stat="time"]');
      if (timeEl) {
        if (elapsed < 60) {
          timeEl.textContent = elapsed + 's';
        } else {
          const mins = Math.floor(elapsed / 60);
          const secs = elapsed % 60;
          timeEl.textContent = `${mins}m ${secs}s`;
        }
      }
    }, 1000);
  }

  setupCancelHandler(launchId) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    const cancelBtn = launch.modal.querySelector('[data-action="cancel"]');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        launch.cancelled = true;
        this.closeLaunch(launchId, true);
      });
    }
  }

  success(launchId) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    clearInterval(launch.timer);
    const statusEl = launch.modal.querySelector('[data-status="status"]');
    const spinner = launch.modal.querySelector('.launch-spinner');
    const cancelBtn = launch.modal.querySelector('.launch-cancel-btn');

    if (spinner) spinner.remove();
    if (statusEl) {
      statusEl.innerHTML = '<div class="launch-success"><i class="material-icons">check_circle</i>Instance launched successfully!</div>';
    }
    if (cancelBtn) cancelBtn.remove();

    const bar = launch.modal.querySelector('[data-progress="bar"]');
    if (bar) bar.style.width = '100%';

    setTimeout(() => this.closeLaunch(launchId), 2000);
  }

  error(launchId, errorMsg) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    clearInterval(launch.timer);
    const statusEl = launch.modal.querySelector('[data-status="status"]');
    const spinner = launch.modal.querySelector('.launch-spinner');
    const title = launch.modal.querySelector('.launch-title');

    if (spinner) spinner.remove();
    if (title) title.innerHTML = '<i class="material-icons" style="color: #ef4444; font-size: 1.3rem;">error</i><span>Launch Failed</span>';
    if (statusEl) {
      statusEl.innerHTML = `<div class="launch-error">Error: ${this.escapeHtml(errorMsg)}</div>`;
    }

    const cancelBtn = launch.modal.querySelector('.launch-cancel-btn');
    if (cancelBtn) {
      cancelBtn.textContent = 'Close';
      cancelBtn.addEventListener('click', () => this.closeLaunch(launchId));
    }
  }

  closeLaunch(launchId, cancelled = false) {
    const launch = this.launches.get(launchId);
    if (!launch) return;

    clearInterval(launch.timer);
    launch.cancelled = cancelled;

    if (launch.overlay) {
      launch.overlay.style.animation = 'slideDown 0.3s ease-out';
      setTimeout(() => {
        launch.overlay.remove();
        this.launches.delete(launchId);
      }, 300);
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

window.launchExperience = new LaunchExperience();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LaunchExperience;
}
