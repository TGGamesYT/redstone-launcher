const { ipcRenderer } = require('electron');

class LoadingScreenManager {
  constructor() {
    this.loadingScreen = null;
    this.isVisible = false;
    this.initialize();
  }

  initialize() {
    if (document.getElementById('loading-screen')) return;
    
    const html = `
      <div id="loading-screen" class="loading-screen">
        <div class="loading-spinner"></div>
        <div class="loading-text">Loading...</div>
        <div class="loading-subtext">Initializing Redstone Launcher</div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', html);
    this.loadingScreen = document.getElementById('loading-screen');
  }

  show(text = 'Loading...', subtext = '') {
    if (!this.loadingScreen) this.initialize();
    
    this.loadingScreen.classList.remove('hidden');
    this.loadingScreen.querySelector('.loading-text').textContent = text;
    if (subtext) {
      this.loadingScreen.querySelector('.loading-subtext').textContent = subtext;
    }
    this.isVisible = true;
  }

  hide() {
    if (this.loadingScreen) {
      this.loadingScreen.classList.add('hidden');
    }
    this.isVisible = false;
  }

  updateText(text, subtext = '') {
    if (this.loadingScreen && this.isVisible) {
      this.loadingScreen.querySelector('.loading-text').textContent = text;
      if (subtext) {
        this.loadingScreen.querySelector('.loading-subtext').textContent = subtext;
      }
    }
  }
}

const loadingScreen = new LoadingScreenManager();

class ThemeManager {
  constructor() {
    this.STORAGE_KEY = 'launcherTheme';
    this.AVAILABLE_THEMES = {
      'redstone': {
        name: 'Redstone (Default)',
        colors: ['#b30c0c', '#ff4d4d', '#d92d2d'],
      },
      'ocean': {
        name: 'Ocean',
        colors: ['#0ea5e9', '#06b6d4', '#0284c7'],
      },
      'forest': {
        name: 'Forest',
        colors: ['#059669', '#10b981', '#047857'],
      },
      'sunset': {
        name: 'Sunset',
        colors: ['#f97316', '#fb923c', '#ea580c'],
      },
      'purple': {
        name: 'Purple',
        colors: ['#8b5cf6', '#a78bfa', '#7c3aed'],
      },
      'candy': {
        name: 'Candy',
        colors: ['#ec4899', '#f472b6', '#db2777'],
      },
    };
    
    this.loadTheme();
  }

  loadTheme() {
    const cached = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '{}');
    
    // Load from cache first
    if (cached.baseColor) {
      this.applyTheme({
        baseColor: cached.baseColor,
        secondaryColor: cached.secondaryColor,
        thirdColor: cached.thirdColor,
        textColor: cached.textColor || '#ffffff',
        font: cached.font || 'Inter',
        borderRadius: cached.borderRadius || 12,
        gradientEnabled: cached.gradientEnabled || false,
        gradientColors: cached.gradientColors || [],
        gradientAngle: cached.gradientAngle || 180,
      });
    }

    // Load from backend and cache it
    ipcRenderer.invoke('get-settings').then(settings => {
      this.applyTheme(settings);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
    });
  }

  applyTheme(settings) {
    const root = document.documentElement;
    
    root.style.setProperty('--base-color', settings.baseColor);
    root.style.setProperty('--secondary-color', settings.secondaryColor);
    root.style.setProperty('--third-color', settings.thirdColor || this.getMiddleColor(settings.baseColor, settings.secondaryColor));
    root.style.setProperty('--text-color', settings.textColor || '#ffffff');
    root.style.setProperty('--text-font', settings.font || 'Inter');
    root.style.setProperty('--border-radius', `${settings.borderRadius || 12}px`);
    root.style.setProperty('--gradient-angle', `${settings.gradientAngle || 180}deg`);

    if (settings.gradientEnabled && settings.gradientColors && settings.gradientColors.length > 0) {
      const gradientStr = `linear-gradient(${settings.gradientAngle || 180}deg, ${settings.gradientColors.join(', ')})`;
      root.style.setProperty('--app-gradient', gradientStr);
      document.documentElement.classList.add('gradient-enabled');
      document.body.classList.add('gradient-enabled');
    } else {
      const defaultGradient = `linear-gradient(135deg, ${settings.secondaryColor}, ${settings.baseColor})`;
      root.style.setProperty('--app-gradient', defaultGradient);
      document.documentElement.classList.remove('gradient-enabled');
      document.body.classList.remove('gradient-enabled');
    }
  }

  getMiddleColor(hex1, hex2) {
    const rgb1 = this.hexToRgb(hex1);
    const rgb2 = this.hexToRgb(hex2);
    const middle = rgb1.map((c, i) => Math.round((c + rgb2[i]) / 2));
    return this.rgbToHex(middle[0], middle[1], middle[2]);
  }

  hexToRgb(hex) {
    hex = hex.replace(/^#/, '');
    return [
      parseInt(hex.substring(0, 2), 16),
      parseInt(hex.substring(2, 4), 16),
      parseInt(hex.substring(4, 6), 16)
    ];
  }

  rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).toUpperCase().join('');
  }

  applyPreset(presetName) {
    if (this.AVAILABLE_THEMES[presetName]) {
      const colors = this.AVAILABLE_THEMES[presetName].colors;
      this.applyTheme({
        baseColor: colors[0],
        secondaryColor: colors[1],
        thirdColor: colors[2],
        textColor: '#ffffff',
        font: 'Inter',
        borderRadius: 12,
        gradientEnabled: true,
        gradientColors: colors,
        gradientAngle: 135,
      });
      
      const settings = {
        baseColor: colors[0],
        secondaryColor: colors[1],
        thirdColor: colors[2],
        textColor: '#ffffff',
        font: 'Inter',
        borderRadius: 12,
        gradientEnabled: true,
        gradientColors: colors,
        gradientAngle: 135,
      };
      
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settings));
      ipcRenderer.invoke('save-settings', settings).catch(console.error);
    }
  }

  getAvailableThemes() {
    return this.AVAILABLE_THEMES;
  }
}

const themeManager = new ThemeManager();

class PerformanceOptimizer {
  constructor() {
    this.optimized = false;
    this.initialize();
  }

  initialize() {
    // Lazy load images
    if ('IntersectionObserver' in window) {
      this.initLazyLoading();
    }

    // Optimize animations
    this.optimizeAnimations();

    // Debounce resize events
    this.optimizeResize();

    // Enable passive event listeners
    this.enablePassiveListeners();

    this.optimized = true;
  }

  initLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.classList.add('loaded');
            observer.unobserve(img);
          }
        }
      });
    });

    document.querySelectorAll('img[data-src]').forEach(img => imageObserver.observe(img));
  }

  optimizeAnimations() {
    // Use requestAnimationFrame for smooth animations
    let scrollTimeout;
    window.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      document.body.classList.add('scrolling');
      scrollTimeout = setTimeout(() => {
        document.body.classList.remove('scrolling');
      }, 150);
    }, { passive: true });
  }

  optimizeResize() {
    let resizeTimeout;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimeout);
      document.body.classList.add('resizing');
      resizeTimeout = setTimeout(() => {
        document.body.classList.remove('resizing');
      }, 150);
    }, { passive: true });
  }

  enablePassiveListeners() {
    // This is handled by modern browsers automatically for most events
    document.addEventListener('touchstart', () => {}, { passive: true });
    document.addEventListener('touchmove', () => {}, { passive: true });
    document.addEventListener('wheel', () => {}, { passive: true });
  }
}

const performanceOptimizer = new PerformanceOptimizer();

class LoginPanelManager {
  constructor() {
    this.container = null;
    this.players = [];
    this.selectedPlayerId = null;
    this.initialize();
  }

  initialize() {
    if (!document.getElementById('login-panel-container')) {
      const panel = document.createElement('div');
      panel.id = 'login-panel-container';
      panel.className = 'login-panel';
      
      if (document.getElementById('content')) {
        document.getElementById('content').appendChild(panel);
      }
    }
    
    this.container = document.getElementById('login-panel-container');
    this.loadPlayers();
  }

  loadPlayers() {
    ipcRenderer.send('get-players');
    ipcRenderer.on('players-list', (event, newPlayers) => {
      this.players = newPlayers;
      this.render();
    });
    ipcRenderer.on('players-updated', (event, newPlayers) => {
      this.players = newPlayers;
      this.render();
    });

    ipcRenderer.invoke('get-selected-player').then(id => {
      this.selectedPlayerId = id;
      this.render();
    });
  }

  render() {
    if (!this.container) return;

    this.container.innerHTML = '';

    // Current account section
    const accountsSection = document.createElement('div');
    accountsSection.className = 'login-section';

    const title = document.createElement('div');
    title.className = 'login-section-title';
    title.textContent = 'Current Account';
    accountsSection.appendChild(title);

    if (this.selectedPlayerId && this.players.length > 0) {
      const player = this.players.find(p => p.id === this.selectedPlayerId);
      if (player) {
        const card = this.createAccountCard(player);
        accountsSection.appendChild(card);
      }
    } else {
      const noAccount = document.createElement('div');
      noAccount.style.textAlign = 'center';
      noAccount.style.color = 'rgba(255, 255, 255, 0.5)';
      noAccount.style.fontSize = '12px';
      noAccount.style.padding = '16px';
      noAccount.textContent = 'No account selected';
      accountsSection.appendChild(noAccount);
    }

    this.container.appendChild(accountsSection);

    // Login button
    const loginBtn = document.createElement('button');
    loginBtn.className = 'login-button';
    loginBtn.innerHTML = '<i class="material-icons">person_add</i> Login';
    loginBtn.onclick = () => {
      ipcRenderer.send('open-login-window');
    };
    this.container.appendChild(loginBtn);

    // Other accounts section
    if (this.players.length > 1) {
      const othersSection = document.createElement('div');
      othersSection.className = 'login-section';

      const othersTitle = document.createElement('div');
      othersTitle.className = 'login-section-title';
      othersTitle.textContent = 'Other Accounts';
      othersSection.appendChild(othersTitle);

      this.players.forEach(player => {
        if (player.id !== this.selectedPlayerId) {
          const card = this.createAccountCard(player, true);
          othersSection.appendChild(card);
        }
      });

      this.container.appendChild(othersSection);
    }
  }

  createAccountCard(player, isOther = false) {
    const card = document.createElement('div');
    card.className = 'account-card';

    const username = player.type === 'microsoft' 
      ? (player.auth?.name ?? 'MS Account') 
      : (player.username ?? 'Cracked');

    const img = document.createElement('img');
    img.className = 'account-avatar';
    img.src = `https://minotar.net/helm/${encodeURIComponent(username)}/24`;
    img.onerror = () => { img.src = 'https://tggamesyt.dev/assets/stevehead.png'; };
    card.appendChild(img);

    const name = document.createElement('div');
    name.className = 'account-name';
    name.textContent = username;
    card.appendChild(name);

    const type = document.createElement('div');
    type.className = 'account-type';
    type.textContent = player.type === 'microsoft' ? 'Microsoft' : 'Offline';
    card.appendChild(type);

    const btn = document.createElement('button');
    btn.className = 'account-button';
    btn.textContent = isOther ? 'Use' : 'Change';
    btn.onclick = () => {
      ipcRenderer.send('set-selected-player', player.id);
    };
    card.appendChild(btn);

    return card;
  }
}

const loginPanelManager = new LoginPanelManager();

class ModalManager {
  constructor() {
    this.modals = {};
  }

  create(id, options = {}) {
    const overlay = document.createElement('div');
    overlay.id = `${id}-overlay`;
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal';

    if (options.title) {
      const title = document.createElement('h3');
      title.textContent = options.title;
      modal.appendChild(title);
    }

    if (options.content) {
      const content = document.createElement('div');
      content.innerHTML = options.content;
      modal.appendChild(content);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        this.hide(id);
      }
    });

    this.modals[id] = overlay;
    return { overlay, modal };
  }

  show(id) {
    if (this.modals[id]) {
      this.modals[id].classList.add('show');
    }
  }

  hide(id) {
    if (this.modals[id]) {
      this.modals[id].classList.remove('show');
    }
  }

  toggle(id) {
    if (this.modals[id]) {
      this.modals[id].classList.toggle('show');
    }
  }

  destroy(id) {
    if (this.modals[id]) {
      this.modals[id].remove();
      delete this.modals[id];
    }
  }
}

const modalManager = new ModalManager();

window.LoadingScreenManager = LoadingScreenManager;
window.ThemeManager = ThemeManager;
window.PerformanceOptimizer = PerformanceOptimizer;
window.LoginPanelManager = LoginPanelManager;
window.ModalManager = ModalManager;

window.loadingScreen = loadingScreen;
window.themeManager = themeManager;
window.performanceOptimizer = performanceOptimizer;
window.loginPanelManager = loginPanelManager;
window.modalManager = modalManager;
